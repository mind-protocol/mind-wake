import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createChatServer, ChatError } from './chat-server.mjs';
import { chatUrl, parseChatSnapshot, pairChat, readChat, sendChat } from '../src/chat/client.ts';

const id = 'chat-382582c4-90f8-4dfb-910d-6c976ad77247';
const code = 'pairing-code-123456789012';
async function setup(t, options = {}) {
  const messages = []; let sends = 0;
  const bridge = { snapshot: async () => messages, send: async (messageId, text) => {
    const prior = messages.find(m => m.id === messageId);
    if (prior && prior.text !== text) throw new ChatError('message_conflict', 409);
    if (!prior) { sends++; messages.push({ id: messageId, text, at: new Date().toISOString(), role: 'human', version: 1, status: 'queued' }); }
    return { status: prior ? 'duplicate' : 'recorded', at: messages.find(m => m.id === messageId).at };
  } };
  const service = createChatServer({ bridge, pairingCode: code, origins: ['http://localhost:8081'],
    pollIntervalMs: 15, maxWaitMs: 100, ...options });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${service.server.address().port}`;
  t.after(() => service.close());
  const request = (route, { token, origin, body, ...init } = {}) => fetch(url + route, { ...init,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { service, messages, url, request, sends: () => sends };
}
test('owner history requires bearer, rejects untrusted Origin and Host, never reflects wildcard CORS', async t => {
  const h = await setup(t);
  assert.equal((await h.request('/chat/messages')).status, 401);
  assert.equal((await h.request('/chat/pair', { method: 'POST', origin: 'https://attacker.invalid', body: { code } })).status, 403);
  const response = await h.request('/chat/pair', { method: 'OPTIONS', origin: 'http://localhost:8081' });
  assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:8081');
  const denied = await new Promise((resolve, reject) => {
    const req = httpRequest(h.url + '/chat/messages', { headers: { Host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
    req.once('error', reject); req.end();
  });
  assert.equal(denied, 403);
});
test('pairing is single-use and its expiry and attempt ceiling are enforced', async t => {
  const h = await setup(t);
  const session = await pairChat(h.url, code);
  assert.match(session.token, /^[a-f0-9]{64}$/);
  assert.equal((await h.request('/chat/pair', { method: 'POST', body: { code } })).status, 410);
  const limited = await setup(t);
  for (let i = 0; i < 5; i++) assert.equal((await limited.request('/chat/pair', { method: 'POST', body: { code: 'incorrect' } })).status, 401);
  assert.equal((await limited.request('/chat/pair', { method: 'POST', body: { code } })).status, 429);
  let time = Date.now(); const expired = await setup(t, { now: () => time, pairTtlMs: 20 }); time += 21;
  assert.equal((await expired.request('/chat/pair', { method: 'POST', body: { code } })).status, 410);
});
test('concurrent retries enqueue once and conflict or arbitrary owner/path fields are refused', async t => {
  const h = await setup(t); const session = await pairChat(h.url, code);
  const results = await Promise.all([sendChat(session, id, 'Bonjour'), sendChat(session, id, 'Bonjour')]);
  assert.equal(results.length, 2); assert.equal(h.sends(), 1);
  assert.deepEqual(results.map(result => result.duplicate), [false, true]);
  const conflict = await h.request('/chat/messages', { method: 'POST', token: session.token, body: { id, text: 'Autre' } });
  assert.equal(conflict.status, 409);
  const extra = await h.request('/chat/messages', { method: 'POST', token: session.token, body: { id, text: 'Bonjour', dataDir: 'other-owner' } });
  assert.equal(extra.status, 400);
  assert.equal((await h.request('/chat/messages?command=stop', { token: session.token })).status, 400);
});
test('long poll receives a real adapter publication and reconnection returns the current version', async t => {
  const h = await setup(t); const session = await pairChat(h.url, code);
  const first = await readChat(session); assert.deepEqual(first.messages, []);
  const pending = h.request(`/chat/messages?cursor=${first.cursor}&wait=100`, { token: session.token }).then(r => r.json());
  await new Promise(resolve => setTimeout(resolve, 25));
  h.messages.push({ id: 'own-fixture', text: 'Publication du faux adaptateur de test', at: new Date().toISOString(),
    role: 'agent', version: 1, status: 'published' });
  const next = await pending; assert.equal(next.messages[0].id, 'own-fixture'); assert.notEqual(first.cursor, next.cursor);
  h.messages[0].version = 2; h.messages[0].text = 'Version modifiée';
  const resumed = await readChat(session); assert.equal(resumed.messages[0].version, 2);
  h.messages.length = 0; assert.deepEqual((await readChat(session)).messages, []);
});
test('queue acknowledgement never claims reading, logout and expiry revoke access', async t => {
  let now = Date.now(); const h = await setup(t, { now: () => now, sessionTtlMs: 10_000 });
  const session = await pairChat(h.url, code);
  const receipt = await sendChat(session, id, 'Test'); assert.equal(receipt.status, 'queued');
  const snapshot = await readChat(session); assert.equal(snapshot.messages[0].status, 'queued');
  h.messages[0].status = 'delivered'; assert.equal((await readChat(session)).messages[0].status, 'delivered');
  assert.equal((await h.request('/chat/logout', { method: 'POST', token: session.token })).status, 200);
  assert.equal((await h.request('/chat/messages', { token: session.token })).status, 401);
  now = Date.now(); const expired = await setup(t, { now: () => now, sessionTtlMs: 10_000 });
  const second = await pairChat(expired.url, code); now += 10_001;
  assert.equal((await expired.request('/chat/messages', { token: second.token })).status, 401);
});
test('client rejects remote targets, embedded credentials and malformed/duplicate message projections', () => {
  for (const value of ['https://attacker.invalid', 'http://192.168.1.3@attacker.invalid', 'http://127.0.0.1/?token=secret', 'http://999.1.2.3', 'file:///x']) assert.throws(() => chatUrl(value));
  assert.equal(chatUrl('http://192.168.1.20:8789'), 'http://192.168.1.20:8789');
  const message = { id: 'own-one', role: 'agent', status: 'published', version: 1, at: new Date().toISOString(), text: 'Test' };
  const value = { schema: 'mind.chat.v1', cursor: 'a'.repeat(64), observedAt: new Date().toISOString(), messages: [message, message] };
  assert.throws(() => parseChatSnapshot(value));
  value.messages = [{ ...message, status: 'read' }]; assert.throws(() => parseChatSnapshot(value));
});
test('voice upload requires a session, enforces type and size, and only returns an editable draft', async t => {
  let transcriptions = 0;
  const h = await setup(t, { transcribe: async bytes => { transcriptions++; assert.equal(bytes.length, 16); return { text: 'À relire', durationSeconds: 1 }; } });
  assert.equal((await h.request('/chat/transcribe', { method: 'POST' })).status, 401);
  const session = await pairChat(h.url, code);
  const upload = (body, mime) => fetch(h.url + '/chat/transcribe', { method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': mime }, body });
  assert.equal((await upload('x', 'text/plain')).status, 415);
  assert.equal((await upload(new Uint8Array(4 * 1024 * 1024 + 1), 'audio/webm')).status, 413);
  const response = await upload(new Uint8Array(16), 'audio/webm'); const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.status, 'draft'); assert.equal(result.sentToWake, false);
  assert.equal(result.text, 'À relire'); assert.equal(transcriptions, 1); assert.equal(h.sends(), 0);
});
