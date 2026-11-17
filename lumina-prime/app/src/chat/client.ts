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
    || (ip[0] === 192 && ip[1] === 168) || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31)
    || (ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127)));
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
export async function call(url: string, path: string, options: RequestInit, fetchImpl = fetch): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  // Connect and first read fail fast (6 s) so an unreachable address never leaves the app silently waiting.
  const timer = setTimeout(abort, path === '/chat/transcribe' || path.startsWith('/chat/call/utterance') ? 130_000 : path.includes('&wait=25000') ? 32_000
    : path === '/chat/connect-local' || path.endsWith('&wait=0') ? 6_000 : 18_000);
  try {
    let response: Response;
    try { response = await fetchImpl(`${chatUrl(url)}${path}`, { ...options, signal: controller.signal, redirect: 'error' }); }
    catch (error) { if (options.signal?.aborted) throw error;
      throw new ChatClientError(controller.signal.aborted ? 'connection_timeout' : 'connection_lost'); }
    let value: unknown;
    try { value = await response.json(); } catch { throw new ChatClientError('invalid_response', response.status); }
    if (!response.ok) throw new ChatClientError(typeof (value as { error?: unknown })?.error === 'string'
      ? String((value as { error: string }).error) : 'connection_lost', response.status);
    return value;
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
export async function pairChat(url: string, code: string, signal?: AbortSignal, fetchImpl = fetch): Promise<ChatSession> {
  url = chatUrl(url);
  const value = await call(url, code ? '/chat/pair' : '/chat/connect-local', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(code ? { code: code.trim().toLowerCase() } : {}), signal }, fetchImpl) as { schema?: unknown; token?: unknown; expiresAt?: unknown };
  if (value?.schema !== 'mind.chat.session.v1' || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)
    || typeof value.expiresAt !== 'number' || value.expiresAt <= Date.now()) throw new ChatClientError('invalid_response');
  return { url, token: value.token, expiresAt: value.expiresAt };
}
/** Candidate gateway URLs in order (configured first, then LAN, then Tailscale), valid and deduplicated. */
export function chatCandidates(...values: (string | undefined | null)[]): string[] {
  const urls: string[] = [];
  for (const value of values.flatMap(item => String(item ?? '').split(',')).map(item => item.trim()).filter(Boolean)) {
    try { const url = chatUrl(value); if (!urls.includes(url)) urls.push(url); } catch { /* Ignore invalid or non-private entries. */ }
  }
  return urls;
}
/** No pairing: ask each private gateway address for a session, first answer wins. */
export async function connectChat(candidates: string[], signal?: AbortSignal, fetchImpl = fetch): Promise<ChatSession> {
  let last: unknown = new ChatClientError('local_address_required');
  for (const url of candidates) {
    if (signal?.aborted) break;
    try { return await pairChat(url, '', signal, fetchImpl); } catch (error) { last = error; }
  }
  throw last;
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
    pairing_rate_limited: 'Trop de tentatives. Demande un nouvel appairage dans Wake.', unauthorized: 'La session a expiré. Reconnexion…',
    local_connection_forbidden: 'La passerelle refuse la connexion automatique depuis ce réseau. Vérifie que le téléphone est sur le Wi-Fi du PC ou sur Tailscale.',
    connection_timeout: 'La passerelle Wake ne répond pas (délai dépassé).', connection_lost: 'Passerelle Wake injoignable.',
    network_forbidden: 'Connexion refusée : seul le Wi-Fi du PC ou Tailscale est accepté.',
    host_forbidden: 'Cette adresse n’est pas reconnue par la passerelle. Utilise l’adresse Wi-Fi ou Tailscale du PC.',
    local_address_required: 'Indique une adresse Wi-Fi ou Tailscale du PC, par exemple http://192.168.1.20:8789.',
    origin_forbidden: 'Cette origine web n’est pas autorisée par la passerelle.', message_conflict: 'Ce message a déjà été enregistré avec un autre texte.',
    invalid_response: 'La passerelle a renvoyé une réponse invalide.', wake_unavailable: 'Wake est momentanément indisponible.',
    transcription_unavailable: 'La transcription locale n’est pas configurée sur ce Wake.', transcription_busy: 'Une transcription est déjà en cours.',
    transcription_failed: 'L’audio est illisible ou dépasse la durée autorisée.', transcription_timeout: 'La transcription a pris trop de temps. Tu peux réessayer.',
    audio_too_large: 'L’enregistrement doit rester inférieur à 4 Mo.', audio_type_unsupported: 'Ce format audio n’est pas pris en charge.' } as Record<string, string>)[code]
    ?? 'Connexion interrompue. Les messages enregistrés seront retrouvés à la reconnexion.';
}

