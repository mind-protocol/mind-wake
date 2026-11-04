export type ChatMessage = { id: string; at: string; text: string; version: number;
  role: 'agent' | 'human'; status: 'published' | 'queued' | 'delivered' };
export type ChatSnapshot = { schema: 'mind.chat.v1'; messages: ChatMessage[]; cursor: string; observedAt: string };
export type ChatSession = { url: string; token: string; expiresAt: number };
export class ChatClientError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 0) { super(code); this.code = code; this.status = status; }
}
export function chatUrl(value: string): string {
  const url = new URL(value.trim());
  const ip = url.hostname.split('.').map(Number);
  const validIp = ip.length === 4 && ip.every(part => Number.isInteger(part) && part >= 0 && part <= 255);
  const local = url.hostname === 'localhost' || (validIp && (ip[0] === 127 || ip[0] === 10
    || (ip[0] === 192 && ip[1] === 168) || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31)));
  if (!local || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || url.pathname !== '/') throw new ChatClientError('local_address_required');
  return url.origin;
}
export function parseChatSnapshot(value: unknown): ChatSnapshot {
  const input = value as Partial<ChatSnapshot> | null;
  if (!input || input.schema !== 'mind.chat.v1' || !/^[a-f0-9]{64}$/.test(input.cursor ?? '')
    || !Number.isFinite(Date.parse(input.observedAt ?? '')) || !Array.isArray(input.messages) || input.messages.length > 100)
    throw new ChatClientError('invalid_response');
  const seen = new Set<string>();
  for (const m of input.messages) {
    if (!m || typeof m.id !== 'string' || seen.has(m.id) || !Number.isFinite(Date.parse(m.at))
      || typeof m.text !== 'string' || !Number.isInteger(m.version) || m.version < 1
      || !['agent', 'human'].includes(m.role) || (m.role === 'agent' ? m.status !== 'published' : !['queued', 'delivered'].includes(m.status)))
      throw new ChatClientError('invalid_response');
    seen.add(m.id);
  }
  return input as ChatSnapshot;
}
async function call(url: string, path: string, options: RequestInit, fetchImpl = fetch): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, path === '/chat/transcribe' ? 130_000 : path.includes('&wait=25000') ? 32_000 : 18_000);
  try {
    let response: Response;
    try { response = await fetchImpl(`${chatUrl(url)}${path}`, { ...options, signal: controller.signal, redirect: 'error' }); }
    catch (error) { if (options.signal?.aborted) throw error; throw new ChatClientError('connection_lost'); }
    let value: unknown;
    try { value = await response.json(); } catch { throw new ChatClientError('invalid_response', response.status); }
    if (!response.ok) throw new ChatClientError(typeof (value as { error?: unknown })?.error === 'string'
      ? String((value as { error: string }).error) : 'connection_lost', response.status);
    return value;
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
export async function pairChat(url: string, code: string, signal?: AbortSignal, fetchImpl = fetch): Promise<ChatSession> {
  url = chatUrl(url);
  const value = await call(url, '/chat/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code.trim().toLowerCase() }), signal }, fetchImpl) as { schema?: unknown; token?: unknown; expiresAt?: unknown };
  if (value?.schema !== 'mind.chat.session.v1' || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)
    || typeof value.expiresAt !== 'number' || value.expiresAt <= Date.now()) throw new ChatClientError('invalid_response');
  return { url, token: value.token, expiresAt: value.expiresAt };
}
export async function readChat(session: ChatSession, cursor = '', signal?: AbortSignal, fetchImpl = fetch) {
  return parseChatSnapshot(await call(session.url, `/chat/messages?cursor=${encodeURIComponent(cursor)}&wait=${cursor ? 25000 : 0}`,
    { headers: { Authorization: `Bearer ${session.token}` }, signal }, fetchImpl));
}
export async function sendChat(session: ChatSession, id: string, text: string, signal?: AbortSignal, fetchImpl = fetch) {
  if (!/^chat-[a-f0-9-]{36}$/.test(id) || !text.trim() || text.length > 4000) throw new ChatClientError('invalid_message');
  const value = await call(session.url, '/chat/messages', { method: 'POST', headers: {
    Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id, text }), signal }, fetchImpl) as {
    schema?: unknown; id?: unknown; status?: unknown; duplicate?: unknown; at?: unknown };
  if (value?.schema !== 'mind.chat.receipt.v1' || value.id !== id || value.status !== 'queued'
    || typeof value.duplicate !== 'boolean' || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at)))
    throw new ChatClientError('invalid_response');
  return value;
}
export async function logoutChat(session: ChatSession) {
  await call(session.url, '/chat/logout', { method: 'POST', headers: { Authorization: `Bearer ${session.token}` } });
}
export async function transcribeChatVoice(session: ChatSession, audio: Blob | ArrayBuffer, mime: string, signal?: AbortSignal, fetchImpl = fetch): Promise<string> {
  const size = audio instanceof ArrayBuffer ? audio.byteLength : audio.size;
  if (!size || size > 4 * 1024 * 1024) throw new ChatClientError('audio_too_large');
  const value = await call(session.url, '/chat/transcribe', { method: 'POST',
    headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': mime }, body: audio, signal }, fetchImpl) as {
    schema?: unknown; text?: unknown; status?: unknown; sentToWake?: unknown; durationSeconds?: unknown };
  if (value?.schema !== 'mind.chat.transcript.v1' || typeof value.text !== 'string' || value.text.length > 4000
    || value.status !== 'draft' || value.sentToWake !== false || typeof value.durationSeconds !== 'number'
    || value.durationSeconds <= 0 || value.durationSeconds > 65) throw new ChatClientError('invalid_response');
  return value.text;
}
export function chatErrorMessage(error: unknown): string {
  const code = error instanceof ChatClientError ? error.code : 'connection_lost';
  return ({ pairing_invalid: 'Code incorrect.', pairing_expired: 'Le code a expiré ou a déjà été utilisé. Demande un nouvel appairage dans Wake.',
    pairing_rate_limited: 'Trop de tentatives. Demande un nouvel appairage dans Wake.', unauthorized: 'La session a expiré. Relie à nouveau cet appareil.',
    local_address_required: 'Indique une adresse locale du PC, par exemple http://192.168.1.20:8789.',
    origin_forbidden: 'Cette origine web n’est pas autorisée par la passerelle.', message_conflict: 'Ce message a déjà été enregistré avec un autre texte.',
    invalid_response: 'La passerelle a renvoyé une réponse invalide.', wake_unavailable: 'Wake est momentanément indisponible.',
    transcription_unavailable: 'La transcription locale n’est pas configurée sur ce Wake.', transcription_busy: 'Une transcription est déjà en cours.',
    transcription_failed: 'L’audio est illisible ou dépasse la durée autorisée.', transcription_timeout: 'La transcription a pris trop de temps. Tu peux réessayer.',
    audio_too_large: 'L’enregistrement doit rester inférieur à 4 Mo.', audio_type_unsupported: 'Ce format audio n’est pas pris en charge.' } as Record<string, string>)[code]
    ?? 'Connexion interrompue. Les messages enregistrés seront retrouvés à la reconnexion.';
}
