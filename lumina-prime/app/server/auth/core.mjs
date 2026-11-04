// Logique de vérification du serveur d'auth MIND (référence, sans dépendance).
// Les secrets (client secret X/Telegram, jeton du bot, jeton WhatsApp) ne vivent qu'ici.
import { Buffer } from 'node:buffer';
import { createHash, createHmac, createPublicKey, randomBytes, randomInt, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';

export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
export const X_ME_URL = 'https://api.x.com/2/users/me';
export const TELEGRAM_ISSUER = 'https://oauth.telegram.org';
export const TELEGRAM_TOKEN_URL = 'https://oauth.telegram.org/token';
export const TELEGRAM_JWKS_URL = 'https://oauth.telegram.org/.well-known/jwks.json';

export class AuthError extends Error {
  /** @param {string} code @param {number} status @param {string} [detail] */
  constructor(code, status, detail) { super(detail ?? code); this.code = code; this.status = status; }
}

const sha256hex = (value) => createHash('sha256').update(value).digest('hex');

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[0-9a-f]+$/i.test(a)) return false;
  return timingSafeEqual(Buffer.from(a.toLowerCase(), 'hex'), Buffer.from(b.toLowerCase(), 'hex'));
}

function b64urlDecode(segment) {
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function isValidCodeVerifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

// ---------------------------------------------------------------------------
// Telegram — Login Widget « legacy » : hash = HEX(HMAC_SHA256(data_check_string, SHA256(bot_token)))
// Source : https://core.telegram.org/widgets/login-legacy
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, string|number>} data champs reçus (id, first_name, last_name, username, photo_url, auth_date, hash)
 * @param {string} botToken
 * @param {{ now: number, maxAgeSeconds?: number }} options now en millisecondes
 */
export function verifyTelegramWidget(data, botToken, { now, maxAgeSeconds = 86400 }) {
  if (!data || typeof data !== 'object' || typeof data.hash !== 'string') return { ok: false, reason: 'missing_hash' };
  const checkString = Object.keys(data).filter(key => key !== 'hash' && data[key] !== undefined && data[key] !== null)
    .sort().map(key => `${key}=${data[key]}`).join('\n');
  const secret = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest('hex');
  if (!safeEqualHex(expected, data.hash)) return { ok: false, reason: 'bad_hash' };
  const authDate = Number(data.auth_date);
  if (!Number.isFinite(authDate)) return { ok: false, reason: 'bad_auth_date' };
  const age = now / 1000 - authDate;
  if (age > maxAgeSeconds) return { ok: false, reason: 'expired' };
  if (age < -60) return { ok: false, reason: 'future_auth_date' };
  return { ok: true, user: { id: String(data.id), username: data.username ? String(data.username) : null, name: [data.first_name, data.last_name].filter(Boolean).join(' ') || null } };
}

// ---------------------------------------------------------------------------
// JWT (id_token Telegram OIDC) : signature JWKS + iss + aud + exp.
// Algorithmes Telegram : RS256 par défaut ; ES256 / EdDSA possibles (BotFather > Login Widget > Advanced).
// ---------------------------------------------------------------------------

/**
 * @param {string} token
 * @param {{ keys: object[] }} jwks
 * @param {{ issuer: string, audience: string, now: number, leewaySeconds?: number }} expected
 */
export function verifyJwt(token, jwks, { issuer, audience, now, leewaySeconds = 60 }) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) throw new AuthError('invalid_token', 401, 'id_token mal formé');
  let header, payload;
  try { header = JSON.parse(b64urlDecode(parts[0]).toString('utf8')); payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8')); }
  catch { throw new AuthError('invalid_token', 401, 'id_token illisible'); }
  const jwk = (jwks?.keys ?? []).find(key => (header.kid ? key.kid === header.kid : true));
  if (!jwk) throw new AuthError('invalid_token', 401, 'clé de signature inconnue');
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = b64urlDecode(parts[2]);
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  let valid = false;
  if (header.alg === 'RS256') valid = cryptoVerify('sha256', data, key, signature);
  else if (header.alg === 'ES256') valid = cryptoVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  else if (header.alg === 'EdDSA') valid = cryptoVerify(null, data, key, signature);
  else throw new AuthError('invalid_token', 401, `algorithme refusé: ${header.alg}`);
  if (!valid) throw new AuthError('invalid_token', 401, 'signature invalide');
  const nowSec = now / 1000;
  if (payload.iss !== issuer) throw new AuthError('invalid_token', 401, 'iss inattendu');
  const auds = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud)];
  if (!auds.includes(String(audience))) throw new AuthError('invalid_token', 401, 'aud inattendu');
  if (typeof payload.exp !== 'number' || payload.exp + leewaySeconds < nowSec) throw new AuthError('invalid_token', 401, 'id_token expiré');
  if (typeof payload.iat === 'number' && payload.iat - leewaySeconds > nowSec) throw new AuthError('invalid_token', 401, 'iat dans le futur');
  return payload;
}