/** Markdown léger des transcriptions (bulles du Chat et de l'Appel) (NLR : « le gras en gras et les images en image ») et teinte des bulles par expéditeur. */
export type Inline = { kind: 'text' | 'bold' | 'italic' | 'code' | 'link'; text: string; url?: string };
export type Block = { kind: 'text'; inlines: Inline[] } | { kind: 'image'; url: string; alt: string }
  | { kind: 'file'; path: string; name: string; type: 'md' | 'pdf' | 'other' };

const IMAGE = /!\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s<>()]*)?)(?=$|[\s)\].,;!?])/gi;
const INLINE = /\*\*([^*\n]+?)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|(?<![*\w])\*([^*\s][^*\n]*?)\*(?![*\w])|(?<![\w_])_([^_\s][^_\n]*?)_(?![\w_])/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []; let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) });
    if (m[1] !== undefined) out.push({ kind: 'bold', text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'code', text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: 'link', text: m[3], url: m[4] });
    else if (m[5] !== undefined) out.push({ kind: 'link', text: m[5], url: m[5] });
    else out.push({ kind: 'italic', text: m[6] ?? m[7] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** Fichiers partagés par les agents : « [fichier: C:\…\X.md] » (tout chemin absolu) ou chemin Windows nu en .md/.pdf (éventuellement entre `…`). */
const FILE = /\[fichier\s*:\s*([^\]\n]+?)\s*\]|`?(?<![\w/\\])([A-Za-z]:[\\/][^\s<>"'`|*?()[\]]*?\.(?:md|pdf))`?(?=$|[\s)\].,;:!?'"])/gi;
export function fileBlock(path: string): Block {
  const clean = path.trim();
  const name = clean.split(/[\\/]/).filter(Boolean).at(-1) ?? clean;
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return { kind: 'file', path: clean, name, type: extension === 'md' ? 'md' : extension === 'pdf' ? 'pdf' : 'other' };
}
export function parseRich(text: string): Block[] {
  const out: Block[] = [];
  const pushText = (value: string) => { const trimmed = value.replace(/^[ \t]*\n|\n[ \t]*$/g, ''); if (trimmed.trim()) out.push({ kind: 'text', inlines: parseInline(trimmed) }); };
  const pushImages = (segment: string) => {
    let last = 0;
    for (const m of segment.matchAll(IMAGE)) {
      const at = m.index ?? 0;
      pushText(segment.slice(last, at));
      out.push(m[2] ? { kind: 'image', url: m[2], alt: m[1] ?? '' } : { kind: 'image', url: m[3], alt: '' });
      last = at + m[0].length;
    }
    pushText(segment.slice(last));
  };
  let last = 0;
  for (const m of text.matchAll(FILE)) {
    const path = m[1] ?? m[2];
    if (m[1] !== undefined && !/^(?:[A-Za-z]:[\\/]|\/)/.test(path.trim())) continue;
    const at = m.index ?? 0;
    pushImages(text.slice(last, at));
    out.push(fileBlock(path));
    last = at + m[0].length;
  }
  pushImages(text.slice(last));
  return out;
}

/** Adresse authentifiée du contenu d'un fichier partagé (passerelle : /chat/file, .md/.pdf du workspace seulement). */
export function fileUrl(session: ChatSession, path: string): string {
  return `${chatUrl(session.url)}/chat/file?path=${encodeURIComponent(path)}`;
}
export async function readChatFile(session: ChatSession, path: string, signal?: AbortSignal, fetchImpl = fetch): Promise<string> {
  let response: Response;
  try { response = await fetchImpl(fileUrl(session, path), { headers: { Authorization: `Bearer ${session.token}` }, signal, redirect: 'error' }); }
  catch (error) { if (signal?.aborted) throw error; throw new ChatClientError('connection_lost'); }
  if (!response.ok) {
    let code = response.status === 404 ? 'file_not_found' : 'connection_lost';
    try { const value = await response.json() as { error?: unknown }; if (typeof value?.error === 'string') code = value.error; } catch { /* corps non JSON */ }
    throw new ChatClientError(code, response.status);
  }
  return response.text();
}
export function fileErrorMessage(error: unknown): string {
  const code = error instanceof ChatClientError ? error.code : 'connection_lost';
  return ({ file_forbidden: 'Ce fichier n’est pas partageable (hors du workspace ou confidentiel).', file_not_found: 'Fichier introuvable sur le PC.',
    file_too_large: 'Fichier trop lourd (plus de 10 Mo).', file_type_unsupported: 'Seuls les fichiers .md et .pdf s’ouvrent dans l’app.',
    file_invalid: 'Chemin de fichier invalide.', not_found: 'La passerelle Wake doit être relancée pour ouvrir les fichiers.',
    files_unavailable: 'La passerelle Wake doit être relancée pour ouvrir les fichiers.' } as Record<string, string>)[code] ?? chatErrorMessage(error);
}

/** Markdown d'un document (.md ouvert dans l'app) : titres, listes, citations, blocs de code, séparateurs, paragraphes. */
export type DocBlock = { kind: 'heading'; level: number; text: string } | { kind: 'paragraph'; text: string }
  | { kind: 'bullet'; text: string; marker: string; depth: number } | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string } | { kind: 'rule' };
export function parseMarkdownDoc(source: string): DocBlock[] {
  const out: DocBlock[] = []; const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) out.push({ kind: 'paragraph', text: paragraph.join('\n') }); paragraph = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush(); const body: string[] = [];
      while (++i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i]);
      out.push({ kind: 'code', text: body.join('\n') }); continue;
    }
    let m: RegExpExecArray | null;
    if (!line.trim()) { flush(); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { // Tableau : lignes conservées en bloc à chasse fixe, sans la ligne de séparation.
      flush(); const rows: string[] = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) if (!/^\s*\|[\s|:-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim());
      i--; out.push({ kind: 'code', text: rows.join('\n') }); continue;
    }
    if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { flush(); out.push({ kind: 'heading', level: m[1].length, text: m[2] }); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push({ kind: 'rule' }); continue; }
    if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      flush(); const marker = /\d/.test(m[2]) ? m[2] : '•';
      out.push({ kind: 'bullet', text: m[3].replace(/^\[ \]\s*/, '☐ ').replace(/^\[[xX]\]\s*/, '☑ '), marker, depth: Math.min(4, Math.floor(m[1].replace(/\t/g, '  ').length / 2)) }); continue;
    }
    if ((m = /^\s{0,3}>\s?(.*)$/.exec(line))) { flush(); const last = out.at(-1);
      if (last?.kind === 'quote') last.text += `\n${m[1]}`; else out.push({ kind: 'quote', text: m[1] }); continue; }
    const previous = out.at(-1);
    if (!paragraph.length && previous?.kind === 'bullet' && /^\s{2,}\S/.test(line)) { previous.text += ` ${line.trim()}`; continue; }
    paragraph.push(line.trim());
  }
  flush();
  return out;
}

/** Teintes douces, lisibles avec le texte foncé ; la couleur des bulles de NLR (vert) n'y figure pas. */
export const TINTS = ['#FDE2E4', '#DCEBFA', '#FFF1C9', '#E8DFF5', '#FCE1C8', '#D7F0EE', '#F3E0EC', '#E4EFD1', '#E0E4F7', '#F6E6D8'];
export function tintOf(name: string): string {
  let hash = 2166136261;
  for (const char of name.trim().toLowerCase()) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 16777619); }
  return TINTS[(hash >>> 0) % TINTS.length];
}
