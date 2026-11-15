/** Three independent oral contexts. The principal orchestrates, it is not a fourth voice. */
export const VOICE_THREAD_IDS = ['fil1','fil2','fil3'] as const;
export type VoiceThreadId = typeof VOICE_THREAD_IDS[number];
export interface VoiceThread {id:VoiceThreadId;label:string;profile:'normal'|'tool_free_superthread'}
export type VoiceReplyTarget=VoiceThreadId|'principal'|'none';
export interface VoiceSelection {capturedAt:string;threadIds:VoiceThreadId[];replyTo:VoiceReplyTarget;mode:'focus'|'manual'|'principal';focusClipId?:string;threads?:VoiceThread[]}
export interface VoicePart {
  schema:'mind.voice.part.v1';requestId:string;index:number;count:number;
  capturedAt:string;threadIds:VoiceThreadId[];replyTo:VoiceReplyTarget;threads:VoiceThread[];
  text:string;attachments:string;
}
export interface VoiceInputMessage {origin:'human'|'agent_voice';speaker?:{threadId:VoiceThreadId;agentRef:string;clipId:string};requestId:string;capturedAt:string;text:string;threadIds:VoiceThreadId[];replyTo:VoiceReplyTarget;threads:VoiceThread[];attachments:string}
export const defaultVoiceThreads = ():VoiceThread[]=>VOICE_THREAD_IDS.map((id,index)=>({id,label:`Fil ${index+1}`,profile:'normal'}));
export function isVoiceThreadId(value:unknown):value is VoiceThreadId {return VOICE_THREAD_IDS.some(id=>id===value);}
export function validVoiceThreads(value:unknown):VoiceThread[]|undefined {
  if(!Array.isArray(value)||value.length!==3)return;
  const seen=new Set<string>(),out:VoiceThread[]=[];
  for(const raw of value){
    if(!raw||typeof raw!=='object')return;
    const v=raw as Record<string,unknown>;
    if(!isVoiceThreadId(v['id'])||seen.has(v['id'])||typeof v['label']!=='string'||!v['label'].trim()||v['label'].length>60||(v['profile']!=='normal'&&v['profile']!=='tool_free_superthread'))return;
    seen.add(v['id']);out.push({id:v['id'],label:v['label'],profile:v['profile']});
  }return out;
}
/** UI labels can persist, runtime agent bindings deliberately cannot. */
export function voiceThreadSettings(storage?:Pick<Storage,'getItem'|'setItem'>){
  let threads=defaultVoiceThreads();
  try {threads=validVoiceThreads(JSON.parse(storage?.getItem('mind.voice-contexts.v1')??'null'))??threads;}catch{/* Defaults remain usable. */}
  return {get:()=>structuredClone(threads),update:(next:VoiceThread[])=>{
    const valid=validVoiceThreads(next);if(!valid)throw Error('Trois fils et leurs libellés sont requis.');
    threads=valid;storage?.setItem('mind.voice-contexts.v1',JSON.stringify(threads));
  }};
}
/** Focus is only a UI hint. It never filters the default three-way delivery. */
export function voiceCaptureSelection(){
  let focus:{clipId:string;threadId:VoiceThreadId}|undefined;
  return {
    played(clip:{id:string;threadId?:string}){focus=isVoiceThreadId(clip.threadId)?{clipId:clip.id,threadId:clip.threadId}:undefined;},
    focus:()=>focus?{...focus}:undefined,
    capture(capturedAt:string,manual?:VoiceThreadId|'principal',threads=defaultVoiceThreads()):VoiceSelection {
      return {capturedAt,threadIds:[...VOICE_THREAD_IDS],replyTo:manual??focus?.threadId??'principal',mode:manual?'manual':focus?'focus':'principal',threads:structuredClone(threads),...(focus?{focusClipId:focus.clipId}:{})};
    },
  };
}
function validSelection(value:unknown):value is VoiceSelection{
  if(!value||typeof value!=='object')return false;const v=value as VoiceSelection;
  return typeof v.capturedAt==='string'&&Number.isFinite(Date.parse(v.capturedAt))&&Array.isArray(v.threadIds)&&v.threadIds.length>0&&v.threadIds.length<=3&&new Set(v.threadIds).size===v.threadIds.length&&v.threadIds.every(isVoiceThreadId)&&(isVoiceThreadId(v.replyTo)||v.replyTo==='principal'||v.replyTo==='none');
}
export function parseVoicePart(text:string):VoicePart|undefined{
  try{const v=JSON.parse(text) as VoicePart;
    if(v.schema!=='mind.voice.part.v1'||typeof v.requestId!=='string'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(v.requestId)||!Number.isInteger(v.index)||!Number.isInteger(v.count)||v.index<0||v.count<1||v.count>10000||v.index>=v.count||typeof v.text!=='string'||typeof v.attachments!=='string'||!validSelection(v)||!validVoiceThreads(v.threads))return;
    return v;
  }catch{return;}
}
export const voicePartDisplay=(p:VoicePart):string=>`[Dictée vocale]\n${p.text}${p.attachments}`;
/** Budget is the actual JSON UTF-16 length accepted by mind-wake reply, not raw text length.
 * Reserve a five-digit index/count while splitting, then assert every final envelope.
 * Never cut between a UTF-16 surrogate pair; text joins exactly without normalization. */
