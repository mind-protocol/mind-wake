/** Human pause has priority over automatic echo suppression/resumption. */
const listeners=new Set<(value:boolean)=>void>();let speakingNow=false;
/** Synchronous: stop microphone tracks before the TTS engine starts speaking. */
export function setCaptureSpeaking(value:boolean){speakingNow=value;listeners.forEach(listener=>listener(value));}
export function subscribeCaptureSpeaking(listener:(value:boolean)=>void){listeners.add(listener);listener(speakingNow);return()=>{listeners.delete(listener);};}
export function createVoiceIntent(control:{start:(download?:boolean)=>Promise<void>;pause:(message?:string)=>void}) {
  let wanted=false;let speaking=false;
  return {
    async start(download=false) {wanted=true;if(!speaking)await control.start(download);},
    pause(){wanted=false;control.pause();},
    setSpeaking(value:boolean){speaking=value;if(value)control.pause('Micro suspendu · Marco parle');else if(wanted)void control.start();},
    hidden(){control.pause('Micro suspendu · navigateur en arrière-plan');},
    visible(){if(wanted&&!speaking)void control.start();},
  };
}
