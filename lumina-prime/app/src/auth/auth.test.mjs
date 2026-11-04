// node --experimental-strip-types --test src/auth/auth.test.mjs — logique pure, sans React Native.
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { base64FromBytes, codeChallengeS256, codeVerifierFromBytes, isValidCodeVerifier, randomState } from './pkce.ts';
import { interpretCallback, parseUrlParams, PENDING_TTL_MS } from './callback.ts';
import { normalizeAuthUrl, resolveProviderConfig } from './config.ts';
import { buildTelegramAuthorizeUrl, buildWaMeLink, buildXAuthorizeUrl, parseSessionResponse, parseUserPhone, parseWhatsAppStart, telegramRelayRedirectUri } from './providers.ts';
import { authReducer, initialAuthState, providerView } from './session.ts';
import { createAuthApi } from './api.ts';

const NOW = Date.parse('2026-11-04T15:00:00Z');
const sha256Base64 = async input => createHash('sha256').update(input).digest('base64');

test('base64 maison identique à Buffer', () => {
  for (let n = 0; n < 40; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
    assert.equal(base64FromBytes(bytes), Buffer.from(bytes).toString('base64'));
  }
});

test('PKCE S256 : vecteur de la RFC 7636 (annexe B)', async () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(await codeChallengeS256(verifier, sha256Base64), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const generated = codeVerifierFromBytes(new Uint8Array(32).fill(7));
  assert.equal(generated.length, 43);
  assert.ok(isValidCodeVerifier(generated));
  assert.throws(() => codeVerifierFromBytes(new Uint8Array(16)));
  await assert.rejects(codeChallengeS256('trop-court', sha256Base64));
  assert.equal(randomState(new Uint8Array(16)).length, 22);
});