// ---------------------------------------------------------------------------
// Échanges de code (fetch injecté ; aucun appel réel dans les tests)
// ---------------------------------------------------------------------------

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

function form(params) {
  return Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/** X OAuth 2.0 PKCE → identité vérifiée via GET /2/users/me. Le jeton X n'est pas conservé. */
export async function exchangeXCode({ code, codeVerifier, redirectUri }, { clientId, clientSecret, fetch, now }) {
  if (!code || !isValidCodeVerifier(codeVerifier) || !redirectUri) throw new AuthError('invalid_request', 400);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (clientSecret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
  const tokenRes = await fetch(X_TOKEN_URL, { method: 'POST', headers, body: form({ code, grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, code_verifier: codeVerifier }) });
  const token = await readJson(tokenRes);
  if (!tokenRes.ok || typeof token?.access_token !== 'string') throw new AuthError(tokenRes.status >= 500 ? 'provider_unavailable' : 'invalid_grant', tokenRes.status >= 500 ? 502 : 400);
  const meRes = await fetch(X_ME_URL, { method: 'GET', headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' } });
  const me = await readJson(meRes);
  const user = me?.data;
  if (!meRes.ok || typeof user?.id !== 'string' || typeof user?.username !== 'string') throw new AuthError('provider_unavailable', 502);
  return { provider: 'x', providerUserId: user.id, handle: user.username, displayName: typeof user.name === 'string' ? user.name : null, verifiedAt: new Date(now()).toISOString() };
}

/** Telegram OIDC : échange avec Basic(client_id:client_secret) + PKCE, puis validation de l'id_token. */
export async function exchangeTelegramCode({ code, codeVerifier, redirectUri }, { clientId, clientSecret, fetch, now, getJwks }) {
  if (!code || !isValidCodeVerifier(codeVerifier) || !redirectUri) throw new AuthError('invalid_request', 400);
  const tokenRes = await fetch(TELEGRAM_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
    body: form({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier, client_id: clientId }),
  });
  const token = await readJson(tokenRes);
  if (!tokenRes.ok || typeof token?.id_token !== 'string') throw new AuthError(tokenRes.status >= 500 ? 'provider_unavailable' : 'invalid_grant', tokenRes.status >= 500 ? 502 : 400);
  const claims = verifyJwt(token.id_token, await getJwks(), { issuer: TELEGRAM_ISSUER, audience: clientId, now: now() });
  const id = String(claims.id ?? claims.sub);
  const username = typeof claims.preferred_username === 'string' && claims.preferred_username ? claims.preferred_username : null;
  return { provider: 'telegram', providerUserId: id, handle: username ?? `tg-${id}`, displayName: typeof claims.name === 'string' ? claims.name : null, verifiedAt: new Date(now()).toISOString() };
}

/** Cache JWKS (1 h). */
export function createJwksCache(fetch, now, url = TELEGRAM_JWKS_URL, ttlMs = 3_600_000) {
  let cached = null; let at = 0;
  return async () => {
    if (cached && now() - at < ttlMs) return cached;
    const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
    const json = await readJson(res);
    if (!res.ok || !Array.isArray(json?.keys)) throw new AuthError('provider_unavailable', 502, 'JWKS indisponible');
    cached = json; at = now();
    return cached;
  };
}

// ---------------------------------------------------------------------------
// WhatsApp : défi OTP (template d'authentification, envoyé par le serveur) ou
// défi entrant (l'utilisateur envoie « MIND <code> » au numéro Business via wa.me).
// ---------------------------------------------------------------------------

export function normalizePhone(input) {
  const raw = String(input ?? '').replace(/[\s().-]/g, '');
  const withPlus = raw.startsWith('00') ? `+${raw.slice(2)}` : raw;
  return /^\+[1-9]\d{7,14}$/.test(withPlus) ? withPlus : null;
}

export function maskPhone(e164) {
  return e164.length > 6 ? `${e164.slice(0, 3)} ••• ${e164.slice(-3)}` : '•••';
}

/**
 * @param {{ now: () => number, ttlMs?: number, maxAttempts?: number, resendMs?: number }} options
 */
export function createWhatsAppChallenges({ now, ttlMs = 10 * 60_000, maxAttempts = 5, resendMs = 60_000 }) {
  const challenges = new Map();
  const lastStart = new Map();
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function gc() { for (const [id, c] of challenges) if (c.expiresAt < now() - ttlMs) challenges.delete(id); }

  function start(phone, delivery) {
    gc();
    const last = lastStart.get(phone);
    if (last && now() - last < resendMs) throw new AuthError('rate_limited', 429);
    lastStart.set(phone, now());
    const challengeId = randomBytes(18).toString('base64url');
    const code = delivery === 'otp' ? String(randomInt(0, 1_000_000)).padStart(6, '0') : Array.from({ length: 6 }, () => ALPHABET[randomInt(0, ALPHABET.length)]).join('');
    challenges.set(challengeId, { phone, delivery, codeHash: sha256hex(`${challengeId}:${code}`), expiresAt: now() + ttlMs, attempts: 0, inboundConfirmed: false });
    return { challengeId, code, expiresAt: new Date(now() + ttlMs).toISOString() };
  }

  function verifyOtp(challengeId, code) {
    const c = challenges.get(challengeId);
    if (!c || c.delivery !== 'otp') throw new AuthError('invalid_request', 400);
    if (c.expiresAt < now()) { challenges.delete(challengeId); throw new AuthError('expired', 410); }
    if (c.attempts >= maxAttempts) { challenges.delete(challengeId); throw new AuthError('too_many_attempts', 429); }
    c.attempts += 1;
    if (!/^\d{6}$/.test(String(code ?? '')) || !safeEqualHex(sha256hex(`${challengeId}:${code}`), c.codeHash)) {
      if (c.attempts >= maxAttempts) challenges.delete(challengeId);
      throw new AuthError('invalid_code', 400);
    }
    challenges.delete(challengeId); // usage unique
    return c.phone;
  }

  /** Message entrant (webhook) : `from` est le numéro WhatsApp sans « + ». */
  function recordInbound(from, text) {
    const match = /\bMIND\s+([A-Z0-9]{6})\b/i.exec(String(text ?? ''));
    const phone = normalizePhone(`+${String(from ?? '').replace(/^\+/, '')}`);
    if (!match || !phone) return false;
    const code = match[1].toUpperCase();
    for (const [id, c] of challenges) {
      if (c.delivery === 'wa_link' && c.phone === phone && c.expiresAt >= now() && safeEqualHex(sha256hex(`${id}:${code}`), c.codeHash)) { c.inboundConfirmed = true; return true; }
    }
    return false;
  }

  function verifyInbound(challengeId) {
    const c = challenges.get(challengeId);
    if (!c || c.delivery !== 'wa_link') throw new AuthError('invalid_request', 400);
    if (c.expiresAt < now()) { challenges.delete(challengeId); throw new AuthError('expired', 410); }
    if (!c.inboundConfirmed) throw new AuthError('pending', 409);
    challenges.delete(challengeId);
    return c.phone;
  }

  return { start, verifyOtp, recordInbound, verifyInbound };
}

/**
 * Envoi d'un template d'authentification « copy code » via Cloud API.
 * Source : developers.facebook.com/docs/whatsapp/business-management-api/authentication-templates/copy-code-button-authentication-templates
 * Le code figure deux fois : paramètre du corps et du bouton (sub_type url, index 0).
 */
export function buildWhatsAppOtpRequest({ phone, code, phoneNumberId, accessToken, templateName, language = 'fr', apiVersion = 'v26.0' }) {
  return {
    url: `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: templateName,
          language: { code: language },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
          ],
        },
      }),
    },
  };
}

/** Signature des webhooks Meta : X-Hub-Signature-256 = "sha256=" + HEX(HMAC_SHA256(app_secret, corps brut)). */
export function verifyMetaSignature(rawBody, header, appSecret) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  return safeEqualHex(createHmac('sha256', appSecret).update(rawBody).digest('hex'), header.slice(7));
}

// ---------------------------------------------------------------------------
// Sessions MIND : jeton opaque aléatoire ; seul son SHA-256 est conservé.
// ---------------------------------------------------------------------------

export function createSessionStore({ now, ttlMs = 30 * 24 * 3600_000 }) {
  const sessions = new Map();
  return {
    issue(identity) {
      const sessionToken = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now() + ttlMs).toISOString();
      sessions.set(sha256hex(sessionToken), { identity, expiresAt });
      return { schemaVersion: 1, sessionToken, expiresAt, identity };
    },
    lookup(token) {
      const s = sessions.get(sha256hex(String(token ?? '')));
      return s && Date.parse(s.expiresAt) > now() ? s : null;
    },
    revoke(token) { return sessions.delete(sha256hex(String(token ?? ''))); },
  };
}
