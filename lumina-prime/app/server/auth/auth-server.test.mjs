// node --test server/auth/auth-server.test.mjs — aucun appel réseau réel : fetch est simulé.
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import {
  AuthError, buildWhatsAppOtpRequest, createWhatsAppChallenges, exchangeTelegramCode, exchangeXCode,
  verifyJwt, verifyMetaSignature, verifyTelegramWidget, TELEGRAM_ISSUER,
} from './core.mjs';
import { createAuthServer } from './server.mjs';

const NOW = Date.parse('2026-11-04T15:00:00Z');
const VERIFIER = 'a'.repeat(43);
const BOT_TOKEN = '123456:TEST-not-a-real-token';

function widgetPayload(fields, token = BOT_TOKEN) {
  const check = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const hash = createHmac('sha256', createHash('sha256').update(token).digest()).update(check).digest('hex');
  return { ...fields, hash };
}

test('Telegram Login Widget : HMAC valide, altéré, mauvais bot, périmé', () => {
  const fields = { id: '42', first_name: 'Alice', username: 'alice', auth_date: String(NOW / 1000 - 30) };
  const ok = verifyTelegramWidget(widgetPayload(fields), BOT_TOKEN, { now: NOW });
  assert.deepEqual(ok, { ok: true, user: { id: '42', username: 'alice', name: 'Alice' } });
  assert.equal(verifyTelegramWidget({ ...widgetPayload(fields), username: 'mallory' }, BOT_TOKEN, { now: NOW }).reason, 'bad_hash');
  assert.equal(verifyTelegramWidget(widgetPayload(fields, '999:autre'), BOT_TOKEN, { now: NOW }).reason, 'bad_hash');
  assert.equal(verifyTelegramWidget(widgetPayload({ ...fields, auth_date: String(NOW / 1000 - 90000) }), BOT_TOKEN, { now: NOW }).reason, 'expired');
  assert.equal(verifyTelegramWidget({ ...fields }, BOT_TOKEN, { now: NOW }).reason, 'missing_hash');
});

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const JWKS = { keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rs', alg: 'RS256' }, { ...ec.publicKey.export({ format: 'jwk' }), kid: 'es', alg: 'ES256' }] };

function jwt(payload, { alg = 'RS256', kid = 'rs', key = rsa.privateKey } = {}) {
  const enc = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const data = `${enc({ alg, kid, typ: 'JWT' })}.${enc(payload)}`;
  const sig = alg === 'ES256' ? sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }) : sign('sha256', Buffer.from(data), key);
  return `${data}.${sig.toString('base64url')}`;
}

const claims = { iss: TELEGRAM_ISSUER, aud: '7000000001', sub: '42', id: 42, name: 'Alice', preferred_username: 'alice', iat: NOW / 1000, exp: NOW / 1000 + 300 };

test('id_token Telegram : RS256 et ES256 acceptés ; iss, aud, exp, signature, alg contrôlés', () => {
  const expect = { issuer: TELEGRAM_ISSUER, audience: '7000000001', now: NOW };
  assert.equal(verifyJwt(jwt(claims), JWKS, expect).preferred_username, 'alice');
  assert.equal(verifyJwt(jwt(claims, { alg: 'ES256', kid: 'es', key: ec.privateKey }), JWKS, expect).sub, '42');
  const reject = (token, re) => assert.throws(() => verifyJwt(token, JWKS, expect), e => e instanceof AuthError && re.test(e.message));
  reject(jwt({ ...claims, aud: '1' }), /aud/);
  reject(jwt({ ...claims, iss: 'https://evil.example' }), /iss/);
  reject(jwt({ ...claims, exp: NOW / 1000 - 3600 }), /expiré/);
  const [h, p] = jwt(claims).split('.');
  const forged = Buffer.from(JSON.stringify({ ...claims, preferred_username: 'mallory' })).toString('base64url');
  reject(`${h}.${forged}.${jwt(claims).split('.')[2]}`, /signature/);
  reject(`${Buffer.from(JSON.stringify({ alg: 'none', kid: 'rs' })).toString('base64url')}.${p}.`, /algorithme/);
  reject('pas.un-jwt', /mal formé/);
});

function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    const handler = routes[url];
    if (!handler) throw new Error(`appel inattendu ${url}`);
    const [status, body] = handler(init);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

