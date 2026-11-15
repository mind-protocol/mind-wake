import {VOICE_THREAD_IDS,isVoiceThreadId,type VoiceThreadId,type VoiceThread} from './voice-conversations.js';
export const VOICE_START_SPACING_MS=30_000;
export type VoicePhase='waiting'|'silent'|'preparing'|'ready'|'playing'|'ended'|'error'|'cancelled';
export type VoiceCycleEvent=
  | {kind:'context';cycleId:string;bindings:{threadId:VoiceThreadId;agentRef:string}[];at:number}
  | {kind:'state';cycleId:string;threadId:VoiceThreadId;phase:VoicePhase;at:number;clipId?:string}
  | {kind:'playback';threadId:VoiceThreadId;clipId:string;at:number;elapsed:number;duration:number}
  | {kind:'stop';at:number};
interface ThreadState {phase:VoicePhase;at:number;preparingAt?:number;clipId?:string;elapsed?:number;duration?:number;progressAt?:number}
export interface VoiceCycleSnapshot {cycleId:string|null;paused:boolean;threads:Record<VoiceThreadId,ThreadState>;active:VoiceThreadId|null;fraction:number|null;estimate:string}
const emptyThreads=()=>Object.fromEntries(VOICE_THREAD_IDS.map(id=>[id,{phase:'waiting',at:0}])) as Record<VoiceThreadId,ThreadState>;
/** Presentation model only: it never starts a model, synthesizes audio, or assumes an answer. */
export function voiceCycleModel(){
  let cycleId:string|null=null,paused=false,threads=emptyThreads(),lastStart:number|undefined;
  const preparationMean=new Map<VoiceThreadId,number>();
  return {
    event(event:VoiceCycleEvent):boolean {
      if(!Number.isFinite(event.at))return false;
      if(event.kind==='stop'){paused=true;return true;}
      if(event.kind==='context'){
        if(!Array.isArray(event.bindings))return false;
        if(!event.cycleId||event.bindings.length!==3||new Set(event.bindings.map(b=>b.threadId)).size!==3||event.bindings.some(b=>!isVoiceThreadId(b.threadId)||!b.agentRef.trim()))return false;
        cycleId=event.cycleId;paused=false;threads=emptyThreads();return true;
      }
      if(paused||!cycleId||!isVoiceThreadId(event.threadId))return false;
      const current=threads[event.threadId];
      if(event.kind==='playback'){
        if(current.phase!=='playing'||current.clipId!==event.clipId||!Number.isFinite(event.duration)||event.duration<=0||!Number.isFinite(event.elapsed)||event.elapsed<0)return false;
        current.elapsed=Math.min(event.duration,event.elapsed);current.duration=event.duration;current.progressAt=event.at;return true;
      }
      if(event.cycleId!==cycleId||!['waiting','silent','preparing','ready','playing','ended','error','cancelled'].includes(event.phase))return false;
      if(event.phase==='ready'&&((current.clipId===event.clipId&&['ready','playing','ended'].includes(current.phase))||current.phase==='playing'))return false;
      if(event.phase==='playing'&&VOICE_THREAD_IDS.some(id=>id!==event.threadId&&threads[id].phase==='playing'))return false;
      const preparingAt=event.phase==='preparing'?event.at:current.preparingAt;
      if(event.phase==='ready'&&preparingAt!==undefined&&event.at>=preparingAt){const duration=event.at-preparingAt,previous=preparationMean.get(event.threadId);preparationMean.set(event.threadId,previous===undefined?duration:(previous+duration)/2);}
      threads[event.threadId]={phase:event.phase,at:event.at,...(preparingAt===undefined?{}:{preparingAt}),...(event.clipId?{clipId:event.clipId}:{})};
      if(event.phase==='playing')lastStart=event.at;
      return true;
    },
    snapshot(now=Date.now()):VoiceCycleSnapshot {
      const active=paused?null:VOICE_THREAD_IDS.find(id=>threads[id].phase==='playing')??VOICE_THREAD_IDS.find(id=>threads[id].phase==='preparing')??VOICE_THREAD_IDS.find(id=>threads[id].phase==='ready')??null;
      let fraction:number|null=null;
      if(active){const state=threads[active];if(state.phase==='playing'&&state.elapsed!==undefined&&state.duration)fraction=Math.min(1,state.elapsed/state.duration);else if(state.phase==='preparing'&&state.preparingAt!==undefined&&preparationMean.has(active))fraction=Math.min(.95,Math.max(0,(now-state.preparingAt)/preparationMean.get(active)!));else if(state.phase==='ready')fraction=1;}
      const third=threads.fil3;let estimate='Estimation indisponible';
      if(paused)estimate='Échange arrêté';
      else if(!cycleId)estimate='Pas d’échange vocal confirmé';
      else if(third.phase==='waiting'||third.phase==='silent')estimate='Fil 3 · en attente volontaire, aucun délai prévu';
      else if(third.phase==='playing')estimate='Fil 3 · en lecture';
      else if(third.phase==='ended')estimate='Fil 3 · vocal terminé';
      else if(third.phase==='ready'){
        if(VOICE_THREAD_IDS.some(id=>threads[id].phase==='playing'))estimate='Fil 3 · prêt, parole espacée';
        else {const delay=lastStart===undefined?0:Math.max(0,lastStart+VOICE_START_SPACING_MS-now);estimate=delay?`Fil 3 · prêt, passage estimé dans ${Math.ceil(delay/1000)} s`:'Fil 3 · vocal prêt';}
      }else if(third.phase==='preparing'&&third.preparingAt!==undefined&&preparationMean.has('fil3')){
        const left=third.preparingAt+preparationMean.get('fil3')!-now;
        estimate=left>0?`Fil 3 · préparation, environ ${Math.ceil(left/1000)} s (estimation)`:'Fil 3 · préparation, estimation indisponible';
      }
      return {cycleId,paused,threads:structuredClone(threads),active,fraction,estimate};
    },
  };
}
export const VOICE_PILL_ERROR_MS=4_000;
export type VoicePillTone='listening'|'transcribing'|'reply'|'error';
/** What the single voice pill shows; hidden when idle. Pure: no DOM, no clock. */
export interface VoicePill {visible:boolean;tone:VoicePillTone|null;label:string;badge:number|null;detail:string}
const replyPhase:Partial<Record<VoicePhase,string>>={preparing:'en préparation',ready:'prête',playing:'en lecture'};
export function voicePillState(input:{listening:boolean;pending:number;snapshot:VoiceCycleSnapshot;labels:VoiceThread[];errorUntil?:number;now:number}):VoicePill{
  const pending=Number.isSafeInteger(input.pending)&&input.pending>0?input.pending:0,badge=pending>=2?pending:null;
  if(input.listening)return {visible:true,tone:'listening',label:'J’écoute',badge:null,detail:'micro actif'};
  if(pending)return {visible:true,tone:'transcribing',label:'Transcription',badge,detail:badge?`${badge} extraits en attente`:'1 extrait en attente'};
  const active=input.snapshot.active;
  if(active){const name=input.labels.find(t=>t.id===active)?.label.trim();return {visible:true,tone:'reply',label:name?`Réponse · ${name}`:'Réponse',badge:null,detail:replyPhase[input.snapshot.threads[active].phase]??''};}
  if(input.errorUntil!==undefined&&input.now<input.errorUntil)return {visible:true,tone:'error',label:'Échec',badge:null,detail:'le vocal n’a pas abouti'};
  return {visible:false,tone:null,label:'',badge:null,detail:''};
}
/** One pill replaces the former three-arc circle; keeps event()/dispose() and adds listening()/transcribing(). */
export function mountVoiceCycle(host:HTMLElement,labels:()=>VoiceThread[]){
  const model=voiceCycleModel(),region=document.createElement('div'),pill=document.createElement('span'),label=document.createElement('span'),badge=document.createElement('span'),detail=document.createElement('span');
  region.className='voice-pill-region';region.setAttribute('role','status');region.setAttribute('aria-live','polite');region.setAttribute('aria-atomic','true');
  pill.className='voice-pill';label.className='voice-pill-label';badge.className='voice-pill-badge';badge.setAttribute('aria-hidden','true');detail.className='voice-pill-detail';
  pill.append(label,badge,detail);region.append(pill);host.append(region);
  let listening=false,pending=0,errorUntil:number|undefined,timer:number|undefined;
  const set=(node:HTMLElement,text:string)=>{if(node.textContent!==text)node.textContent=text;};
  function render(){
    const now=Date.now(),state=voicePillState({listening,pending,snapshot:model.snapshot(now),labels:labels(),...(errorUntil===undefined?{}:{errorUntil}),now});
    pill.hidden=!state.visible;badge.hidden=state.badge===null;
    if(state.tone)pill.dataset['tone']=state.tone;else delete pill.dataset['tone'];
    set(label,state.label);set(badge,state.badge===null?'':String(state.badge));set(detail,state.detail?` · ${state.detail}`:'');
  }
  const clearTimer=()=>{if(timer!==undefined){window.clearTimeout(timer);timer=undefined;}};
  render();
  return {
    event:(event:VoiceCycleEvent)=>{
      const accepted=model.event(event);
      if(accepted&&event.kind==='state'&&event.phase==='error'){errorUntil=Date.now()+VOICE_PILL_ERROR_MS;clearTimer();timer=window.setTimeout(()=>{timer=undefined;errorUntil=undefined;render();},VOICE_PILL_ERROR_MS);}
      if(accepted&&(event.kind==='stop'||event.kind==='context')){errorUntil=undefined;clearTimer();}
      render();return accepted;
    },
    listening:(active:boolean)=>{listening=active;render();},
    transcribing:(count:number)=>{pending=count;render();},
    dispose:()=>{clearTimer();region.remove();},
  };
}


