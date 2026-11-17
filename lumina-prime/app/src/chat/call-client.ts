import { call, chatUrl, ChatClientError, type ChatSession } from './client.ts';

export type CallSession = {id:string;epoch:1};
export type CallSessionState = CallSession & {status:'active'|'ended';revision?:number;handles:string[]};
export type CallTarget = { handle: string; label: string; kind: 'main' | 'room' | 'agent' | 'holder' | 'remote'; emoji?: string; available?: boolean };
export type CallReply = { id: string; at: string; text: string; speaker: string | null; first?: boolean };
export type CallUtterance = { status: 'queued' | 'empty'; text: string; label?: string; durationSeconds: number; transcribeMs: number };
const auth = (session: ChatSession) => ({ Authorization: `Bearer ${session.token}` });
const handle = (value: string) => { if (!/^[a-z0-9][a-z0-9_.-]{0,60}$/.test(value)) throw new ChatClientError('call_target_invalid'); return value; };
/** Plusieurs participants : une prise de parole part à chacun (`vox,mind`). */
const handles = (values: string[]) => { if (!values.length || values.length > 8) throw new ChatClientError('call_target_invalid'); return values.map(handle).join(','); };

export async function callTargets(session: ChatSession, signal?: AbortSignal): Promise<CallTarget[]> {
  const value = await call(session.url, '/chat/call/targets', { headers: auth(session), signal }) as { schema?: unknown; targets?: unknown };
  if (value?.schema !== 'mind.chat.call.targets.v1' || !Array.isArray(value.targets)) throw new ChatClientError('invalid_response');
  return (value.targets as CallTarget[]).filter(t => typeof t?.handle === 'string' && typeof t.label === 'string');
}

const scopeQuery = (scope:CallSession) => {
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(scope.id)||scope.epoch!==1)throw new ChatClientError('call_session_invalid');
  return `call=${encodeURIComponent(scope.id)}&epoch=1`;
};
async function sessionRequest(session:ChatSession,scope:CallSession,path:string,method:'GET'|'POST',targets?:string[],signal?:AbortSignal,keepalive=false,revision?:number):Promise<CallSessionState> {
  const value=await call(session.url,`${path}?${scopeQuery(scope)}${targets?'&target='+encodeURIComponent(handles(targets)):''}${revision?'&revision='+revision:''}`,{method,headers:auth(session),signal,keepalive})as Partial<CallSessionState>&{schema?:unknown};
  if(value.schema!=='mind.chat.call.session.v1'||value.id!==scope.id||value.epoch!==scope.epoch||!['active','ended'].includes(String(value.status))||!Array.isArray(value.handles))throw new ChatClientError('invalid_response');
  return value as CallSessionState;
}
export const openCallSession=(session:ChatSession,scope:CallSession,targets:string[],signal?:AbortSignal)=>sessionRequest(session,scope,'/chat/call/session','POST',targets,signal);
export const callSessionState=(session:ChatSession,scope:CallSession,signal?:AbortSignal)=>sessionRequest(session,scope,'/chat/call/session','GET',undefined,signal);
export const joinCallParticipants=(session:ChatSession,scope:CallSession,targets:string[],revision:number,signal?:AbortSignal)=>sessionRequest(session,scope,'/chat/call/participants','POST',targets,signal,false,revision);
export const removeCallParticipants=(session:ChatSession,scope:CallSession,targets:string[],revision:number,signal?:AbortSignal)=>sessionRequest(session,scope,'/chat/call/participants/remove','POST',targets,signal,false,revision);

/** Instruction envoyée aux participants, sans bulle dans la transcription. */
export async function cancelCallMessage(session: ChatSession, scope: CallSession, id: string, text: string, signal?: AbortSignal): Promise<void> {
  const value = await call(session.url, `/chat/call/cancel-message?${scopeQuery(scope)}`, {
    method: 'POST', headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, text }), signal,
  }) as { schema?: string; status?: string };
  if (value.schema !== 'mind.chat.call.cancel.v1' || value.status !== 'queued') throw new ChatClientError('invalid_response');
}