test('X : échange PKCE (client public puis confidentiel) et lecture /2/users/me', async () => {
  const calls = [];
  const fetch = fakeFetch({
    'https://api.x.com/2/oauth2/token': () => [200, { access_token: 'AT', token_type: 'bearer' }],
    'https://api.x.com/2/users/me': init => [init.headers.Authorization === 'Bearer AT' ? 200 : 401, { data: { id: '2244994945', username: 'alice', name: 'Alice' } }],
  }, calls);
  const identity = await exchangeXCode({ code: 'CODE', codeVerifier: VERIFIER, redirectUri: 'mindlumina://login' }, { clientId: 'cid', fetch, now: () => NOW });
  assert.deepEqual(identity, { provider: 'x', providerUserId: '2244994945', handle: 'alice', displayName: 'Alice', verifiedAt: new Date(NOW).toISOString() });
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code_verifier'), VERIFIER);
  assert.equal(body.get('client_id'), 'cid');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  await exchangeXCode({ code: 'CODE', codeVerifier: VERIFIER, redirectUri: 'mindlumina://login' }, { clientId: 'cid', clientSecret: 's3cret', fetch, now: () => NOW });
  assert.equal(calls[2].init.headers.Authorization, `Basic ${Buffer.from('cid:s3cret').toString('base64')}`);
  const refused = fakeFetch({ 'https://api.x.com/2/oauth2/token': () => [400, { error: 'invalid_request' }] });
  await assert.rejects(exchangeXCode({ code: 'OLD', codeVerifier: VERIFIER, redirectUri: 'r' }, { clientId: 'cid', fetch: refused, now: () => NOW }), e => e.code === 'invalid_grant');
  await assert.rejects(exchangeXCode({ code: 'C', codeVerifier: 'court', redirectUri: 'r' }, { clientId: 'cid', fetch, now: () => NOW }), e => e.code === 'invalid_request');
});

