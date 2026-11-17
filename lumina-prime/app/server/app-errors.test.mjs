import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatServer } from './chat-server.mjs';
import { pairChat } from '../src/chat/client.ts';
import { createAppErrorRelay, sendAppError } from '../src/chat/app-error-relay.ts';

const code = 'pairing-code-123456789012';
async function setup(t, appErrors) {
  const bridge = { snapshot: async () => [], send: async () => ({ status: 'recorded', at: new Date().toISOString() }) };
  const service = createChatServer({ bridge, pairingCode: code, appErrors });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const url = `http://127.0.0.1:${service.server.address().port}`;
  return { url, session: await pairChat(url, code) };
}

test('POST /chat/app-errors relays on the existing session, fixes app=mobile and refuses extra fields', async t => {
  const relayed = [];
  const { url, session } = await setup(t, input => { relayed.push(input); return { id: `fast-reply-fyi:app-error-${relayed.length}` }; });
  const post = (body, token = session.token) => fetch(url + '/chat/app-errors', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post({ screen: 'chat', text: 'x' }, '')).status, 401);
  assert.equal((await post({ screen: 'chat', text: 'x', token: session.token })).status, 400);
  assert.equal((await post({ screen: 'chat', text: '  ' })).status, 400);
  const ok = await post({ screen: 'ios · appel', text: 'Passerelle injoignable', at: '2026-11-17T14:50:00Z' });
  assert.equal(ok.status, 202);
  assert.deepEqual(await ok.json(), { schema: 'mind.chat.app-error.receipt.v1', id: 'fast-reply-fyi:app-error-1', status: 'relayed' });
  assert.deepEqual(relayed, [{ app: 'mobile', screen: 'ios · appel', text: 'Passerelle injoignable', at: '2026-11-17T14:50:00Z' }]);
  assert.equal(JSON.stringify(relayed).includes(session.token), false);
});

test('without a runtime relay the endpoint answers app_errors_unavailable', async t => {
  const { session, url } = await setup(t, null);
  const response = await fetch(url + '/chat/app-errors', { method: 'POST', headers: { 'Content-Type': 'application/json',
    Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ text: 'x' }) });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'app_errors_unavailable' });
});

test('client relay: every error is sent (no dedup), queued offline and flushed on reconnect', async t => {
  const relayed = [];
  const { session } = await setup(t, input => { relayed.push(input); return { id: `id-${relayed.length}` }; });
  const relay = createAppErrorRelay(sendAppError, () => Date.parse('2026-11-17T14:50:00Z'), null, 'android');
  relay.report('chat · connexion', 'Connexion perdue');
  relay.report('chat · connexion', 'Connexion perdue');
  assert.equal(relay.pending(), 2);
  relay.setSession(session);
  await relay.flush();
  for (let i = 0; i < 50 && relayed.length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(relay.pending(), 0);
  assert.deepEqual(relayed.map(r => [r.app, r.screen, r.text, r.at]), [
    ['mobile', 'android · chat · connexion', 'Connexion perdue', '2026-11-17T14:50:00.000Z'],
    ['mobile', 'android · chat · connexion', 'Connexion perdue', '2026-11-17T14:50:00.000Z'],
  ]);
});

test('client relay inside the desktop call iframe hands errors to the panel instead of the gateway', () => {
  const parent = []; const sent = [];
  const relay = createAppErrorRelay(async (_s, item) => { sent.push(item); }, () => 0, item => parent.push(item), 'web');
  relay.report('appel', 'Micro refusé');
  assert.equal(parent.length, 1); assert.equal(parent[0].screen, 'web · appel'); assert.equal(relay.pending(), 0);
});
