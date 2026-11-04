import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ChatError } from './chat-server.mjs';

/** Fixed operator configuration only; no HTTP request may supply these paths or select an agent. */
export async function createWakeChatBridge({ wakeRoot, dataDir }) {
  wakeRoot = fs.realpathSync(wakeRoot); dataDir = fs.realpathSync(dataDir);
  const require = createRequire(path.join(wakeRoot, 'package.json'));
  const Database = require('better-sqlite3');
  const { openStoreReadOnly } = await import(pathToFileURL(path.join(wakeRoot, 'dist/store/index.js')).href);
  const { resolvePolicy } = await import(pathToFileURL(path.join(wakeRoot, 'dist/policy/index.js')).href);
  const control = openStoreReadOnly(path.join(dataDir, 'control.sqlite'));
  let agentId;
  try {
    const policy = resolvePolicy(control.uow.policies, 'default');
    if (policy.status !== 'active') throw new Error('Active owner policy required');
    agentId = policy.revision.groups.identity.agentId;
  } finally { control.close(); }
  const ownerFile = path.join(dataDir, 'owner-messages.sqlite');
  const inboxFile = path.join(dataDir, 'owner-inbox.sqlite');
  const cli = path.join(wakeRoot, 'dist/cli/main.js');
  for (const file of [ownerFile, inboxFile, cli]) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Ordinary owner files required');
  }
  function read(file, operation) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try { db.pragma('busy_timeout=1000'); return operation(db); } finally { db.close(); }
  }
  let fingerprint = ''; let cached = [];
  const currentFingerprint = () => [ownerFile, inboxFile].flatMap(file => [file, file + '-wal'].map(p => {
    try { const s = fs.statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; }
  })).join('|');
  let lastPolicyCheck = 0;
  function assertOwnerPolicy() {
    if (Date.now() - lastPolicyCheck < 1000) return;
    const store = openStoreReadOnly(path.join(dataDir, 'control.sqlite'));
    try {
      const current = resolvePolicy(store.uow.policies, 'default');
      if (current.status !== 'active' || current.revision.groups.identity.agentId !== agentId)
        throw new ChatError('wake_unavailable', 503);
      lastPolicyCheck = Date.now();
    } finally { store.close(); }
  }
  return {
    agentId,
    async snapshot() {
      assertOwnerPolicy();
      const next = currentFingerprint();
      if (next === fingerprint) return cached;
      const owner = read(ownerFile, db => db.prepare('SELECT id,text,created_at AS at,version FROM messages WHERE agent_id=? AND deleted=0 AND id<>\'legacy-note\' ORDER BY created_at DESC,rowid DESC LIMIT 60').all(agentId))
        .map(message => ({ ...message, role: 'agent', status: 'published' }));
      const incoming = read(inboxFile, db => db.prepare("SELECT id,text,at,emitted_at FROM inbox WHERE id LIKE 'chat-%' AND origin_json IS NULL ORDER BY rowid DESC LIMIT 60").all())
        .map(({ emitted_at, ...message }) => ({ ...message, role: 'human', version: 1, status: emitted_at ? 'delivered' : 'queued' }));
      cached = [...owner, ...incoming].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).slice(-100);
      fingerprint = next; return cached;
    },
    async send(id, text) {
      assertOwnerPolicy();
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, 'reply', '--data-dir', dataDir, '--idempotency-key', id, '--json'],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
        let stdout = ''; let stderrBytes = 0;
        const timer = setTimeout(() => { child.kill(); reject(new ChatError('wake_timeout', 504)); }, 15_000);
        child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 64_000) child.kill(); });
        child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
        child.once('error', () => { clearTimeout(timer); reject(new ChatError('wake_unavailable', 503)); });
        child.once('close', code => {
          clearTimeout(timer);
          let data; try {
            const envelope = JSON.parse(stdout);
            if (envelope.schema !== 'mind-wake.cli' || envelope.command !== 'reply') throw new Error('Unexpected CLI response');
            data = envelope.data;
          } catch { reject(new ChatError('wake_unavailable', 503)); return; }
          if (code !== 0 || !['recorded', 'duplicate'].includes(data.status)) {
            reject(new ChatError(data.status === 'refused' && /clé déjà utilisée/.test(data.detail ?? '') ? 'message_conflict' : 'wake_unavailable', data.status === 'refused' ? 409 : 503)); return;
          }
          resolve({ status: data.status, at: data.reply?.at, stderrBytes });
        });
        child.stdin.end(text);
      });
      fingerprint = ''; return result;
    },
  };
}
