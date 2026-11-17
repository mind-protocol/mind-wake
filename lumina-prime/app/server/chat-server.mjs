import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createPresenceRegistry, PresenceError } from './presence-registry.mjs';
import { ReportError, validateReport } from './chat-reports.mjs';
import { FileAccessError } from './chat-files.mjs';

export class ChatError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const digest = value => createHash('sha256').update(String(value)).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));

/** Loopback, RFC 1918 and Tailscale CGNAT (100.64.0.0/10) IPv4 only, from the socket address — never from headers. */
export function isPrivateAddress(address) {
  const value = String(address ?? '').toLowerCase().replace(/^::ffff:/, '');
  if (value === '::1') return true;
  const ip = value.split('.').map(part => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (ip.length !== 4 || ip.some(part => !(part >= 0 && part <= 255))) return false;
  return ip[0] === 127 || ip[0] === 10 || (ip[0] === 192 && ip[1] === 168)
    || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127);
}

/** One existing owner's conversation. Pairing is not a social login or financial mandate. */
export function createChatServer({ bridge, transcribe = null, pairingCode = randomBytes(12).toString('hex'),
  now = Date.now, pairTtlMs = 300_000, sessionTtlMs = 12 * 60 * 60_000,
  origins = [], hosts = ['127.0.0.1', 'localhost'], pollIntervalMs = 500, maxWaitMs = 25_000,
  localConnect = false, privateNetworkConnect = false, sessionStore = null, reportStore = null, phones = null, phoneOwner = () => "nlr", desktopCallPage = null, call = null, controls = null, ring = null, files = null, appErrors = null } = {}) {
  if (!bridge?.snapshot || !bridge?.send || typeof pairingCode !== 'string' || pairingCode.length < 12)
    throw new Error('A fixed owner bridge and strong pairing code are required');
  let pairUsed = false;
  const pairExpiresAt = now() + pairTtlMs;
  const sessions = new Map(sessionStore?.load() ?? []);
  const persist = () => sessionStore?.save([...sessions]);
  function issueSession(origin, res, address) {
    const token = randomBytes(32).toString('hex');
    const session = { expiresAt: now() + sessionTtlMs, human: phoneOwner(address) };
    sessions.set(digest(token).toString('hex'), session); persist();
    send(res, 200, { schema: 'mind.chat.session.v1', token, expiresAt: session.expiresAt }, origin);
  }
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
  async function body(req, limit = 20_000) {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new ChatError('json_required', 415);
    let bytes = 0; const chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > limit) throw new ChatError('body_too_large', 413);
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
  /** Audio authentifié → texte (Whisper local), une transcription à la fois. */
  async function transcribeRequest(req, res, session) {
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
      return result;
    } finally { voiceBusy = false; res.removeListener('close', abort); }
  }
  // Mode Appel : la voix des réponses attend la fin d'une transcription (NLR d'abord).
  call?.setTranscribing?.(() => voiceBusy);
  const callParams = (url, allowed) => {
    if ([...url.searchParams.keys()].some(key => !allowed.includes(key))) throw new ChatError('invalid_request');
    if (!call) throw new ChatError('call_unavailable', 503);
    return Object.fromEntries(allowed.map(key => [key, url.searchParams.get(key) ?? '']));
  };
  const server = createServer(async (req, res) => {
    let origin;
    try {
      // Private-network mode: any non-private peer is refused before routing, whatever its headers say.
      if (privateNetworkConnect && !isPrivateAddress(req.socket.remoteAddress)) throw new ChatError('network_forbidden', 403);
      // Neither Host nor Origin can select a different owner, directory or command.
      const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
      if (!hostSet.has(host)) throw new ChatError('host_forbidden', 403);
      const suppliedOrigin = req.headers.origin;
      if (suppliedOrigin !== undefined) {
        if (typeof suppliedOrigin !== 'string' || !originSet.has(suppliedOrigin)) throw new ChatError('origin_forbidden', 403);
        origin = suppliedOrigin;
      }
      const url = new URL(req.url, 'http://local.invalid');
      if (desktopCallPage && req.method === 'GET' && host === '127.0.0.1'
        && ['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
        && await desktopCallPage(url.pathname, res)) return;
      if (url.pathname.startsWith('/chat/') && req.method === 'OPTIONS') {
        res.writeHead(204, { ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Cache-Control': 'no-store' }); res.end(); return;
      }
      if (req.method === 'POST' && url.pathname === '/chat/connect-local') {
        const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        const loopbackOrigin = origin && ['localhost', '127.0.0.1'].includes(new URL(origin).hostname);
        const usbLocal = localConnect && loopback && loopbackOrigin && ['localhost', '127.0.0.1'].includes(host);
        // No-pairing mode: the owner's own devices on LAN/Tailscale get a session; any supplied Origin was checked above.
        const privatePeer = privateNetworkConnect && isPrivateAddress(req.socket.remoteAddress);
        if (!usbLocal && !privatePeer) throw new ChatError('local_connection_forbidden', 403);
        if (url.search || !keys(await body(req), [])) throw new ChatError('invalid_request');
        if (sessions.size >= 100) throw new ChatError('too_many_connections', 429);
        issueSession(origin, res, req.socket.remoteAddress); return;
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
        issueSession(origin, res, req.socket.remoteAddress); return;
      }
      const session = sessionFor(req);
      if (phones && url.pathname.startsWith('/chat/phone/')) {
        const human = session.human ?? phoneOwner(req.socket.remoteAddress);
        if (req.method === 'GET' && url.pathname === '/chat/phone/ringtone-capabilities') {
            send(res,200,{version:1},origin); return;
          }
          if (req.method === 'POST' && url.pathname === '/chat/phone/ringtone-capabilities') {
            const {keys} = await body(req);
            try { phones.setRingtoneCapabilities(session.key,human,keys); } catch { throw new ChatError('invalid_request'); }
            send(res,200,{registered:true},origin); return;
          }
          if (req.method === 'POST' && url.pathname === '/chat/phone/register') {
          const {token} = await body(req);
          if (token !== null && (typeof token !== 'string' || !/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]{1,200}\]$/.test(token))) throw new ChatError('invalid_request');
          phones.register(session.key, human, token, session.expiresAt);
          send(res, 200, {human}, origin); return;
        }
        if (req.method === 'GET' && url.pathname === '/chat/phone/pending') {
          send(res, 200, {invite: phones.pending(human,session.key)}, origin); return;
        }
        if (req.method === 'POST' && url.pathname === '/chat/phone/answer') {
          const {id, decision} = await body(req);
          if (typeof id !== 'string' || !['accept','decline'].includes(decision)) throw new ChatError('invalid_request');
          const next = phones.pending(human);
          if (!next || next.id !== id) throw new ChatError('call_expired', 409);
          if (decision === 'accept') call.resolve(next.caller);
          const result = phones.decide(human, id, decision);
          if (!result) throw new ChatError('call_expired', 409);
          send(res, 200, result, origin); return;
        }
      }
      if (req.method === 'POST' && url.pathname === '/chat/reports') {
        if (url.search) throw new ChatError('invalid_request');
        if (!reportStore) throw new ReportError('reports_unavailable', 503);
        const input = validateReport(await body(req, 80_000));
        let receipt = reportStore.existing(input);
        if (!receipt) {
          const messages = await bridge.snapshot();
          if (!Array.isArray(messages)) throw new ChatError('wake_unavailable', 503);
          if (!messages.some(m => m.role === 'agent' && m.status === 'published'
            && m.id === input.messageId && m.version === input.version && m.text.slice(0, 12000) === input.text))
            throw new ReportError('report_message_changed', 409);
          if (!sessions.has(session.key) || session.expiresAt <= now()) throw new ChatError('unauthorized', 401);
          receipt = reportStore.record(input);
        }
        send(res, 200, receipt, origin); return;
      }
      // Erreur affichée dans l'app mobile → message pair `app-error` au principal (session existante requise).
      // Seuls screen/text/at sont acceptés ; app est fixé ici ; le runtime masque les secrets. V1 : ni dédup ni limite.
      if (req.method === 'POST' && url.pathname === '/chat/app-errors') {
        if (url.search) throw new ChatError('invalid_request');
        if (!appErrors) throw new ChatError('app_errors_unavailable', 503);
        const input = await body(req, 40_000);
        if (!keys(input, ['screen', 'text', 'at']) || typeof input.text !== 'string' || !input.text.trim()
          || (input.screen !== undefined && typeof input.screen !== 'string')
          || (input.at !== undefined && typeof input.at !== 'string')) throw new ChatError('invalid_request');
        let relayed;
        try { relayed = await appErrors({ app: 'mobile', screen: input.screen, text: input.text, at: input.at }); }
        catch (error) { if (error?.code === 'invalid_app_error') throw new ChatError('invalid_request'); throw error; }
        send(res, 202, { schema: 'mind.chat.app-error.receipt.v1', id: relayed.id, status: 'relayed' }, origin); return;
      }
      if (req.method === 'POST' && url.pathname === '/chat/presence') {
        if (url.search) throw new ChatError('invalid_request');
        const receipt = presence.update(session.key, await body(req));
        send(res, 200, receipt, origin); return;
      }
      if (req.method === 'POST' && url.pathname === '/chat/transcribe') {
        if (url.search) throw new ChatError('invalid_request');
        const result = await transcribeRequest(req, res, session);
        send(res, 200, { schema: 'mind.chat.transcript.v1', text: result.text, durationSeconds: result.durationSeconds,
            speechSeconds: result.speechSeconds, processingMs: result.processingMs, device: result.device,
          status: 'draft', sentToWake: false }, origin);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/chat/logout') {
        phones?.disconnect(session.key); sessions.delete(session.key); persist(); send(res, 200, { status: 'revoked' }, origin); return;
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
      // Fichiers partagés par les agents (.md/.pdf du workspace) : voir chat-files.mjs pour les refus.
      if (req.method === 'GET' && url.pathname === '/chat/file') {
        if ([...url.searchParams.keys()].some(key => key !== 'path')) throw new ChatError('invalid_request');
        if (!files) throw new ChatError('files_unavailable', 503);
        const file = await files(url.searchParams.get('path') ?? '');
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': file.bytes.length, 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}) });
        res.end(file.bytes); return;
      }
      // Sonnerie : questions d'agents à NLR postérieures à `since` (voir chat-ring.mjs).
      if (req.method === 'GET' && url.pathname === '/chat/ring') {
        if ([...url.searchParams.keys()].some(key => key !== 'since')) throw new ChatError('invalid_request');
        if (!ring) throw new ChatError('ring_unavailable', 503);
        const events = await ring(url.searchParams.get('since') ?? '');
        const scheduled = ring.pending ? await ring.pending() : [];
        send(res, 200, { schema: 'mind.chat.ring.v1', events, scheduled, observedAt: new Date(now()).toISOString() }, origin); return;
      }
      const callScope = (query) => {
        if (!query.call || query.epoch !== '1') throw new ChatError('call_session_invalid');
        return {owner:session.key,id:query.call,epoch:1};
      };
      const ensureActive = scope => {
        const state = controls?.control({id:scope.id,epoch:scope.epoch});
        if (state?.status === 'ended') {
          call.endSession(scope.owner,scope.id,scope.epoch);
          throw new ChatError('call_ended',410);
        }
        return call.assertSession(scope.owner,scope.id,scope.epoch);
      };
      if(req.method==='GET'&&url.pathname==='/chat/call/capabilities') {
        callParams(url,[]);
        const scoped=Boolean(call.openSession&&call.stateSession&&call.endSession);
        const membership=Boolean(call.addSession&&call.removeSession);
        const controlLinked=Boolean(controls?.registerCall&&controls?.control&&controls?.markEnded&&controls?.addParticipants&&controls?.replaceParticipants);
        send(res,200,{schema:'mind.chat.call.capabilities.v1',protocol:scoped&&membership?2:0,scoped,membershipRevision:membership?1:0,removeParticipants:membership,controlLinked},origin);return;
      }
      if (url.pathname === '/chat/call/session' && ['GET','POST'].includes(req.method)) {
        const query=callParams(url,req.method==='POST'?['call','epoch','target']:['call','epoch']);
        const scope=callScope(query);let state;
        if(req.method==='POST') {
          if(controls?.control({id:scope.id,epoch:scope.epoch})?.status==='ended') throw new ChatError('call_ended',410);
          const participants=call.identityKeys(query.target);
          // Register before open: an end received first remains terminal in the shared store.
          try {controls?.registerCall({id:scope.id,epoch:scope.epoch,participants});}
          catch(error){throw new ChatError(error.code??'call_control_failed',error.code==='call_ended'?410:400);}
          state=call.openSession(scope.owner,scope.id,scope.epoch,query.target);
        } else {
          // Check owner before consulting or acting on a global control record.
          try {state=call.stateSession(scope.owner,scope.id,scope.epoch);}
          catch(error){
            if(error.code!=='call_session_unknown')throw error;
            controls?.markEnded({id:scope.id,epoch:scope.epoch});
            state=call.endSession(scope.owner,scope.id,scope.epoch);
          }
          if(state.status==='active'&&controls?.control({id:scope.id,epoch:scope.epoch})?.status==='ended')state=call.endSession(scope.owner,scope.id,scope.epoch);
        }
        send(res,200,{schema:'mind.chat.call.session.v1',...state},origin);return;
      }
      if(req.method==='POST'&&url.pathname==='/chat/call/session/end') {
        const scope=callScope(callParams(url,['call','epoch']));
        const state=call.endSession(scope.owner,scope.id,scope.epoch);
        controls?.markEnded({id:scope.id,epoch:scope.epoch});
        send(res,200,{schema:'mind.chat.call.session.v1',...state},origin);return;
      }
      if(req.method==='POST'&&['/chat/call/participants','/chat/call/participants/remove'].includes(url.pathname)) {
        const query=callParams(url,['call','epoch','target','revision']);const scope=callScope(query);ensureActive(scope);
        if(!/^[1-9]\d{0,8}$/.test(query.revision))throw new ChatError('call_revision_invalid');
        const removing=url.pathname.endsWith('/remove');
        const state=(removing?call.removeSession:call.addSession)(scope.owner,scope.id,scope.epoch,query.target,Number(query.revision));
        try {
          if(state.status==='ended')controls?.markEnded({id:scope.id,epoch:scope.epoch});
          else if(removing)controls?.replaceParticipants({id:scope.id,epoch:scope.epoch,participants:call.identityKeys(state.handles)});
          else controls?.addParticipants({id:scope.id,epoch:scope.epoch,participants:call.identityKeys(state.handles)});
        }
        catch(error){if(error.code==='call_ended'){call.endSession(scope.owner,scope.id,scope.epoch);throw new ChatError('call_ended',410);}throw error;}
        send(res,200,{schema:'mind.chat.call.session.v1',...state},origin);return;
      }
      if (req.method === 'GET' && url.pathname === '/chat/call/targets') {
        callParams(url, []);
        send(res, 200, { schema: 'mind.chat.call.targets.v1', targets: call.targets() }, origin); return;
      }
      if (req.method === 'POST' && url.pathname === '/chat/call/utterance') {
        const { target, id, call:callId, epoch } = callParams(url, ['target', 'id', 'call', 'epoch']);
        const scope=callId||epoch?callScope({call:callId,epoch}):null;
        if(scope)ensureActive(scope);
        if (!/^chat-[a-f0-9-]{36}$/.test(id)) throw new ChatError('invalid_request');
        // Une cible ou plusieurs (`vox,mind`) : validées avant la transcription, remises une fois chacune.
        if (call.parseTargets) call.parseTargets(target); else call.resolve(target);
        const started = now();
        const result = await transcribeRequest(req, res, session);
        const transcribeMs = now() - started;
        const text = result.text.trim();
        if(scope)ensureActive(scope);
        if (!text) { send(res, 200, { schema: 'mind.chat.call.utterance.v1', id, status: 'empty', text: '',
          durationSeconds: result.durationSeconds, transcribeMs }, origin); return; }
        const receipt = await call.deliver(target, id, text.slice(0, 3900),scope);
        send(res, 200, { schema: 'mind.chat.call.utterance.v1', id, status: 'queued', text, label: receipt.label,
          at: receipt.at, durationSeconds: result.durationSeconds, transcribeMs }, origin); return;
      }
      // Raccrocher : fin de la room partagée temporaire (plus aucune copie entre participants).
      if (req.method === 'POST' && url.pathname === '/chat/call/end') {
        const { target } = callParams(url, ['target']);
        const result = call.end ? call.end(target) : { ended: 0 };
        send(res, 200, { schema: 'mind.chat.call.end.v1', ended: result.ended }, origin); return;
      }
      if (req.method === 'GET' && url.pathname === '/chat/call/replies') {
        const { target, since } = callParams(url, ['target', 'since']);
        send(res, 200, { schema: 'mind.chat.call.replies.v1', items: await call.replies(target, since) }, origin); return;
      }
      if (req.method === 'GET' && url.pathname === '/chat/call/speech') {
        const { target, item, announce } = callParams(url, ['target', 'item', 'announce']);
        const audio = await call.speech(target, item, announce === '1');
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, { 'Content-Type': audio.mime, 'Content-Length': audio.bytes.length, 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          'X-Speech-Provider': audio.provider, 'X-Speech-Ms': String(audio.ms ?? 0),
          ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin',
            'Access-Control-Expose-Headers': 'X-Speech-Provider, X-Speech-Ms' } : {}) });
        res.end(audio.bytes); return;
      }
      throw new ChatError('not_found', 404);
    } catch (error) {
      const known = error instanceof ChatError || error instanceof PresenceError || error instanceof ReportError || error instanceof FileAccessError;
      send(res, known ? error.status : 503, { error: known ? error.code : 'wake_unavailable' }, origin);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxRequestsPerSocket = 300;
  return { server, pairing: { code: pairingCode, expiresAt: pairExpiresAt }, close: () => {
    sessions.clear(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve));
  } };
}