test('URL d’autorisation X et Telegram', () => {
  const x = new URL(buildXAuthorizeUrl({ clientId: 'cid', redirectUri: 'mindlumina://login', state: 'st', codeChallenge: 'ch' }));
  assert.equal(x.origin + x.pathname, 'https://x.com/i/oauth2/authorize');
  assert.equal(x.searchParams.get('scope'), 'users.read tweet.read');
  assert.equal(x.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(x.searchParams.get('redirect_uri'), 'mindlumina://login');
  const tg = new URL(buildTelegramAuthorizeUrl({ clientId: '7000000001', redirectUri: telegramRelayRedirectUri('https://auth.example'), state: 'st', codeChallenge: 'ch' }));
  assert.equal(tg.origin + tg.pathname, 'https://oauth.telegram.org/auth');
  assert.equal(tg.searchParams.get('scope'), 'openid profile');
  assert.equal(tg.searchParams.get('redirect_uri'), 'https://auth.example/auth/telegram/callback');
  assert.equal(buildWaMeLink('+33700000000', 'AB12CD'), 'https://wa.me/33700000000?text=MIND%20AB12CD');
});

test('parsing du retour : query, fragment, encodage, doublons', () => {
  assert.deepEqual(parseUrlParams('mindlumina://login?code=a%2Bb&state=s+1#x=1'), { code: 'a+b', state: 's 1', x: '1' });
  assert.deepEqual(parseUrlParams('exp://127.0.0.1:8081/--/login#code=f&state=g'), { code: 'f', state: 'g' });
  assert.deepEqual(parseUrlParams('mindlumina://login?code=q#code=f'), { code: 'q' });
  assert.deepEqual(parseUrlParams('mindlumina://login?bad=%E0%A4%A&ok=1'), { ok: '1' });
  assert.deepEqual(parseUrlParams('mindlumina://login'), {});
});

test('interprétation du retour : state, erreur, expiration, absence de demande', () => {
  const pending = { provider: 'x', state: 'S', codeVerifier: 'v', redirectUri: 'r', createdAt: NOW };
  assert.deepEqual(interpretCallback({ code: 'C', state: 'S' }, pending, NOW + 1000), { ok: true, code: 'C' });
  assert.equal(interpretCallback({ code: 'C', state: 'autre' }, pending, NOW).reason, 'state_mismatch');
  assert.equal(interpretCallback({ code: 'C' }, pending, NOW).reason, 'state_mismatch');
  assert.equal(interpretCallback({ error: 'access_denied', state: 'S' }, pending, NOW).reason, 'cancelled');
  assert.equal(interpretCallback({ error: 'server_error' }, pending, NOW).reason, 'provider_error');
  assert.equal(interpretCallback({ state: 'S' }, pending, NOW).reason, 'missing_code');
  assert.equal(interpretCallback({ code: 'C', state: 'S' }, pending, NOW + PENDING_TTL_MS + 1).reason, 'expired');
  assert.equal(interpretCallback({ code: 'C', state: 'S' }, null, NOW).reason, 'no_pending');
});

test('configuration : rien de configuré → « non configuré » avec variables manquantes', () => {
  assert.deepEqual(resolveProviderConfig('x', {}), { provider: 'x', configured: false, missing: ['EXPO_PUBLIC_MIND_AUTH_URL', 'EXPO_PUBLIC_X_CLIENT_ID'] });
  assert.equal(resolveProviderConfig('telegram', { authUrl: 'https://a.example', telegramClientId: '@monbot' }).configured, false);
  assert.equal(resolveProviderConfig('whatsapp', { authUrl: 'https://a.example', whatsappBusinessNumber: '06 12' }).configured, false);
  assert.deepEqual(resolveProviderConfig('x', { authUrl: 'https://a.example/', xClientId: ' cid ' }), { provider: 'x', configured: true, authUrl: 'https://a.example', clientId: 'cid' });
  assert.equal(resolveProviderConfig('whatsapp', { authUrl: 'https://a.example', whatsappBusinessNumber: '+33 7 00 00 00 00' }).configured, true);
  assert.equal(normalizeAuthUrl('http://evil.example'), null);
  assert.equal(normalizeAuthUrl('http://localhost:8787'), 'http://localhost:8787');
  assert.equal(normalizeAuthUrl('javascript:alert(1)'), null);
  assert.equal(parseUserPhone('0033 6 12 34 56 78'), '+33612345678');
  assert.equal(parseUserPhone('0612345678'), null);
});

const goodSession = { schemaVersion: 1, sessionToken: 't'.repeat(43), expiresAt: '2026-12-04T15:00:00Z', identity: { provider: 'x', providerUserId: '1', handle: 'alice', displayName: null, verifiedAt: '2026-11-04T15:00:00Z' } };

test('réponse de session : validation stricte', () => {
  assert.deepEqual(parseSessionResponse(goodSession, 'x', NOW), goodSession);
  assert.equal(parseSessionResponse(goodSession, 'telegram', NOW), null);
  assert.equal(parseSessionResponse({ ...goodSession, expiresAt: '2026-11-01T00:00:00Z' }, 'x', NOW), null);
  assert.equal(parseSessionResponse({ ...goodSession, sessionToken: 'court' }, 'x', NOW), null);
  assert.equal(parseSessionResponse({ ...goodSession, identity: { ...goodSession.identity, provider: 'facebook' } }, null, NOW), null);
  assert.equal(parseSessionResponse({ ok: true }, 'x', NOW), null);
  assert.equal(parseWhatsAppStart({ delivery: 'otp', challengeId: 'c', expiresAt: '2026-11-04T15:10:00Z' }, NOW)?.delivery, 'otp');
  assert.equal(parseWhatsAppStart({ delivery: 'wa_link', challengeId: 'c', expiresAt: '2026-11-04T15:10:00Z', userCode: 'bad code' }, NOW), null);
});

test('états : restauration, échec, connexion, déconnexion, vue par fournisseur', () => {
  let s = authReducer(initialAuthState, { type: 'restored', session: null, now: NOW });
  assert.equal(s.session.status, 'signed_out');
  assert.equal(providerView(s, 'x', false), 'unconfigured');
  assert.equal(providerView(s, 'x', true), 'idle');
  s = authReducer(s, { type: 'flow', flow: { phase: 'opening', provider: 'x' } });
  assert.equal(providerView(s, 'x', true), 'pending');
  assert.equal(providerView(s, 'telegram', true), 'idle');
  s = authReducer(s, { type: 'failed', provider: 'x', message: 'refusé' });
  assert.equal(providerView(s, 'x', true), 'error');
  s = authReducer(s, { type: 'signed_in', session: { ...goodSession, expiresAt: '2026-11-01T00:00:00Z' }, now: NOW });
  assert.equal(s.session.status, 'signed_out', 'session expirée refusée');
  s = authReducer(s, { type: 'signed_in', session: goodSession, now: NOW });
  assert.equal(providerView(s, 'x', true), 'connected');
  assert.equal(authReducer(s, { type: 'restored', session: null, now: NOW }), s, 'restauration tardive sans effet');
  s = authReducer(s, { type: 'signed_out' });
  assert.equal(s.session.status, 'signed_out');
  assert.equal(authReducer(initialAuthState, { type: 'restored', session: { ...goodSession, expiresAt: '2026-11-01T00:00:00Z' }, now: NOW }).session.status, 'signed_out');
});

test('client API : session valide, erreur serveur traduite, réseau indisponible', async () => {
  const calls = [];
  const fetchOk = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => goodSession }; };
  const ok = await createAuthApi('https://a.example', fetchOk, () => NOW).exchangeX({ code: 'C', codeVerifier: 'v', redirectUri: 'r' });
  assert.equal(ok.ok, true);
  assert.equal(calls[0].url, 'https://a.example/auth/x/exchange');
  assert.deepEqual(JSON.parse(calls[0].init.body), { code: 'C', codeVerifier: 'v', redirectUri: 'r' });
  const mismatch = await createAuthApi('https://a.example', fetchOk, () => NOW).exchangeTelegram({ code: 'C', codeVerifier: 'v', redirectUri: 'r' });
  assert.equal(mismatch.ok, false, 'identité X refusée pour un échange Telegram');
  const fetch503 = async () => ({ ok: false, status: 503, json: async () => ({ error: 'not_configured' }) });
  const nc = await createAuthApi('https://a.example', fetch503, () => NOW).whatsappStart({ phone: '+33612345678' });
  assert.deepEqual(nc, { ok: false, message: 'Ce fournisseur n’est pas encore configuré côté serveur.', code: 'not_configured' });
  const down = await createAuthApi('https://a.example', async () => { throw new TypeError('Network request failed'); }, () => NOW).whatsappVerify({ challengeId: 'c', code: '123456' });
  assert.equal(down.ok, false);
  assert.match(down.message, /injoignable/);
});

