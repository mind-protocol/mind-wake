import type { LocalSpeechState } from './local-speech.ts';

const workerSource = `
let pipe;
onmessage = async ({data}) => {
  try {
    if(data.type==='load') {
      const {pipeline,env}=await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1');
      env.allowLocalModels=false;
      env.backends.onnx.wasm.numThreads=1;
      env.backends.onnx.wasm.proxy=false;
      pipe=await pipeline('automatic-speech-recognition','onnx-community/whisper-tiny',{
        revision:'ff4177021cc41f7db950912b73ea4fdf7d01d8e7',device:'wasm',dtype:'q8',
        progress_callback:p=>{if(p.status==='progress')postMessage({type:'progress',progress:Math.round(p.progress||0)});}
      });
      postMessage({type:'ready'});
    } else if(data.type==='audio' && pipe) {
      const result=await pipe(data.audio,{language:'french',task:'transcribe',return_timestamps:false});
      postMessage({type:'result',id:data.id,text:result.text||''});
    }
  } catch {postMessage({type:'error'});}
};`;

/** Model/runtime download only after explicit tap. Audio stays in this browser and its local Worker. */
export function createWasmSpeech(options:{onState:(state:LocalSpeechState)=>void;onTranscript:(text:string)=>void;visible:()=>boolean}) {
  let worker:Worker|null=null;let ready=false;let active=false;let version=0;let recording:MediaRecorder|null=null;
  let stream:MediaStream|null=null;let timer:ReturnType<typeof setTimeout>|undefined;
  let loading:Promise<void>|null=null;let loadResolve:(()=>void)|null=null;let loadReject:((reason:Error)=>void)|null=null;
  let serial=0;let processing=false;const queue:{id:number;version:number;blob:Blob}[]=[];
  const pending=new Map<number,{resolve:(text:string)=>void;reject:(reason:Error)=>void}>();
  const state=(phase:LocalSpeechState['phase'],message:string)=>options.onState({phase,message});
  function pause(message='Micro en pause') {
    active=false;version++;clearTimeout(timer);queue.length=0;
    if(recording?.state!=='inactive')recording?.stop();recording=null;
    stream?.getTracks().forEach(track=>track.stop());stream=null;state('idle',message);
  }
  async function load() {
    if(ready)return;if(loading)return loading;
    state('checking','Téléchargement du moteur et du modèle local sur cet appareil…');
    loading=new Promise<void>((resolve,reject)=>{loadResolve=resolve;loadReject=reject;});
    const url=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'}));
    try {worker=new Worker(url,{type:'module'});}finally{URL.revokeObjectURL(url);}
    worker.onmessage=event=>{
      const data=event.data;
      if(data.type==='ready'){ready=true;loadResolve?.();}
      else if(data.type==='progress'&&!ready)state('checking',`Modèle local · téléchargement ${data.progress} % (fichier en cours)`);
      else if(data.type==='result'){pending.get(data.id)?.resolve(String(data.text));pending.delete(data.id);}
      else if(data.type==='error'){const error=new Error('local_model_failed');loadReject?.(error);pending.forEach(item=>item.reject(error));pending.clear();}
    };
    worker.onerror=()=>{const error=new Error('local_worker_failed');loadReject?.(error);pending.forEach(item=>item.reject(error));pending.clear();};
    worker.postMessage({type:'load'});
    try{await loading;}catch(error){worker.terminate();worker=null;loading=null;throw error;}
  }
  async function processQueue() {
    if(processing)return;processing=true;
    try {
      while(queue.length&&active){
        const item=queue.shift()!;const context=new AudioContext();
        let decoded:AudioBuffer;
        try{decoded=await context.decodeAudioData(await item.blob.arrayBuffer());}finally{await context.close();}
        if(item.version!==version)continue;
        if(decoded.duration>32)throw new Error('duration');
        const offline=new OfflineAudioContext(1,Math.ceil(decoded.duration*16000),16000);
        const source=offline.createBufferSource();source.buffer=decoded;source.connect(offline.destination);source.start();
        const audio=(await offline.startRendering()).getChannelData(0);
        let energy=0;for(const value of audio)energy+=value*value;
        if(Math.sqrt(energy/audio.length)<0.003)continue;
        const text=await new Promise<string>((resolve,reject)=>{pending.set(item.id,{resolve,reject});worker!.postMessage({type:'audio',id:item.id,audio},[audio.buffer]);});
        if(active&&item.version===version&&text.trim())options.onTranscript(text.trim());
      }
    }catch{pause('Moteur local arrêté. Réessaie le micro ; aucun audio envoyé au PC.');}
    finally{processing=false;}
  }
  function segment(currentVersion:number) {
    if(!active||currentVersion!==version||!stream||!options.visible()){pause('Micro suspendu · navigateur en arrière-plan');return;}
    const mime=['audio/webm;codecs=opus','audio/mp4'].find(type=>MediaRecorder.isTypeSupported(type));
    if(!mime){pause('Format audio local indisponible.');return;}
    const current=new MediaRecorder(stream,{mimeType:mime,audioBitsPerSecond:64000});recording=current;
    const chunks:Blob[]=[];let bytes=0;
    current.ondataavailable=event=>{bytes+=event.data.size;if(bytes>4*1024*1024){pause('Tranche audio trop volumineuse.');return;}chunks.push(event.data);};
    current.onerror=()=>pause('Capture micro interrompue par le navigateur.');
    current.onstop=()=>{
      clearTimeout(timer);
      if(!active||currentVersion!==version)return;
      if(queue.length>=2){pause('Le téléphone transcrit trop lentement. Micro en pause pour éviter une file audio croissante.');return;}
      queue.push({id:++serial,version:currentVersion,blob:new Blob(chunks,{type:mime})});
      segment(currentVersion);void processQueue();
    };
    current.start(1000);state('recording','Micro ON · modèle sur cet appareil · 30 s enchaînées');
    timer=setTimeout(()=>{if(current.state==='recording')current.stop();},30000);
  }
  async function start(allowDownload=false) {
    if(active)return;
    if(!globalThis.isSecureContext||!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'||typeof Worker==='undefined'){
      state('unsupported','Micro local indisponible dans ce contexte. HTTPS ou localhost requis.');return;
    }
    if(!ready&&!allowDownload){state('download','Télécharger le modèle français et le moteur WASM sur ce téléphone. Audio traité ici, pas sur le PC.');return;}
    active=true;const currentVersion=++version;
    try{
      await load();if(!active||currentVersion!==version)return;
      const media=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
      if(!active||currentVersion!==version){media.getTracks().forEach(track=>track.stop());return;}
      stream=media;segment(currentVersion);
    }catch{pause('Téléchargement local ou permission micro impossible. Aucun repli distant.');}
  }
  return {start,pause,dispose:()=>{pause();worker?.terminate();worker=null;pending.forEach(item=>item.reject(new Error('disposed')));pending.clear();}};
}
