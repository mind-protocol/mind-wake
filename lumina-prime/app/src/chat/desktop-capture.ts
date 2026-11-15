import { voiceErrorMessage, type createVoiceController, type VoiceRecording, type VoiceClip } from './voice-controller.ts';
/** Continuous capture, bounded queue, sequential desktop uploads, cancellation discards late results. */
export function createDesktopCapture(options: Parameters<typeof createVoiceController>[0]) {
  let wanted=false,disposed=false,generation=0,processing=false;
  let recording:VoiceRecording|null=null;
  let abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const queue:{clip:VoiceClip;generation:number}[]=[];
  const state=(phase:'idle'|'requesting'|'recording'|'transcribing',message:string|null=null)=>options.onState({phase,message});
  function pause(message:string|null=null){wanted=false;generation++;clearTimeout(timer);abort.abort();
    const previous=recording;recording=null;void previous?.cancel();
    for(const item of queue.splice(0))void item.clip.cleanup?.();state('idle',message);}
  async function flush(){
    if(processing)return;processing=true;
    try{while(wanted&&queue.length){const item=queue.shift()!;
      try{const text=await options.transcribe(item.clip,abort.signal);
        if(wanted&&item.generation===generation&&text.trim())options.onTranscript(text.trim());
      }catch(error){if(wanted&&item.generation===generation)pause((options.describeError??voiceErrorMessage)(error));}
      finally{await item.clip.cleanup?.();}
    }}finally{processing=false;if(wanted&&queue.length)void flush();}
  }
  async function capture(version:number){
    if(!wanted||disposed||version!==generation)return;
    try{const rec=await options.begin(abort.signal);
      if(!wanted||version!==generation){await rec.cancel();return;}
      recording=rec;state('recording');
      timer=setTimeout(()=>{void finish(rec,version);},options.maxDurationMs??30_000);
    }catch(error){if(version===generation)pause((options.describeError??voiceErrorMessage)(error));}
  }
  async function finish(rec:VoiceRecording,version:number){
    if(!wanted||version!==generation)return;recording=null;
    try{const clip=await rec.stop();
      if(!wanted||version!==generation){await clip.cleanup?.();return;}
      if(queue.length>=2){await clip.cleanup?.();pause('Transcription trop lente : micro en pause pour limiter la file audio.');return;}
      queue.push({clip,generation:version});
      void capture(version);void flush();
    }catch(error){if(version===generation)pause((options.describeError??voiceErrorMessage)(error));}
  }
  return{
    async start(){if(wanted||disposed)return;wanted=true;const version=++generation;abort=new AbortController();state('requesting');await capture(version);},
    pause(){pause('Micro en pause. Aucun nouvel audio envoyé.');},
    dispose(){disposed=true;pause();},
  };
}
