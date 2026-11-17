import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChatServer } from './chat-server.mjs';
import { createFileReader, looksSecret, resolveSharedFile } from './chat-files.mjs';

function workspace(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'chat-files-'));
  const root = path.join(base, 'workspace');
  mkdirSync(path.join(root, 'artifacts', 'secrets'), { recursive: true });
  writeFileSync(path.join(root, 'artifacts', 'CV.md'), '# CV\n\n**Bonjour**');
  writeFileSync(path.join(root, 'artifacts', 'doc.pdf'), '%PDF-1.4 test');
  writeFileSync(path.join(root, 'artifacts', 'notes.txt'), 'texte');
  writeFileSync(path.join(root, 'artifacts', 'secrets', 'x.md'), 'secret');
  writeFileSync(path.join(root, '.env.md'), 'secret');
  writeFileSync(path.join(base, 'outside.md'), 'dehors');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, root };
}
const code = async (promise) => { try { await promise; return 'ok'; } catch (error) { return error.code; } };

test('path guard: only .md/.pdf under the workspace, no traversal, no secrets', async t => {
  const { base, root } = workspace(t);
  const ok = await resolveSharedFile(root, path.join(root, 'artifacts', 'CV.md'));
  assert.equal(ok.name, 'CV.md'); assert.match(ok.mime, /^text\/markdown/);
  assert.equal((await resolveSharedFile(root, path.join(root, 'artifacts', 'doc.pdf'))).mime, 'application/pdf');
  assert.equal(await code(resolveSharedFile(root, path.join(root, 'artifacts', '..', '..', 'outside.md'))), 'file_forbidden');
  assert.equal(await code(resolveSharedFile(root, path.join(base, 'outside.md'))), 'file_forbidden');
  assert.equal(await code(resolveSharedFile(root, path.join(root, 'artifacts', 'secrets', 'x.md'))), 'file_forbidden');
  assert.equal(await code(resolveSharedFile(root, path.join(root, '.env.md'))), 'file_forbidden');
  assert.equal(await code(resolveSharedFile(root, path.join(root, 'artifacts', 'notes.txt'))), 'file_type_unsupported');
  assert.equal(await code(resolveSharedFile(root, 'artifacts/CV.md')), 'file_invalid');
  assert.equal(await code(resolveSharedFile(root, path.join(root, 'absent.md'))), 'file_not_found');
  assert.equal(await code(resolveSharedFile(root, path.join(root + '-evil', 'x.md'))), 'file_forbidden');
  // Un lien (jonction) sous la racine qui pointe dehors est refusé d'après son chemin réel.
  try { symlinkSync(base, path.join(root, 'lien'), 'junction'); } catch { return; }
  assert.equal(await code(resolveSharedFile(root, path.join(root, 'lien', 'outside.md'))), 'file_forbidden');
});

test('secret-looking names are refused', () => {
  for (const name of ['.env', '.env.local', 'id.key', 'keys.json', 'telegram-session.json', 'reddit.json', 'colony-auth.json', 'a/secrets/b.md'])
    assert.equal(looksSecret(name), true, name);
  for (const name of ['CV-BASE-VERIFIEE-TRAVAIL.md', 'README.md', 'rapport.pdf']) assert.equal(looksSecret(name), false, name);
});

test('GET /chat/file requires a session and serves the bytes with the right type', async t => {
  const { root } = workspace(t);
  const bridge = { snapshot: async () => [], send: async () => ({ status: 'recorded', at: new Date().toISOString() }) };
  const service = createChatServer({ bridge, pairingCode: 'pairing-code-123456789012', files: createFileReader({ root }),
    privateNetworkConnect: true });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const url = `http://127.0.0.1:${service.server.address().port}`;
  const route = file => `${url}/chat/file?path=${encodeURIComponent(file)}`;
  assert.equal((await fetch(route(path.join(root, 'artifacts', 'CV.md')))).status, 401);
  const session = await (await fetch(`${url}/chat/connect-local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const headers = { Authorization: `Bearer ${session.token}` };
  const md = await fetch(route(path.join(root, 'artifacts', 'CV.md')), { headers });
  assert.equal(md.status, 200); assert.match(md.headers.get('content-type'), /text\/markdown/);
  assert.equal(await md.text(), '# CV\n\n**Bonjour**');
  const pdf = await fetch(route(path.join(root, 'artifacts', 'doc.pdf')), { headers });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const outside = await fetch(route(path.join(root, '..', 'outside.md')), { headers });
  assert.equal(outside.status, 403); assert.deepEqual(await outside.json(), { error: 'file_forbidden' });
  assert.equal((await fetch(`${url}/chat/file?path=x&other=1`, { headers })).status, 400);
});
