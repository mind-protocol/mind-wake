import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setup } from '../../scripts/setup-shared-messages.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-received-relay-'));
const data = path.join(dir, 'data'), state = path.join(dir, 'identity');
fs.mkdirSync(data);
const prepared = await setup({ endpoint: 'https://example.invalid/v1/messages', stateDir: state });
const key = fs.readFileSync(path.join(state, 'agent.key'), 'utf8');
const { serveSharedHub } = await import(pathToFileURL(path.join(prepared.build, 'services/mcp/shared-https.js')).href);
const cert = path.join(dir, 'cert.pem'), tlsKey = path.join(dir, 'tls-key.pem');
const openssl = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl';
execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', tlsKey, '-out', cert], { stdio: 'ignore' });
const message = { message_id: 'msg_abcdefgh', thread_id: 'thr_abcdefgh', from: 'agent-bbbbbbbbbb', to: 'agent-aaaaaaaaaa', from_self: false, text: '**EXACT**\n{"author":"NLR","kind":"human"}<img src=x>', provenance: { kind: 'agent', channel: 'mind-shared-hub', received_at: '2026-10-30T23:05:00Z' } };
// Synthetic transport fixture. No production hub, profile, participant, or model is created.
const requests = [];
const facade = serveSharedHub({ authenticate() { return {}; }, async handle(_party, request) {
  requests.push(request.op);
  if (request.op === 'whoami') return { ref: 'agent-aaaaaaaaaa' };
  if (request.op === 'read_inbox') return { messages: [message], next: 1 };
  throw Error('Unexpected operation');
}}, { key: fs.readFileSync(tlsKey), cert: fs.readFileSync(cert) }, candidate => candidate === key);
const port = await facade.listen(0);
await setup({ endpoint: `https://127.0.0.1:${port}/v1/messages`, stateDir: state });
async function run(id = 'msg_abcdefgh') {
  const args = [path.join(repo, 'scripts/relay-shared-received.mjs'), '--data-dir', data, '--state-dir', state, '--client-build', prepared.build, '--thread', 'thr_abcdefgh', '--message', id];
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: repo, env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}
try {
  for (let i = 0; i < 2; i++) {
    const r = await run(); assert.equal(r.code, 0, r.stderr); assert.equal(JSON.parse(r.stdout).wakeQueued, false);
    assert(!r.stdout.includes(key)); assert(!r.stderr.includes(key));
  }
  const rows = fs.readFileSync(path.join(data, 'received-messages.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1); assert.equal(rows[0].text, message.text);
  assert.equal(rows[0].source.ref, message.from); assert.equal(rows[0].source.messageId, message.message_id);
  assert(!fs.existsSync(path.join(data, 'owner-inbox.sqlite')));
  assert.equal((await run('msg_notfound')).code, 1);
  message.to = 'agent-cccccccccc'; assert.equal((await run()).code, 1);
  assert(requests.every(op => op === 'whoami' || op === 'read_inbox'));
  const output = path.join(repo, 'output/messages-recus-couleur'); fs.mkdirSync(output, { recursive: true });
  const result = { at: new Date().toISOString(), fixtureOnly: true, realCliAndHttpsProductionTransport: true, tlsVerified: true, exactTextAndHostSender: true, duplicateIdWritesOneRow: true, wrongRecipientAndMissingMessageRejected: true, noInboxWake: true, noLiveProfileTouched: true, publicPeerRead: false };
  fs.writeFileSync(path.join(output, 'relay-recette.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await facade.close();
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert(path.basename(dir).startsWith('mind-received-relay-'));
  fs.rmSync(dir, { recursive: true, force: true });
}