export function encodeVoiceParts(text:string,attachments:string,requestId:string,selection:VoiceSelection,threads:VoiceThread[],limit=4000):VoicePart[]{
  if(!validSelection(selection)||!validVoiceThreads(threads)||!/^[A-Za-z0-9_.:-]{1,100}$/.test(requestId))throw Error('Métadonnées vocales invalides.');
  const base={schema:'mind.voice.part.v1' as const,requestId,capturedAt:selection.capturedAt,threadIds:[...selection.threadIds],replyTo:selection.replyTo,threads:structuredClone(threads)};
  const candidate=(piece:string,suffix=''):VoicePart=>({...base,index:9999,count:10000,text:piece,attachments:suffix});
  if(JSON.stringify(candidate('',attachments)).length>limit)throw Error('Captures ou configuration trop longues ; transcription conservée sans envoi.');
  const chunks:string[]=[];let start=0;
  while(start<text.length){
    let lo=start,hi=text.length;
    while(lo<hi){const middle=Math.ceil((lo+hi)/2);if(JSON.stringify(candidate(text.slice(start,middle))).length<=limit)lo=middle;else hi=middle-1;}
    let end=lo;
    if(end<text.length&&end>start&&/[\uD800-\uDBFF]/u.test(text[end-1]!))end--;
    if(end===start)throw Error('Configuration trop longue ; transcription conservée sans envoi.');
    chunks.push(text.slice(start,end));start=end;
    if(chunks.length>9998)throw Error('Dictée trop longue ; transcription conservée sans envoi.');
  }
  if(!chunks.length)chunks.push('');
  const parts:VoicePart[]=chunks.map(piece=>candidate(piece));
  const last=parts[parts.length-1]!;
  if(JSON.stringify(candidate(last.text,attachments)).length<=limit)last.attachments=attachments;
  else if(attachments)parts.push(candidate('',attachments));
  return parts.map((p,index)=>{
    const part={...p,index,count:parts.length};
    if(JSON.stringify(part).length>limit)throw Error('Budget transport vocal dépassé.');
    return part;
  });
}
/** No context is delivered until all chunks of the same recording arrive. */
export function voicePartAssembler(){
  const groups=new Map<string,Map<number,VoicePart>>();
  return {accept(part:VoicePart):VoiceInputMessage|undefined {
    const valid=parseVoicePart(JSON.stringify(part));if(!valid)throw Error('Fragment vocal invalide.');
    const group=groups.get(part.requestId)??new Map<number,VoicePart>();
    const existing=group.values().next().value as VoicePart|undefined;
    const meta=(p:VoicePart)=>JSON.stringify([p.count,p.capturedAt,p.threadIds,p.replyTo,p.threads]);
    if(existing&&meta(existing)!==meta(part))throw Error('Fragments vocaux incompatibles.');
    const prior=group.get(part.index);if(prior&&JSON.stringify(prior)!==JSON.stringify(part))throw Error('Identité de fragment vocal conflictuelle.');
    group.set(part.index,structuredClone(part));groups.set(part.requestId,group);
    if(group.size!==part.count)return;
    const ordered=Array.from({length:part.count},(_,i)=>group.get(i)!);
    if(ordered.some(p=>!p))return;
    return {origin:'human',requestId:part.requestId,capturedAt:part.capturedAt,text:ordered.map(p=>p.text).join(''),threadIds:[...part.threadIds],replyTo:part.replyTo,threads:structuredClone(part.threads),attachments:ordered.map(p=>p.attachments).join('')};
  }};
}

