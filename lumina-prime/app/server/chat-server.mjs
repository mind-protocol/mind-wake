import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createPresenceRegistry, PresenceError } from './presence-registry.mjs';

export class ChatError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const digest = value => createHash('sha256').update(String(value)).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));

/** One existing owner's conversation. Pairing is not a social login or financial mandate. */
export function createChatServer({ bridge, transcribe = null, pairingCode = randomBytes(12).toString('hex'),
  now = Date.now, pairTtlMs = 300_000, sessionTtlMs = 12 * 60 * 60_000,
  origins = [], hosts = ['127.0.0.1', 'localhost'], pollIntervalMs = 500, maxWaitMs = 25_000 } = {}) {
  if (!bridge?.snapshot || !bridge?.send || typeof pairingCode !== 'string' || pairingCode.length < 12)
    throw new Error('A fixed owner bridge and strong pairing code are required');
  let pairUsed = false;
  const pairExpiresAt = now() + pairTtlMs;
  const sessions = new Map();
  const presence = createPresenceRegistry({ now, ttlMs: 45000 });
  const failures = new Map();
  const pending = new Map();
  const sends = new Map();
  let totalFailures = 0;
  let voiceBusy = false;
  const originSet = new Set(origins);
  const hostSet = new Set(hosts);
  const sessionFor = req => {
    const value = req.headers.authorization;
    const token = typeof value === 'string' && /^Bearer [a-f0-9]{64}$/.test(value) ? value.slice(7) : '';
    const session = sessions.get(digest(token).toString('hex'));
    if (!session || session.expiresAt <= now()) throw new ChatError('unauthorized', 401);
    return { ...session, key: digest(token).toString('hex') };
  };
  function send(res, status, body, origin) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}) });
    res.end(JSON.stringify(body));
  }
  async function body(req) {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new ChatError('json_required', 415);
    let bytes = 0; const chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 20_000) throw new ChatError('body_too_large', 413);
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ChatError('invalid_json'); }
  }
  async function snapshot() {
    const messages = await bridge.snapshot();
    if (!Array.isArray(messages)) throw new ChatError('wake_unavailable', 503);
    return { schema: 'mind.chat.v1', messages, cursor: digest(JSON.stringify(messages)).toString('hex'),
      observedAt: new Date(now()).toISOString() };
  }
  const server = createServer(async (req, res) => {
    let origin;
    try {
      // Neither Host nor Origin can select a different owner, directory or command.
      const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
      if (!hostSet.has(host)) throw new ChatError('host_forbidden', 403);
      const suppliedOrigin = req.headers.origin;
      if (suppliedOrigin !== undefined) {
        if (typeof suppliedOrigin !== 'string' || !originSet.has(suppliedOrigin)) throw new ChatError('origin_forbidden', 403);
        origin = suppliedOrigin;
      }
      const url = new URL(req.url, 'http://local.invalid');
      if (url.pathname.startsWith('/chat/') && req.method === 'OPTIONS') {
        res.writeHead(204, { ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Cache-Control': 'no-store' }); res.end(); return;
      }
      if (req.method === 'POST' && url.pathname === '/chat/pair') {
        if (url.search) throw new ChatError('invalid_request');
        const input = await body(req);
        if (!keys(input, ['code']) || typeof input.code !== 'string') throw new ChatError('invalid_request');
        const ip = req.socket.remoteAddress;
        if (totalFailures >= 20 || (failures.get(ip) ?? 0) >= 5) throw new ChatError('pairing_rate_limited', 429);
        if (pairUsed || pairExpiresAt <= now()) throw new ChatError('pairing_expired', 410);
        if (!same(input.code.trim(), pairingCode)) {
          failures.set(ip, (failures.get(ip) ?? 0) + 1); totalFailures++;
          throw new ChatError('pairing_invalid', 401);
        }
        pairUsed = true;
        const token = randomBytes(32).toString('hex');
        const session = { expiresAt: now() + sessionTtlMs };
        sessions.set(digest(token).toString('hex'), session);
        send(res, 200, { schema: 'mind.chat.session.v1', token, expiresAt: session.expiresAt }, origin); return;
      }
      const session = sessionFor(req);
      if (req.method === 'POST' && url.pathname === '/chat/presence') {
        if (url.search) throw new ChatError('invalid_request');
        const receipt = presence.update(session.key, await body(req));
        send(res, 200, receipt, origin); return;
      }
      if (req.method === 'POST' && url.pathname === '/chat/transcribe') {
        if (url.search) throw new ChatError('invalid_request');
        if (!transcribe) throw new ChatError('transcription_unavailable', 503);
        if (voiceBusy) throw new ChatError('transcription_busy', 429);
        const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (!['audio/webm', 'audio/mp4', 'audio/m4a', 'audio/aac', 'audio/ogg', 'audio/wav'].includes(mime))
          throw new ChatError('audio_type_unsupported', 415);
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new ChatError('audio_too_large', 413); chunks.push(chunk); }
        if (!size) throw new ChatError('audio_empty', 400);
        if (voiceBusy) throw new ChatError('transcription_busy', 429);
        voiceBusy = true; const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); }; res.once('close', abort);
        try {
          const result = await transcribe(Buffer.concat(chunks), mime, controller.signal);
          if (!sessions.has(session.key) || session.expiresAt <= now()) throw new ChatError('unauthorized', 401);
          send(res, 200, { schema: 'mind.chat.transcript.v1', text: result.text, durationSeconds: result.durationSeconds,
            status: 'draft', sentToWake: false }, origin);
        } finally { voiceBusy = false; res.removeListener('close', abort); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/chat/logout') {
        sessions.delete(session.key); send(res, 200, { status: 'revoked' }, origin); return;
      }
      if (req.method === 'POST' && url.pathname === '/chat/messages') {
        if (url.search) throw new ChatError('invalid_request');
        const input = await body(req);
        if (!keys(input, ['id', 'text']) || !/^chat-[a-f0-9-]{36}$/.test(input.id)
          || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000)
          throw new ChatError('invalid_request');
        const trimmed = input.text.trim();
        // Serialize concurrent retries. The durable Wake inbox/CLI remains authoritative after restart.
        let previous = sends.get(input.id);
        const retried = Boolean(previous);
        if (previous && previous.text !== trimmed) throw new ChatError('message_conflict', 409);
        if (!previous) {
          if (sends.size >= 1000) throw new ChatError('send_limit_reached', 429);
          const promise = Promise.resolve().then(() => bridge.send(input.id, trimmed));
          previous = { text: trimmed, promise }; sends.set(input.id, previous);
        }
        try {
          const receipt = await previous.promise;
          send(res, 202, { schema: 'mind.chat.receipt.v1', id: input.id, status: 'queued',
            duplicate: retried || receipt.status === 'duplicate', at: receipt.at }, origin);
        } catch (error) { sends.delete(input.id); throw error; }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/chat/messages') {
        if ([...url.searchParams.keys()].some(key => !['cursor', 'wait'].includes(key))) throw new ChatError('invalid_request');
        const cursor = url.searchParams.get('cursor') ?? '';
        if (cursor && !/^[a-f0-9]{64}$/.test(cursor)) throw new ChatError('invalid_cursor');
        const wait = Math.min(maxWaitMs, Math.max(0, Number(url.searchParams.get('wait') ?? '0')));
        if (!Number.isFinite(wait)) throw new ChatError('invalid_request');
        let result = await snapshot();
        if (!wait || result.cursor !== cursor) { send(res, 200, result, origin); return; }
        if ((pending.get(session.key) ?? 0) >= 2) throw new ChatError('too_many_connections', 429);
        pending.set(session.key, (pending.get(session.key) ?? 0) + 1);
        const started = now();
        try {
          while (!res.destroyed && !res.writableEnded && now() - started < wait) {
            await new Promise(resolve => { const timer = setTimeout(resolve, pollIntervalMs); timer.unref(); });
            if (!sessions.has(session.key) || session.expiresAt <= now()) throw new ChatError('unauthorized', 401);
            result = await snapshot();
            if (result.cursor !== cursor) break;
          }
          send(res, 200, result, origin);
        } finally { pending.set(session.key, Math.max(0, (pending.get(session.key) ?? 1) - 1)); }
        return;
      }
      throw new ChatError('not_found', 404);
    } catch (error) {
      send(res, error instanceof ChatError || error instanceof PresenceError ? error.status : 503,
        { error: error instanceof ChatError || error instanceof PresenceError ? error.code : 'wake_unavailable' }, origin);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxRequestsPerSocket = 300;
  return { server, pairing: { code: pairingCode, expiresAt: pairExpiresAt }, close: () => {
    sessions.clear(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve));
  } };
}
