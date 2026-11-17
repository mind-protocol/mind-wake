import { createHumanAudio } from './human-audio.ts';
import { guestRequest } from './human-call-client.ts';
import { transcribeChatVoice, type ChatSession } from './client.ts';
import { createCallVad, levelDb, MUTED_DB } from './call-vad.ts';
import { setCaptureSpeaking } from './voice-intent.ts';
import type { CallLine, CallPhase, CallTuning } from './call-engine.web.ts';

export function createHumanGuest({session,invite,silenceMs,floorDb,onLine,onPhase,onLevel}:{session:ChatSession;invite:{id:string;label:string};silenceMs:number;floorDb?:number;
  onLine:(line:CallLine)=>void;onPhase:(phase:CallPhase)=>void;onLevel:(db:number,threshold:number)=>void}) {
  let stopped=false,muted=false,stream:MediaStream|null=null,context:AudioContext|null=null;
  let hub:ReturnType<typeof createHumanAudio>|null=null,analyser:AnalyserNode|null=null;
  let tick:ReturnType<typeof setInterval>|undefined,timer:ReturnType<typeof setTimeout>|undefined,mime='',answered=false,failures=0;
  let uploads=Promise.resolve();const abort=new AbortController(),vad=createCallVad({silenceMs,floorDb});
  const own=new Set<string>(),pending=new Map<string,{text:string;sentAt:number}>();
  const info=(key:string,text:string)=>{if(!stopped)onLine({key,who:'info',text,detail:'',error:true});};
  function begin() {
    if(stopped||muted||!stream)return;
    const chunks:Blob[]=[];const r=new MediaRecorder(stream,{mimeType:mime,audioBitsPerSecond:48_000});
    r.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    r.onstop=()=>{};
    // Capture this recorder's own chunks; a later segment must never reuse them.
    const submit=()=>{
      const blob=new Blob(chunks,{type:mime});if(!blob.size||blob.size>4*1024*1024||stopped)return;
      uploads=uploads.then(async()=>{
        if(stopped)return;
        try {
          const text=await transcribeChatVoice(session,blob,mime.split(';')[0],abort.signal);if(stopped||!text.trim())return;
          const id=crypto.randomUUID();own.add(id);pending.set(id,{text:text.slice(0,3900),sentAt:0});
          onLine({key:id,who:'me',text,detail:'Transcription en cours de transmission aux agents…'});
          flush();
        }catch(error){if(!stopped)info('human-transcription',`La voix reste en direct, mais la transcription aux agents a échoué : ${String((error as Error).message)}`);}
      });
    };
    finishRecorder=keep=>{if(r.state==='inactive')return;r.onstop=keep?submit:()=>{};r.stop();};
    r.start(250);vad.reset(Date.now());
  }
  let finishRecorder:(keep:boolean)=>void=()=>{};
  function segment(keep:boolean){finishRecorder(keep);begin();}
  function flush() {
    if(stopped)return;
    for(const [id,item] of pending)if(Date.now()-item.sentAt>3000&&hub?.send('host',{type:'utterance',id,text:item.text}))item.sentAt=Date.now();
  }
  async function poll() {
    if(stopped)return;
    try {
      const state=await guestRequest(session,invite.id,'poll',{},abort.signal);failures=0;
      if(stopped)return;if(state.status!=='accepted'){stop();return;}
      if(state.offer&&!answered&&hub) {
        answered=true;const description=await hub.answer('host',state.offer);if(stopped)return;
        await guestRequest(session,invite.id,'signal',{description},abort.signal);
      }
      flush();
    }catch(error){if(!stopped){info('human-connection',String((error as Error).message));if(++failures>=3){stop();return;}}}
    if(!stopped)timer=setTimeout(()=>void poll(),1000);
  }
  function setMuted(next:boolean) {
    if(stopped||next===muted)return muted;
    const keep=vad.speaking;muted=next;
    stream?.getAudioTracks().forEach(t=>{t.enabled=!muted;});
    if(muted){finishRecorder(keep);vad.reset(Date.now());onLevel(MUTED_DB,vad.threshold);}else begin();
    return muted;
  }
  function stop() {
    if(stopped)return;stopped=true;abort.abort();clearInterval(tick);clearTimeout(timer);finishRecorder(false);
    hub?.close();stream?.getTracks().forEach(t=>t.stop());void context?.close().catch(()=>{});pending.clear();
    setCaptureSpeaking(false);onPhase('ended');void guestRequest(session,invite.id,'leave').catch(()=>{});
  }
  return {humanGuest:true,get callId(){return invite.id;},get muted(){return muted;},setMuted,stop,
    configure(next:CallTuning){vad.configure(next);},
    async addTargets(...args: [string[]]):Promise<string[]>{void args;throw new Error('L’appelant gère les agents de cet appel.');},
    async removeTargets(...args: [string[]]):Promise<string[]>{void args;throw new Error('L’appelant gère les agents de cet appel.');},
    async start() {
      onPhase('connecting');
      context=new AudioContext();void context.resume();setCaptureSpeaking(true);
      // Acceptance belongs to this authenticated desktop session, before microphone permission.
      await guestRequest(session,invite.id,'poll',{},abort.signal);if(stopped)return;
      stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(stopped){stream.getTracks().forEach(t=>t.stop());return;}
      if(muted)stream.getAudioTracks().forEach(t=>{t.enabled=false;});
      mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t))??'';
      if(!mime)throw new Error('Format de microphone indisponible.');
      hub=createHumanAudio(context,stream,{onMessage:(_,message)=>{
        if(message.type!=='line'||stopped)return;pending.delete(message.key);
        onLine({...message,who:own.has(message.key)?'me':'them',speaker:message.speaker??(message.who==='me'?invite.label:undefined),detail:''});
      },onState:(_,state)=>{if(stopped)return;if(state==='connected')onPhase('listening');if(state==='failed'){info('human-audio','La liaison audio a été interrompue.');stop();}}});
      analyser=context.createAnalyser();analyser.fftSize=2048;context.createMediaStreamSource(stream).connect(analyser);begin();
      tick=setInterval(()=>{
        if(stopped||!analyser)return;if(muted){onLevel(MUTED_DB,vad.threshold);return;}
        const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);const db=levelDb(samples);onLevel(db,vad.threshold);
        const action=vad.step(db,Date.now());if(action==='speech')onPhase('speaking');
        if(['utterance','cut','discard'].includes(action)){segment(action!=='discard');onPhase('listening');}
      },100);void poll();
    },
  };
}