/** A binding is supplied only after the principal confirmed the actual runtime target.
 * Normal agents retain their usual context/tools. Super-thread requires a separate
 * plain-chat backend; a minimal prompt is never treated as disabling native tools. */
export interface VoiceBinding {
  agentRef:string;
  kind:'native'|'plain_chat';
  ingest:(input:{idempotencyKey:string;thread:VoiceThread;message:{id:string;at:string;text:string;origin:'human'|'agent_voice';speaker?:{threadId:VoiceThreadId;agentRef:string;clipId:string};attachments?:string};attention:'addressed'|'fyi';requestResponse:false})=>Promise<void>;
}
export interface VoiceDelivery {threadId:VoiceThreadId;state:'ingested'|'needs_binding'|'requires_plain_chat'|'error'|'uncertain';detail?:string}
/** Only the host peer envelope produced from an immutable .clip can introduce an
 * agent contribution. A human JSON body cannot impersonate another participant. */
export function sharedVoiceInput(message:{id:string;text:string;origin?:{kind:string;channel:string;senderRef:string;messageId:string}},threads:VoiceThread[]):VoiceInputMessage|undefined{
  if(message.origin?.kind!=='peer_message'||message.origin.channel!=='desktop-voice'||!validVoiceThreads(threads))return;
  try{
    const v=JSON.parse(message.text) as {schema?:unknown;playback?:unknown;clipId?:unknown;at?:unknown;text?:unknown;speaker?:{threadId?:unknown;agentRef?:unknown}};
    if(v.schema!=='mind.voice.spoken.v1'||v.playback!=='completed'||typeof v.clipId!=='string'||v.clipId!==message.origin.messageId||message.id!==`shared-inbox:desktop-voice:${v.clipId}`||typeof v.at!=='string'||!Number.isFinite(Date.parse(v.at))||typeof v.text!=='string'||!isVoiceThreadId(v.speaker?.threadId)||typeof v.speaker.agentRef!=='string'||v.speaker.agentRef!==message.origin.senderRef)return;
    return {origin:'agent_voice',requestId:`clip:${v.clipId}`,capturedAt:v.at,text:v.text,speaker:{threadId:v.speaker.threadId,agentRef:v.speaker.agentRef,clipId:v.clipId},threadIds:VOICE_THREAD_IDS.filter(id=>id!==v.speaker!.threadId),replyTo:'none',threads:structuredClone(threads),attachments:''};
  }catch{return;}
}
/** The caller persists receipts and reconciles unknown acknowledgements explicitly.
 * Context ingestion begins concurrently. It never requests a model turn or audio. */