test('unified account metadata is checked and all proven providers stay connected', () => {
  const telegram = { ...goodSession.identity, provider: 'telegram', providerUserId: 'tg-42' };
  const source = { ...goodSession, mindUserId: '12345678-1234-4234-9234-123456789abc', identities: [goodSession.identity, telegram] };
  const session = parseSessionResponse(source, 'x', NOW);
  assert.equal(session.mindUserId, source.mindUserId);
  assert.equal(session.identities.length, 2);
  const state = { session: { status: 'signed_in', session }, flow: { phase: 'idle' } };
  assert.equal(providerView(state, 'x', true), 'connected');
  assert.equal(providerView(state, 'telegram', true), 'connected');
  assert.equal(parseSessionResponse({ ...source, identities: [telegram] }, 'x', NOW), null);
  assert.equal(parseSessionResponse({ ...source, identities: [goodSession.identity, goodSession.identity] }, 'x', NOW), null);
});

test('linking carries the existing session separately from fresh provider proof; restore uses authenticated GET', async () => {
  const calls = [];
  const token = 't'.repeat(43); const linkChallenge = 'c'.repeat(43);
  const mock = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => url.endsWith('/link/start') ? { linkChallenge, provider: 'x', expiresAt: new Date(NOW + 60_000).toISOString() } : goodSession };
  };
  const api = createAuthApi('https://a.example', mock, () => NOW);
  assert.equal((await api.startLink(token, 'x')).ok, true);
  assert.equal((await api.exchangeX({ code: 'C', codeVerifier: 'v', redirectUri: 'r' }, { sessionToken: token, linkChallenge })).ok, true);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(JSON.parse(calls[1].init.body).linkChallenge, linkChallenge);
  assert.equal((await api.validate(token)).ok, true);
  assert.equal(calls[2].init.method, 'GET');
  assert.equal(calls[2].init.body, undefined);
  assert.equal(calls[2].init.headers.Authorization, `Bearer ${token}`);
});
