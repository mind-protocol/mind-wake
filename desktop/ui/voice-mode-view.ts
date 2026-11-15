export interface VoiceModeState {
  source:'desktop-voice-mode';enabled:boolean;microphoneActive:boolean;paused:boolean;forceOff:boolean;
  revision:string;observedAt:number;producerId:string|null;activeInterlocutors:number;
  bindings:{threadId:'fil1'|'fil2'|'fil3';agentRef:string;observedAt:number}[];
}
type Invoke=(command:string,args?:Record<string,unknown>)=>Promise<unknown>;
/** Reçoit l'état Voice Mode relu (undefined si illisible) et si une bascule est en cours. */
export type VoiceModeListener=(state:VoiceModeState|undefined,switching:boolean)=>void;
/** Coupe la dictée seulement si Voice Mode vient de s'éteindre ou si Wake est arrêté.
 * Voice Mode jamais allumé se lit aussi « en pause » : la dictée simple doit continuer. */
export function voiceModeStopsDictation(previous:VoiceModeState|undefined,next:VoiceModeState):boolean{
  return next.forceOff||(previous?.enabled===true&&(!next.enabled||next.paused));
}
/** No profile state is guessed from recent messages, TTS settings or a template. */
export function mountVoiceMode(invoke:Invoke,options:{microphoneActive:()=>boolean;startMicrophone:()=>Promise<void>;stopMicrophone:(discard:boolean)=>void;changed?:(state:VoiceModeState)=>void}){
  const button=document.getElementById('voice-mode-toggle') as HTMLButtonElement;
  const status=document.getElementById('voice-mode-status')!;
  const badge=document.getElementById('voice-interlocutors')!;
  const producerId=crypto.randomUUID();let state:VoiceModeState|undefined,busy=false,disposed=false,switching=false;
  const listeners=new Set<VoiceModeListener>();
  const notify=()=>{for(const listener of [...listeners])listener(state,switching);};
  const call=async(payload?:unknown):Promise<VoiceModeState>=>{
    const run=await invoke('elevenlabs',{action:'voice_mode_state',...(payload===undefined?{}:{payload})}) as {stdout:string;exitCode:number};
    const envelope=JSON.parse(run.stdout) as {ok:boolean;data:VoiceModeState;error?:{message:string}};
    if(!envelope.ok||run.exitCode!==0)throw Error(envelope.error?.message??'Voice Mode indisponible.');return envelope.data;
  };
  const render=(next:VoiceModeState)=>{
    state=next;button.textContent=next.enabled?'Pause':'Play';button.setAttribute('aria-pressed',String(next.enabled));
    status.textContent=next.forceOff?'Wake arrêté':next.paused?'Voice Mode en pause':next.microphoneActive?'Voice Mode actif':'Voice Mode actif · micro arrêté';
    badge.textContent=String(next.activeInterlocutors);badge.title=`${next.activeInterlocutors} interlocuteur(s) raccordé(s) récemment`;
    for(const id of ['fil1','fil2','fil3']){const mark=document.getElementById(`voice-marker-${id}`);if(mark)mark.dataset['connected']=String(next.bindings.some(b=>b.threadId===id));}
    options.changed?.(next);notify();
    if(!next.enabled||next.paused||next.forceOff)window.dispatchEvent(new Event('voice-mode-off'));
  };
  async function refresh(){if(busy||disposed)return;busy=true;try{
    if(state?.enabled&&state.producerId===producerId)render(await call({operation:'heartbeat',producerId,expectedRevision:state.revision,microphoneActive:options.microphoneActive()}));
    else render(await call());
  }catch(error){status.textContent=String(error);state=undefined;notify();window.dispatchEvent(new Event('voice-mode-off'));}finally{busy=false;}}
  async function pause(discard=false){
    window.dispatchEvent(new Event('voice-mode-off'));options.stopMicrophone(discard);
    const next=await call({operation:'pause',producerId,microphoneActive:false});render(next);
  }
  async function activate(){
    render(await call({operation:'activate',producerId,microphoneActive:options.microphoneActive()}));
    if(!state?.enabled||state.paused||state.forceOff)throw Error('Voice Mode suspendu avant activation du micro.');
    await options.startMicrophone();
    render(await call({operation:'heartbeat',producerId,expectedRevision:state!.revision,microphoneActive:options.microphoneActive()}));
  }
  /** Même garde que Play/Pause : une seule bascule à la fois, erreurs affichées dans le statut. */
  async function guarded(task:()=>Promise<void>){if(busy)return;busy=true;switching=true;button.disabled=true;notify();
    try{await task();}catch(error){status.textContent=String(error);window.dispatchEvent(new Event('voice-mode-off'));}finally{busy=false;switching=false;button.disabled=false;notify();}
  }
  button.addEventListener('click',()=>void guarded(()=>state?.enabled?pause(false):activate()));
  /** Bascule globale (Réglages). Off coupe tout de suite, comme le bouton Pause de l'en-tête :
   * micro arrêté et prise abandonnée, lecture Voice coupée, même si un rafraîchissement est en cours. */
  async function setEnabled(on:boolean){
    if(!on){try{await pause(true);}catch(error){status.textContent=String(error);notify();}return;}
    await guarded(()=>state?.enabled?Promise.resolve():activate());
  }
  const subscribe=(listener:VoiceModeListener)=>{listeners.add(listener);listener(state,switching);return ()=>{listeners.delete(listener);};};
  const timer=window.setInterval(()=>void refresh(),2000);void refresh();
  return {state:()=>state,pause,setEnabled,subscribe,microphoneChanged:()=>void refresh(),dispose:()=>{disposed=true;listeners.clear();window.clearInterval(timer);}};
}