/** Envoie une prise de parole : transcription sur le desktop puis remise à l'interlocuteur. */
export async function sendCallUtterance(session: ChatSession, targets: string[], id: string, audio: Blob | ArrayBuffer, mime: string, signal?: AbortSignal, scope?:CallSession): Promise<CallUtterance> {
  if (!/^chat-[a-f0-9-]{36}$/.test(id)) throw new ChatClientError('invalid_message');
  const size = audio instanceof ArrayBuffer ? audio.byteLength : audio.size;
  if (!size || size > 4 * 1024 * 1024) throw new ChatClientError('audio_too_large');
  const value = await call(session.url, `/chat/call/utterance?target=${encodeURIComponent(handles(targets))}&id=${id}${scope?'&'+scopeQuery(scope):''}`,
    { method: 'POST', headers: { ...auth(session), 'Content-Type': mime }, body: audio, signal }) as Partial<CallUtterance> & { schema?: unknown };
  if (value?.schema !== 'mind.chat.call.utterance.v1' || !['queued', 'empty'].includes(String(value.status)) || typeof value.text !== 'string')
    throw new ChatClientError('invalid_response');
  return value as CallUtterance;
}

/** Raccrocher côté passerelle : fin de l'appel de ces participants (plus aucune copie entre eux). */
export async function endCall(session: ChatSession, targets: string[], signal?: AbortSignal, keepalive = false, scope?:CallSession): Promise<number> {
  if(scope){await sessionRequest(session,scope,'/chat/call/session/end','POST',undefined,signal,keepalive);return 1;}
  const value = await call(session.url, `/chat/call/end?target=${encodeURIComponent(handles(targets))}`,
    { method: 'POST', headers: auth(session), signal, keepalive }) as { schema?: unknown; ended?: unknown };
  if (value?.schema !== 'mind.chat.call.end.v1') throw new ChatClientError('invalid_response');
  return Number(value.ended) || 0;
}

export async function callReplies(session: ChatSession, target: string, since: string, signal?: AbortSignal, scope?: CallSession): Promise<CallReply[]> {
  const value = await call(session.url, `/chat/call/replies?target=${encodeURIComponent(handle(target))}&since=${encodeURIComponent(since)}${scope?'&'+scopeQuery(scope):''}`,
    { headers: auth(session), signal }) as { schema?: unknown; items?: unknown };
  if (value?.schema !== 'mind.chat.call.replies.v1' || !Array.isArray(value.items)) throw new ChatClientError('invalid_response');
  return value.items as CallReply[];
}

/** Audio d'une réponse (MP3 ElevenLabs ou WAV local), synthétisé sur le desktop. */
export async function callSpeech(session: ChatSession, target: string, item: string, signal?: AbortSignal, announce = false, scope?: CallSession) {
  const controller = new AbortController(); const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 150_000);
  try {
    let response: Response;
    try {
      response = await fetch(`${chatUrl(session.url)}/chat/call/speech?target=${encodeURIComponent(handle(target))}&item=${encodeURIComponent(item)}${announce ? '&announce=1' : ''}${scope?'&'+scopeQuery(scope):''}`,
        { headers: auth(session), signal: controller.signal, redirect: 'error' });
    } catch (error) { if (signal?.aborted) throw error; throw new ChatClientError('connection_lost'); }
    if (!response.ok) {
      let code = 'speech_failed'; try { code = String((await response.json() as { error?: unknown }).error ?? code); } catch { /* Corps non JSON. */ }
      throw new ChatClientError(code, response.status);
    }
    return { blob: await response.blob(), provider: response.headers.get('X-Speech-Provider') ?? '?', ms: Number(response.headers.get('X-Speech-Ms') ?? 0) };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
