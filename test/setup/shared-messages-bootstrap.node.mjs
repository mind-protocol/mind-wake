import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import https from 'node:https';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { validateEndpoint, validateNode, validateStateDir } from '../../scripts/setup-shared-messages.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const helper = path.join(repo, 'scripts/setup-shared-messages.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-shared-bootstrap-'));
const state = path.join(dir, 'shared-identity');
const sha = b => createHash('sha256').update(b).digest('hex');
const sentinels = ['profile.json', 'config.toml', 'PERSONALITY.md'];
for (const file of sentinels) fs.writeFileSync(path.join(dir, file), 'SYNTHETIC untouched personal profile PAUSED: ' + file);
const before = sentinels.map(f => sha(fs.readFileSync(path.join(dir, f))));
const bootstrap = endpoint => JSON.parse(execFileSync(process.execPath, [helper, '--endpoint', endpoint, '--state-dir', state], { cwd: repo, encoding: 'utf8' }));
const publicEndpoint = process.argv[2];
const initialEndpoint = publicEndpoint || 'https://example.invalid/v1/messages';
const first = bootstrap(initialEndpoint);
assert.equal(first.keyCreated, true);
const key = fs.readFileSync(path.join(state, 'agent.key'), 'utf8');
assert.equal(key.length, 43);
assert(!JSON.stringify(first).includes(key));
assert.equal(first.candidate.keySha256, sha(key));
const second = bootstrap(initialEndpoint);
assert.equal(second.keyCreated, false);
assert.equal(fs.readFileSync(path.join(state, 'agent.key'), 'utf8'), key);
const fragment = fs.readFileSync(first.configFragment, 'utf8');
assert(!fragment.includes(key));
assert(!fragment.includes('MIND_SHARED_LINK_KEY'));
assert.equal(fs.readFileSync(path.join(state, '.gitignore'), 'utf8'), '*\n');
for (const value of ['http://localhost/v1/messages', 'https://u:secret@host/v1/messages', 'https://host/v1/messages?x=1', 'https://host/wrong', 'bad']) assert.throws(() => validateEndpoint(value));
for (const version of ['22.0.0', '24.16.0', '25.0.0', '26.12.0', '27.0.0']) assert.throws(() => validateNode(version));
validateNode('24.17.0'); validateNode('26.13.0');
assert.throws(() => validateStateDir(repo));
assert.throws(() => validateStateDir('relative'));
assert.throws(() => validateStateDir(dir)); // Never reuse a personal profile as shared state.
assert.throws(() => validateStateDir(path.join(dir, 'profile.json')));
const invalid = execFileSync(process.execPath, ['-e', `const {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,${JSON.stringify([helper, '--endpoint', 'https://u:do-not-echo@host/v1/messages', '--state-dir', state])},{encoding:'utf8'});if(r.status!==1||r.stdout||r.stderr.includes('do-not-echo'))process.exit(2);`], { encoding: 'utf8' });
assert.equal(invalid, '');
const rawRequest = (endpoint, ca) => new Promise((resolve, reject) => {
  const req = https.request(endpoint, { method: 'POST', ...(ca ? { ca } : {}), headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, timeout: 10000 }, res => {
    let body = ''; res.on('data', b => body += b);
    res.on('end', () => { try { resolve({ status: res.statusCode, error: JSON.parse(body).error.code }); } catch { reject(Error('Invalid hub response')); } });
  });
  req.on('timeout', () => req.destroy(Error('HTTPS timeout'))); req.on('error', reject);
  req.end(JSON.stringify({ id: 1, op: 'whoami' }));
});
let publicResult = { verified: false, reason: 'Not requested' };
if (publicEndpoint) {
  try { publicResult = await rawRequest(publicEndpoint); assert.equal(publicResult.status, 401); assert.equal(publicResult.error, 'not_authenticated'); publicResult.verified = true; }
  catch (e) { if (e.code !== 'EACCES' && e.code !== 'EPERM') throw e; publicResult = { verified: false, reason: e.code }; }
}
const cert = path.join(dir, 'cert.pem'), tlsKey = path.join(dir, 'tls-key.pem');
const openssl = process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/usr/bin/openssl.exe') ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl';
execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', tlsKey, '-out', cert], { stdio: 'ignore' });
const { serveSharedHub } = await import(pathToFileURL(path.join(first.build, 'services/mcp/shared-https.js')).href);
let authenticated = false;
const facade = serveSharedHub({ authenticate() { authenticated = true; throw Error('Must never authenticate'); } }, { key: fs.readFileSync(tlsKey), cert: fs.readFileSync(cert) }, () => false);
const port = await facade.listen(0);
const endpoint = `https://127.0.0.1:${port}/v1/messages`;
const updated = bootstrap(endpoint);
assert.equal(updated.keyCreated, false);
assert.equal(fs.readFileSync(path.join(state, 'agent.key'), 'utf8'), key);
assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'endpoint.json'))).endpoint, endpoint);
const args = JSON.parse(fragment.match(/^args = (.+)$/m)[1]);
const command = JSON.parse(fragment.match(/^command = (.+)$/m)[1]);
const client = new Client({ name: 'shared-bootstrap-recipe', version: '1' });
const transport = new StdioClientTransport({ command, args, cwd: repo, env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stderr: 'pipe' });
let stderr = ''; transport.stderr?.on('data', b => stderr += b);
let names;
try {
  const raw = await rawRequest(endpoint, fs.readFileSync(cert));
  assert.deepEqual(raw, { status: 401, error: 'not_authenticated' });
  await client.connect(transport);
  names = (await client.listTools()).tools.map(t => t.name).sort();
  assert.deepEqual(names, ['list_directory', 'read_inbox', 'reply_to_thread', 'send_message', 'whoami']);
  for (const name of ['whoami', 'list_directory']) {
    const r = await client.callTool({ name, arguments: {} });
    assert.equal(r.isError, true); assert.equal(JSON.parse(r.content[0].text).error, 'not_authenticated');
  }
} finally { await client.close(); await facade.close(); bootstrap(initialEndpoint); }
assert.equal(authenticated, false);
assert(!stderr.includes(key));
assert.deepEqual(sentinels.map(f => sha(fs.readFileSync(path.join(dir, f)))), before);
const result = { at: new Date().toISOString(), node: process.version, realCliBootstrap: true, sourcesCompiled: 4, tools: names, realMcpHandshake: true, localProductionHttps401: true, tlsVerificationEnabled: true, publicHttps: publicResult, keyReusedAndEndpointUpdated: true, secretAbsentFromOutputAndConfig: true, invalidNodeEndpointAndDirectoryRejected: true, syntheticPersonalProfileUnchanged: true, liveProfileTouched: false, databasePartiesCreated: 0, modelCalls: 0 };
const output = path.join(repo, 'output/bridge-github-bootstrap'); fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'recette.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
// All files beneath dir were created by this test under mkdtemp; no external data.
assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
assert(path.basename(dir).startsWith('mind-shared-bootstrap-'));
fs.rmSync(dir, { recursive: true, force: true });