export async function fanoutVoiceMessage(input:VoiceInputMessage,bindings:ReadonlyMap<VoiceThreadId,VoiceBinding>,receipts:Map<string,VoiceDelivery>):Promise<VoiceDelivery[]>{
  return Promise.all(input.threadIds.map(async id=>{
    const key=input.requestId+':'+id,prior=receipts.get(key);if(prior)return {...prior};
    const thread=input.threads.find(t=>t.id===id);if(!thread)throw Error('Fil vocal absent.');
    const binding=bindings.get(id);if(!binding)return {threadId:id,state:'needs_binding' as const};
    if(thread.profile==='tool_free_superthread'&&binding.kind!=='plain_chat')return {threadId:id,state:'requires_plain_chat' as const};
    receipts.set(key,{threadId:id,state:'uncertain'});
    try{
      await binding.ingest({idempotencyKey:key,thread:structuredClone(thread),message:{id:input.requestId,at:input.capturedAt,text:input.text,origin:input.origin,...(input.speaker?{speaker:input.speaker}:{}),...(thread.profile==='normal'?{attachments:input.attachments}:{})},attention:input.replyTo===id?'addressed':'fyi',requestResponse:false});
      const result:VoiceDelivery={threadId:id,state:'ingested'};receipts.set(key,result);return result;
    }catch{const result:VoiceDelivery={threadId:id,state:'error',detail:'Envoi non confirmé ; pas de reprise automatique.'};receipts.set(key,result);return result;}
  }));
}

export type VoiceDecision={kind:'silence'}|{kind:'reply';text:string};
export interface VoiceResponseBinding {kind:'native'|'plain_chat';request:(input:{messageId:string;thread:VoiceThread})=>Promise<VoiceDecision>}
/** This is deliberately a different entry point from ingestion. Only the addressed
 * participant may be asked; FYI and shared agent voices never trigger a response.
 * A reply decision still does not synthesize or autoplay anything. */
export async function requestAddressedVoice(input:VoiceInputMessage,bindings:ReadonlyMap<VoiceThreadId,VoiceResponseBinding>):Promise<{state:'not_requested'|'needs_binding'|'requires_plain_chat'|'decided';threadId?:VoiceThreadId;decision?:VoiceDecision}>{
  if(input.origin!=='human'||!isVoiceThreadId(input.replyTo))return {state:'not_requested'};
  const thread=input.threads.find(t=>t.id===input.replyTo),binding=bindings.get(input.replyTo);
  if(!thread||!binding)return {state:'needs_binding',threadId:input.replyTo};
  if(thread.profile==='tool_free_superthread'&&binding.kind!=='plain_chat')return {state:'requires_plain_chat',threadId:thread.id};
  const decision=await binding.request({messageId:input.requestId,thread:structuredClone(thread)});
  if(decision.kind==='reply'&&!decision.text.trim())throw Error('Réponse vide : choisir explicitement le silence.');
  return {state:'decided',threadId:thread.id,decision};
}

/** Published by the principal only after receiving a real participant response.
 * It retains the owner's channel author; these are speech attribution fields. */
export interface VoiceResponseEnvelope {schema:'mind.voice.reply.v1';threadId:VoiceThreadId;agentRef:string;label:string;cycleId:string;text:string}
export function parseVoiceResponse(text:string):VoiceResponseEnvelope|undefined{
  try{const v=JSON.parse(text) as VoiceResponseEnvelope;
    if(v.schema!=='mind.voice.reply.v1'||!isVoiceThreadId(v.threadId)||typeof v.agentRef!=='string'||!v.agentRef.trim()||v.agentRef.length>128||typeof v.label!=='string'||!v.label.trim()||v.label.length>60||typeof v.cycleId!=='string'||!v.cycleId.trim()||v.cycleId.length>128||typeof v.text!=='string'||!v.text.trim())return;
    return v;
  }catch{return;}
}
export function voiceResponseEnvelope(value:Omit<VoiceResponseEnvelope,'schema'>):string{
  const encoded=JSON.stringify({schema:'mind.voice.reply.v1',...value});
  if(!parseVoiceResponse(encoded))throw Error('Réponse vocale attribuée invalide.');return encoded;
}



