// Serveur d'auth MIND : SQLite et identité unifiée si AUTH_DB_PATH est configuré.
// Sans ce chemin explicite, mode de référence à sessions volatiles.
// Lancement : node server/auth/server.mjs   (variables d'environnement : voir README.md)
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createIdentityStore } from './identity-store.mjs';
import {
  AuthError, buildWhatsAppOtpRequest, createJwksCache, createSessionStore, createWhatsAppChallenges,
  exchangeTelegramCode, exchangeXCode, maskPhone, normalizePhone, verifyMetaSignature, verifyTelegramWidget,
} from './core.mjs';

const MAX_BODY = 16 * 1024;

function list(value) {
  return String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

/** @param {{ env?: Record<string, string|undefined>, fetch?: typeof globalThis.fetch, now?: () => number }} [options] */
export function createAuthServer({ env = process.env, fetch = globalThis.fetch, now = Date.now } = {}) {
  const cfg = {
    publicUrl: env.AUTH_PUBLIC_URL?.replace(/\/+$/, ''),
    appRedirectUri: env.APP_REDIRECT_URI,
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    x: { clientId: env.X_CLIENT_ID, clientSecret: env.X_CLIENT_SECRET || undefined, redirectUris: list(env.X_REDIRECT_URIS) },
    telegram: { clientId: env.TELEGRAM_CLIENT_ID, clientSecret: env.TELEGRAM_CLIENT_SECRET, botToken: env.TELEGRAM_BOT_TOKEN },
    whatsapp: {
      delivery: env.WHATSAPP_DELIVERY === 'wa_link' ? 'wa_link' : 'otp',
      accessToken: env.WHATSAPP_ACCESS_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, templateName: env.WHATSAPP_TEMPLATE_NAME,
      language: env.WHATSAPP_TEMPLATE_LANG || 'fr', apiVersion: env.WHATSAPP_API_VERSION || 'v26.0',
      appSecret: env.WHATSAPP_APP_SECRET, verifyToken: env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    },
  };
  const ready = {
    x: Boolean(cfg.x.clientId && cfg.x.redirectUris.length),
    telegram: Boolean(cfg.telegram.clientId && cfg.telegram.clientSecret && cfg.publicUrl && cfg.appRedirectUri),
    telegramWidget: Boolean(cfg.telegram.botToken),
    whatsapp: cfg.whatsapp.delivery === 'otp'
      ? Boolean(cfg.whatsapp.accessToken && cfg.whatsapp.phoneNumberId && cfg.whatsapp.templateName)
      : Boolean(cfg.whatsapp.appSecret && cfg.whatsapp.verifyToken),
  };
  const persistent = Boolean(env.AUTH_DB_PATH);
  const sessions = persistent ? createIdentityStore({ filename: env.AUTH_DB_PATH, now }) : createSessionStore({ now });
  const challenges = createWhatsAppChallenges({ now });
  const getJwks = createJwksCache(fetch, now);

  function send(res, status, body, extraHeaders = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { reject(new AuthError('invalid_request', 413)); req.destroy(); } else chunks.push(chunk); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function json(raw) {
    try { const value = JSON.parse(raw.toString('utf8') || '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* plus bas */ }
    throw new AuthError('invalid_request', 400);
  }

  function need(flag) { if (!flag) throw new AuthError('not_configured', 503); }

  function bearer(req) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization ?? ''));
    if (!match || !sessions.lookup(match[1])) throw new AuthError('unauthorized', 401);
    return match[1];
  }

  // Identity is produced by a provider verifier below, never accepted as client JSON.
  function finishIdentity(req, body, identity) {
    if (Object.hasOwn(body, 'linkChallenge')) {
      need(persistent);
      return sessions.link(bearer(req), body.linkChallenge, identity);
    }
    return sessions.issue(identity);
  }

  const routes = {
    'GET /auth/health': async () => [200, { ok: true, identityStorage: persistent ? 'sqlite' : 'volatile', providers: { x: ready.x, telegram: ready.telegram, telegramWidget: ready.telegramWidget, whatsapp: ready.whatsapp ? cfg.whatsapp.delivery : false } }],

    'GET /auth/account': async (req) => {
      need(persistent);
      const session = sessions.lookup(bearer(req));
      return [200, { mindUserId: session.mindUserId, identities: session.identities }];
    },

    'GET /auth/session': async (req) => {
      const token = bearer(req);
      return [200, { schemaVersion: 1, sessionToken: token, ...sessions.lookup(token) }];
    },

    'POST /auth/link/start': async (req, raw) => {
      need(persistent);
      return [200, sessions.startLink(bearer(req), json(raw).provider)];
    },

    'POST /auth/x/exchange': async (req, raw) => {
      need(ready.x);
      const body = json(raw);
      if (!cfg.x.redirectUris.includes(body.redirectUri)) throw new AuthError('invalid_request', 400, 'redirectUri non autorisée');
      const identity = await exchangeXCode(body, { ...cfg.x, fetch, now });
      return [200, finishIdentity(req, body, identity)];
    },

    // Telegram renvoie ici (URL https enregistrée chez @BotFather) ; on relaie code/state vers l'app.
    'GET /auth/telegram/callback': async (req) => {
      need(ready.telegram);
      const url = new URL(req.url, 'http://local');
      const out = new URLSearchParams();
      for (const key of ['code', 'state', 'error']) { const v = url.searchParams.get(key); if (v && v.length <= 2048) out.set(key, v); }
      const target = `${cfg.appRedirectUri}${cfg.appRedirectUri.includes('?') ? '&' : '?'}${out.toString()}`;
      return [302, null, { Location: target }];
    },

    'POST /auth/telegram/exchange': async (req, raw) => {
      need(ready.telegram);
      const body = json(raw);
      if (body.redirectUri !== `${cfg.publicUrl}/auth/telegram/callback`) throw new AuthError('invalid_request', 400, 'redirectUri inattendue');
      const identity = await exchangeTelegramCode(body, { clientId: cfg.telegram.clientId, clientSecret: cfg.telegram.clientSecret, fetch, now, getJwks });
      return [200, finishIdentity(req, body, identity)];
    },

    // Variante web (Login Widget legacy) : vérification HMAC avec le jeton du bot.
    'POST /auth/telegram/widget': async (_req, raw) => {
      need(ready.telegramWidget);
      const result = verifyTelegramWidget(json(raw), cfg.telegram.botToken, { now: now() });
      if (!result.ok) throw new AuthError(result.reason === 'expired' ? 'expired' : 'invalid_request', 401, result.reason);
      return [200, sessions.issue({ provider: 'telegram', providerUserId: result.user.id, handle: result.user.username ?? `tg-${result.user.id}`, displayName: result.user.name, verifiedAt: new Date(now()).toISOString() })];
    },

    'POST /auth/whatsapp/start': async (_req, raw) => {
      need(ready.whatsapp);
      const phone = normalizePhone(json(raw).phone);
      if (!phone) throw new AuthError('invalid_request', 400, 'numéro invalide');
      const { challengeId, code, expiresAt } = challenges.start(phone, cfg.whatsapp.delivery);
      if (cfg.whatsapp.delivery === 'wa_link') return [200, { delivery: 'wa_link', challengeId, expiresAt, userCode: code }];
      const request = buildWhatsAppOtpRequest({ phone, code, ...cfg.whatsapp });
      const sent = await fetch(request.url, request.init).catch(() => null);
      if (!sent?.ok) throw new AuthError('provider_unavailable', 502, 'envoi WhatsApp refusé');
      return [200, { delivery: 'otp', challengeId, expiresAt }];
    },

    'POST /auth/whatsapp/verify': async (req, raw) => {
      need(ready.whatsapp);
      const body = json(raw);
      const phone = typeof body.code === 'string' ? challenges.verifyOtp(body.challengeId, body.code) : challenges.verifyInbound(body.challengeId);
      return [200, finishIdentity(req, body, { provider: 'whatsapp', providerUserId: phone, handle: maskPhone(phone), displayName: null, verifiedAt: new Date(now()).toISOString() })];
    },

    // Webhook Meta (mode wa_link) : vérification d'abonnement puis messages entrants signés.
    'GET /auth/whatsapp/webhook': async (req) => {
      need(cfg.whatsapp.verifyToken);
      const url = new URL(req.url, 'http://local');
      if (url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === cfg.whatsapp.verifyToken) return [200, url.searchParams.get('hub.challenge') ?? '', { 'Content-Type': 'text/plain' }, true];
      throw new AuthError('invalid_request', 403);
    },
    'POST /auth/whatsapp/webhook': async (req, raw) => {
      need(cfg.whatsapp.appSecret);
      if (!verifyMetaSignature(raw, req.headers['x-hub-signature-256'], cfg.whatsapp.appSecret)) throw new AuthError('invalid_request', 401, 'signature invalide');
      const payload = json(raw);
      for (const entry of payload.entry ?? []) for (const change of entry.changes ?? []) for (const message of change.value?.messages ?? []) {
        if (message.type === 'text') challenges.recordInbound(message.from, message.text?.body);
      }
      return [200, { ok: true }];
    },

    'POST /auth/logout': async (req) => {
      const header = String(req.headers.authorization ?? '');
      if (header.startsWith('Bearer ')) sessions.revoke(header.slice(7));
      return [200, { ok: true }];
    },
  };

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = origin && cfg.allowedOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST' } : {};
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    const handler = routes[`${req.method} ${path}`];
    if (!handler) { send(res, 404, { error: 'not_found' }, cors); return; }
    try {
      const raw = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
      const [status, body, headers = {}, plain = false] = await handler(req, raw);
      if (status === 302) { res.writeHead(302, { ...cors, ...headers, 'Cache-Control': 'no-store' }); res.end(); return; }
      if (plain) { res.writeHead(status, { ...cors, ...headers }); res.end(String(body)); return; }
      send(res, status, body, cors);
    } catch (error) {
      if (error instanceof AuthError) send(res, error.status, { error: error.code }, cors);
      else { send(res, 500, { error: 'server_error' }, cors); }
    }
  });
  if (persistent) server.once('close', () => sessions.close());
  return Object.assign(server, { sessions, challenges, ready });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 8787);
  const server = createAuthServer();
  server.listen(port, () => console.log(`MIND auth (référence) sur :${port}`, server.ready));
}