test('Telegram OIDC : échange avec Basic + PKCE, id_token vérifié', async () => {
  const calls = [];
  const fetch = fakeFetch({ 'https://oauth.telegram.org/token': () => [200, { id_token: jwt(claims), access_token: 'x' }] }, calls);
  const identity = await exchangeTelegramCode({ code: 'C', codeVerifier: VERIFIER, redirectUri: 'https://auth.example/auth/telegram/callback' },
    { clientId: '7000000001', clientSecret: 'tg-secret', fetch, now: () => NOW, getJwks: async () => JWKS });
  assert.equal(identity.handle, 'alice');
  assert.equal(identity.providerUserId, '42');
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('7000000001:tg-secret').toString('base64')}`);
  assert.equal(new URLSearchParams(calls[0].init.body).get('code_verifier'), VERIFIER);
  const wrongAud = fakeFetch({ 'https://oauth.telegram.org/token': () => [200, { id_token: jwt({ ...claims, aud: '1' }) }] });
  await assert.rejects(exchangeTelegramCode({ code: 'C', codeVerifier: VERIFIER, redirectUri: 'r' }, { clientId: '7000000001', clientSecret: 's', fetch: wrongAud, now: () => NOW, getJwks: async () => JWKS }), e => e.code === 'invalid_token');
});

test('WhatsApp OTP : usage unique, tentatives limitées, expiration, anti-renvoi', () => {
  let t = NOW;
  const store = createWhatsAppChallenges({ now: () => t, maxAttempts: 3 });
  const a = store.start('+33612345678', 'otp');
  assert.match(a.code, /^\d{6}$/);
  assert.throws(() => store.start('+33612345678', 'otp'), e => e.code === 'rate_limited');
  const wrong = a.code === '000000' ? '111111' : '000000';
  assert.throws(() => store.verifyOtp(a.challengeId, wrong), e => e.code === 'invalid_code');
  assert.equal(store.verifyOtp(a.challengeId, a.code), '+33612345678');
  assert.throws(() => store.verifyOtp(a.challengeId, a.code), e => e.code === 'invalid_request');
  t += 61_000;
  const b = store.start('+33612345678', 'otp');
  for (let i = 0; i < 3; i++) assert.throws(() => store.verifyOtp(b.challengeId, wrong));
  assert.throws(() => store.verifyOtp(b.challengeId, b.code), e => e.code === 'invalid_request');
  t += 61_000;
  const c = store.start('+33612345678', 'otp');
  t += 11 * 60_000;
  assert.throws(() => store.verifyOtp(c.challengeId, c.code), e => e.code === 'expired');
});

test('WhatsApp wa.me : message entrant du bon numéro requis', () => {
  const store = createWhatsAppChallenges({ now: () => NOW });
  const { challengeId, code } = store.start('+33612345678', 'wa_link');
  assert.match(code, /^[A-Z2-9]{6}$/);
  assert.throws(() => store.verifyInbound(challengeId), e => e.code === 'pending');
  assert.equal(store.recordInbound('33699999999', `MIND ${code}`), false);
  assert.equal(store.recordInbound('33612345678', `bonjour MIND ${code.toLowerCase()}`), true);
  assert.equal(store.verifyInbound(challengeId), '+33612345678');
});

test('WhatsApp : requête Cloud API du template copy-code et signature webhook', () => {
  const { url, init } = buildWhatsAppOtpRequest({ phone: '+33612345678', code: '123456', phoneNumberId: 'PNID', accessToken: 'TOKEN', templateName: 'mind_otp' });
  assert.equal(url, 'https://graph.facebook.com/v26.0/PNID/messages');
  const body = JSON.parse(init.body);
  assert.equal(body.to, '33612345678');
  assert.equal(body.template.components[0].parameters[0].text, '123456');
  assert.deepEqual(body.template.components[1], { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '123456' }] });
  const raw = Buffer.from('{"entry":[]}');
  const sig = `sha256=${createHmac('sha256', 'appsecret').update(raw).digest('hex')}`;
  assert.equal(verifyMetaSignature(raw, sig, 'appsecret'), true);
  assert.equal(verifyMetaSignature(raw, sig, 'autre'), false);
  assert.equal(verifyMetaSignature(raw, undefined, 'appsecret'), false);
});

async function withServer(options, run) {
  const server = createAuthServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base, server); } finally { await new Promise(resolve => server.close(resolve)); }
}

const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('HTTP : sans configuration, tout répond 503 not_configured (jamais de faux compte)', async () => {
  await withServer({ env: {}, now: () => NOW, fetch: async () => { throw new Error('aucun appel'); } }, async base => {
    const health = await (await fetch(`${base}/auth/health`)).json();
    assert.deepEqual(health.providers, { x: false, telegram: false, telegramWidget: false, whatsapp: false });
    for (const path of ['/auth/x/exchange', '/auth/telegram/exchange', '/auth/telegram/widget', '/auth/whatsapp/start', '/auth/whatsapp/verify']) {
      const res = await post(`${base}${path}`, {});
      assert.equal(res.status, 503, path);
      assert.deepEqual(await res.json(), { error: 'not_configured' });
    }
  });
});

test('HTTP : parcours X complet, redirectUri contrôlée, session révocable', async () => {
  const env = { X_CLIENT_ID: 'cid', X_REDIRECT_URIS: 'mindlumina://login' };
  const providerFetch = fakeFetch({
    'https://api.x.com/2/oauth2/token': () => [200, { access_token: 'AT' }],
    'https://api.x.com/2/users/me': () => [200, { data: { id: '1', username: 'alice', name: 'Alice' } }],
  });
  await withServer({ env, fetch: providerFetch, now: () => NOW }, async (base, server) => {
    const bad = await post(`${base}/auth/x/exchange`, { code: 'C', codeVerifier: VERIFIER, redirectUri: 'https://evil.example' });
    assert.equal(bad.status, 400);
    const res = await post(`${base}/auth/x/exchange`, { code: 'C', codeVerifier: VERIFIER, redirectUri: 'mindlumina://login' });
    assert.equal(res.status, 200);
    const session = await res.json();
    assert.equal(session.schemaVersion, 1);
    assert.equal(session.identity.handle, 'alice');
    assert.ok(session.sessionToken.length >= 40);
    assert.ok(server.sessions.lookup(session.sessionToken));
    await post(`${base}/auth/logout`, {}, { Authorization: `Bearer ${session.sessionToken}` });
    assert.equal(server.sessions.lookup(session.sessionToken), null);
    assert.equal((await post(`${base}/auth/x/exchange`, '{pas du json')).status, 400);
  });
});

test('HTTP : relais Telegram vers l’app et widget HMAC', async () => {
  const env = { TELEGRAM_CLIENT_ID: '7000000001', TELEGRAM_CLIENT_SECRET: 's', TELEGRAM_BOT_TOKEN: BOT_TOKEN, AUTH_PUBLIC_URL: 'https://auth.example', APP_REDIRECT_URI: 'mindlumina://login' };
  await withServer({ env, now: () => NOW, fetch: async () => { throw new Error('aucun appel'); } }, async base => {
    const res = await fetch(`${base}/auth/telegram/callback?code=abc&state=xyz&inject=1`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'mindlumina://login?code=abc&state=xyz');
    const fields = { id: '42', first_name: 'Alice', username: 'alice', auth_date: String(NOW / 1000 - 5) };
    const ok = await post(`${base}/auth/telegram/widget`, widgetPayload(fields));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).identity.handle, 'alice');
    const forged = await post(`${base}/auth/telegram/widget`, { ...widgetPayload(fields), username: 'mallory' });
    assert.equal(forged.status, 401);
    const wrongRedirect = await post(`${base}/auth/telegram/exchange`, { code: 'c', codeVerifier: VERIFIER, redirectUri: 'mindlumina://login' });
    assert.equal(wrongRedirect.status, 400);
  });
});

test('HTTP : WhatsApp OTP de bout en bout avec envoi simulé', async () => {
  let sentCode = null;
  const env = { WHATSAPP_ACCESS_TOKEN: 'T', WHATSAPP_PHONE_NUMBER_ID: 'PNID', WHATSAPP_TEMPLATE_NAME: 'mind_otp' };
  const providerFetch = fakeFetch({ 'https://graph.facebook.com/v26.0/PNID/messages': init => { sentCode = JSON.parse(init.body).template.components[0].parameters[0].text; return [200, { messages: [{ id: 'wamid' }] }]; } });
  await withServer({ env, fetch: providerFetch, now: () => NOW }, async base => {
    assert.equal((await post(`${base}/auth/whatsapp/start`, { phone: '0612' })).status, 400);
    const start = await (await post(`${base}/auth/whatsapp/start`, { phone: '+33 6 12 34 56 78' })).json();
    assert.equal(start.delivery, 'otp');
    assert.equal('code' in start, false, 'le code ne doit jamais être renvoyé à l’app');
    const wrong = await post(`${base}/auth/whatsapp/verify`, { challengeId: start.challengeId, code: sentCode === '000000' ? '111111' : '000000' });
    assert.deepEqual(await wrong.json(), { error: 'invalid_code' });
    const ok = await (await post(`${base}/auth/whatsapp/verify`, { challengeId: start.challengeId, code: sentCode })).json();
    assert.equal(ok.identity.providerUserId, '+33612345678');
    assert.equal(ok.identity.handle, '+33 ••• 678');
  });
});

test('HTTP : webhook Meta signé confirme le défi wa.me', async () => {
  const env = { WHATSAPP_DELIVERY: 'wa_link', WHATSAPP_APP_SECRET: 'appsecret', WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'vt' };
  await withServer({ env, now: () => NOW, fetch: async () => { throw new Error('aucun appel'); } }, async base => {
    const sub = await fetch(`${base}/auth/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=987`);
    assert.equal(await sub.text(), '987');
    assert.equal((await fetch(`${base}/auth/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=1`)).status, 403);
    const start = await (await post(`${base}/auth/whatsapp/start`, { phone: '+33612345678' })).json();
    assert.equal(start.delivery, 'wa_link');
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '33612345678', type: 'text', text: { body: `MIND ${start.userCode}` } }] } }] }] });
    assert.equal((await post(`${base}/auth/whatsapp/webhook`, raw, { 'X-Hub-Signature-256': 'sha256=00' })).status, 401);
    const signed = await post(`${base}/auth/whatsapp/webhook`, raw, { 'X-Hub-Signature-256': `sha256=${createHmac('sha256', 'appsecret').update(raw).digest('hex')}` });
    assert.equal(signed.status, 200);
    const session = await (await post(`${base}/auth/whatsapp/verify`, { challengeId: start.challengeId })).json();
    assert.equal(session.identity.provider, 'whatsapp');
  });
});
