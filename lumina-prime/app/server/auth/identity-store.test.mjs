import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createIdentityStore } from './identity-store.mjs';
import { createAuthServer } from './server.mjs';

const NOW = Date.parse('2026-11-04T17:20:00Z');
const identity = (provider, sub, handle = 'same-handle') => ({ provider, providerUserId: sub, handle, displayName: 'Fixture', verifiedAt: new Date(NOW).toISOString() });

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mind-identity-test-'));
  const filename = path.join(dir, 'auth.sqlite');
  const opened = [];
  let time = NOW;
  t.after(() => {
    for (const store of opened.reverse()) { try { store.close(); } catch {} }
    const resolved = path.resolve(dir);
    assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep + 'mind-identity-test-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  return { filename, setTime(value) { time = value; }, open() { const store = createIdentityStore({ filename, now: () => time }); opened.push(store); return store; } };
}

test('accounts and sessions survive restart; provider subjects, not handles, define identity', t => {
  const f = fixture(t); const first = f.open();
  const a = first.issue(identity('x', 'x-1'));
  const b = first.issue(identity('telegram', 'tg-1'));
  assert.notEqual(a.mindUserId, b.mindUserId);
  const renamed = first.issue(identity('x', 'x-1', 'new-handle'));
  assert.equal(renamed.mindUserId, a.mindUserId);
  first.close();
  const reopened = f.open();
  assert.equal(reopened.lookup(a.sessionToken).mindUserId, a.mindUserId);
  assert.equal(reopened.lookup(a.sessionToken).identity.handle, 'new-handle');
  assert.equal(reopened.lookup(b.sessionToken).mindUserId, b.mindUserId);
  const bytes = readFileSync(f.filename);
  assert.equal(bytes.includes(Buffer.from(a.sessionToken)), false);
});

test('a proven second identity links atomically and rotates only the caller session', t => {
  const f = fixture(t); const store = f.open();
  const a = store.issue(identity('x', 'x-1'));
  const independentSession = store.issue(identity('x', 'x-1'));
  const other = store.issue(identity('x', 'x-2'));
  const pending = store.startLink(a.sessionToken, 'telegram');
  const linked = store.link(a.sessionToken, pending.linkChallenge, identity('telegram', 'tg-1'));
  assert.equal(linked.mindUserId, a.mindUserId);
  assert.deepEqual(linked.identities.map(item => item.provider), ['telegram', 'x']);
  assert.equal(store.lookup(a.sessionToken), null);
  assert.ok(store.lookup(independentSession.sessionToken));
  assert.ok(store.lookup(other.sessionToken));
  const loginByTelegram = store.issue(identity('telegram', 'tg-1'));
  assert.equal(loginByTelegram.mindUserId, a.mindUserId);
  assert.throws(() => store.link(linked.sessionToken, pending.linkChallenge, identity('telegram', 'tg-1')), error => error.code === 'expired_link');
});

test('link challenges bind the exact session, account and provider; expired links fail', t => {
  const f = fixture(t); const store = f.open();
  const a = store.issue(identity('x', 'x-1'));
  const sameAccount = store.issue(identity('x', 'x-1'));
  const other = store.issue(identity('x', 'x-2'));
  const pending = store.startLink(a.sessionToken, 'telegram');
  for (const token of [sameAccount.sessionToken, other.sessionToken]) assert.throws(() => store.link(token, pending.linkChallenge, identity('telegram', 'tg-1')), error => error.code === 'invalid_link');
  assert.throws(() => store.link(a.sessionToken, pending.linkChallenge, identity('whatsapp', '+33123456789')), error => error.code === 'invalid_link');
  f.setTime(NOW + 5 * 60_000);
  assert.throws(() => store.link(a.sessionToken, pending.linkChallenge, identity('telegram', 'tg-1')), error => error.code === 'expired_link');
});

test('an identity owned by another account is never transferred or merged', t => {
  const f = fixture(t); const store = f.open();
  const a = store.issue(identity('x', 'x-1'));
  const b = store.issue(identity('telegram', 'tg-1'));
  const pending = store.startLink(a.sessionToken, 'telegram');
  assert.throws(() => store.link(a.sessionToken, pending.linkChallenge, identity('telegram', 'tg-1')), error => error.code === 'identity_already_linked');
  assert.equal(store.lookup(a.sessionToken).identities.length, 1);
  assert.equal(store.lookup(b.sessionToken).mindUserId, b.mindUserId);
  assert.equal(store.lookup(b.sessionToken).identities.length, 1);
});

test('logout and expiry remain effective after reopening and do not revoke another account', t => {
  const f = fixture(t); const store = f.open();
  const a = store.issue(identity('x', 'x-1'));
  const b = store.issue(identity('telegram', 'tg-1'));
  assert.equal(store.revoke(a.sessionToken), true);
  assert.equal(store.revoke(a.sessionToken), false);
  store.close();
  const reopened = f.open();
  assert.equal(reopened.lookup(a.sessionToken), null);
  assert.ok(reopened.lookup(b.sessionToken));
  f.setTime(Date.parse(b.expiresAt));
  assert.equal(reopened.lookup(b.sessionToken), null);
  assert.throws(() => reopened.startLink(b.sessionToken, 'x'), error => error.code === 'unauthorized');
});

test('two connections preserve uniqueness and a challenge survives process restart', t => {
  const f = fixture(t); const a = f.open(); const b = f.open();
  const one = a.issue(identity('x', 'x-1'));
  assert.equal(b.issue(identity('x', 'x-1')).mindUserId, one.mindUserId);
  const pending = a.startLink(one.sessionToken, 'telegram');
  a.close();
  const linked = b.link(one.sessionToken, pending.linkChallenge, identity('telegram', 'tg-1'));
  assert.equal(linked.mindUserId, one.mindUserId);
  assert.equal(linked.identities.length, 2);
});

test('HTTP verifies X and WhatsApp before linking the same durable account; revoked session stays revoked', { timeout: 5000 }, async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mind-identity-test-'));
  const f = { filename: path.join(dir, 'auth.sqlite') };
  const servers = [];
  t.after(async () => {
    for (const server of servers) if (server.listening) await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(dir);
    assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep + 'mind-identity-test-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  let deliveredCode;
  const env = { AUTH_DB_PATH: f.filename, X_CLIENT_ID: 'fixture', X_REDIRECT_URIS: 'mindlumina://login', WHATSAPP_ACCESS_TOKEN: 'fixture-not-a-token', WHATSAPP_PHONE_NUMBER_ID: 'fixture', WHATSAPP_TEMPLATE_NAME: 'fixture' };
  const providerFetch = async (url, init) => {
    if (url === 'https://api.x.com/2/oauth2/token') return { ok: true, json: async () => ({ access_token: 'fixture-access' }) };
    if (url === 'https://api.x.com/2/users/me') return { ok: true, json: async () => ({ data: { id: 'x-1', username: 'alice', name: 'Fixture' } }) };
    if (url === 'https://graph.facebook.com/v26.0/fixture/messages') {
      deliveredCode = JSON.parse(init.body).template.components[0].parameters[0].text;
      return { ok: true };
    }
    throw Error(`Unexpected provider request ${url}`);
  };
  const open = async () => {
    const server = createAuthServer({ env, fetch: providerFetch, now: () => NOW });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  };
  const { server, base } = await open();
  const post = (route, body, token) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const x = await (await post('/auth/x/exchange', { code: 'fixture-code', codeVerifier: 'a'.repeat(43), redirectUri: 'mindlumina://login' })).json();
  assert.match(x.mindUserId, /^[a-f0-9-]{36}$/i);
  assert.equal((await post('/auth/link/start', { provider: 'whatsapp' })).status, 401);
  const link = await (await post('/auth/link/start', { provider: 'whatsapp' }, x.sessionToken)).json();
  const challenge = await (await post('/auth/whatsapp/start', { phone: '+15555550123' })).json();
  const bad = await post('/auth/whatsapp/verify', { challengeId: challenge.challengeId, code: 'bad', linkChallenge: link.linkChallenge }, x.sessionToken);
  assert.equal(bad.status, 400);
  const linkedResponse = await post('/auth/whatsapp/verify', { challengeId: challenge.challengeId, code: deliveredCode, linkChallenge: link.linkChallenge }, x.sessionToken);
  assert.equal(linkedResponse.status, 200);
  const linked = await linkedResponse.json();
  assert.equal(linked.mindUserId, x.mindUserId);
  assert.equal(linked.identities.length, 2);
  assert.equal((await fetch(`${base}/auth/session`, { headers: { Authorization: `Bearer ${x.sessionToken}` } })).status, 401);
  await new Promise(resolve => server.close(resolve));
  const reopened = await open();
  const restored = await fetch(`${reopened.base}/auth/session`, { headers: { Authorization: `Bearer ${linked.sessionToken}` } });
  assert.equal(restored.status, 200);
  const value = await restored.json();
  assert.equal(value.mindUserId, x.mindUserId);
  assert.equal(value.identities.length, 2);
  const replay = await fetch(`${reopened.base}/auth/link/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${x.sessionToken}` }, body: JSON.stringify({ provider: 'telegram' }) });
  assert.equal(replay.status, 401);
});
