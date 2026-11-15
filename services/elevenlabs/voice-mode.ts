import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {openStoreReadOnly} from '../../src/store/index.js';
import {controlDbPath} from '../../src/daemon/paths.js';
import {resolvePolicy} from '../../src/policy/index.js';
import {DEFAULT_PROFILE_ID} from '../../src/cli/context.js';
export interface VoiceModePolicy {allowed:boolean;paused:boolean;forceOff:boolean}
export interface LiveVoiceBinding {threadId:'fil1'|'fil2'|'fil3';agentRef:string;observedAt:number}
export interface VoiceModeSnapshot {source:'desktop-voice-mode';enabled:boolean;microphoneActive:boolean;paused:boolean;forceOff:boolean;revision:string;observedAt:number;producerId:string|null;activeInterlocutors:number;bindings:LiveVoiceBinding[]}
function canonicalPolicy(dir:string):VoiceModePolicy{
  const flagged=fs.existsSync(path.join(dir,'emergency-stop.flag'));
  try{const store=openStoreReadOnly(controlDbPath(dir));try{const p=store.uow.profiles.get(DEFAULT_PROFILE_ID);const forceOff=flagged||p?.emergencyStopLocked===true;const paused=!p||['paused','checkpointing','stopped','disabled'].includes(p.state);const allowed=!!p&&!forceOff&&!paused&&resolvePolicy(store.uow.policies,DEFAULT_PROFILE_ID).status==='active';return {allowed,paused:paused||!allowed,forceOff};}finally{store.close();}}catch{return {allowed:false,paused:true,forceOff:flagged};}
}
/** Only the new desktop's explicit Play/Pause/heartbeat is a producer. Reads never
 * refresh observedAt. Missing/old app => disabled, regardless of microphone/TTS. */
export class DesktopVoiceMode {
  constructor(readonly dir:string,private policy:()=>VoiceModePolicy=()=>canonicalPolicy(dir),private now:()=>number=Date.now){}
  private file(){return path.join(this.dir,'desktop-voice-mode.json');}
  private empty():VoiceModeSnapshot{return {source:'desktop-voice-mode',enabled:false,microphoneActive:false,paused:true,forceOff:false,revision:'absent',observedAt:0,producerId:null,activeInterlocutors:0,bindings:[]};}
  private raw():VoiceModeSnapshot{
    try{const file=this.file(),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error();const v=JSON.parse(fs.readFileSync(file,'utf8')) as VoiceModeSnapshot;if(v.source!=='desktop-voice-mode'||typeof v.enabled!=='boolean'||typeof v.microphoneActive!=='boolean'||typeof v.paused!=='boolean'||typeof v.revision!=='string'||!Number.isFinite(v.observedAt)||!Array.isArray(v.bindings))throw Error();return v;}catch{return this.empty();}
  }
  private save(state:VoiceModeSnapshot){fs.mkdirSync(this.dir,{recursive:true});const temporary=this.file()+'.'+randomUUID()+'.tmp';fs.writeFileSync(temporary,JSON.stringify(state),{flag:'wx',mode:0o600});fs.renameSync(temporary,this.file());}
  read():VoiceModeSnapshot{
    const policy=this.policy();let state=this.raw();
    // A real policy stop latches off; an old heartbeat cannot silently resume it.
    if(!policy.allowed&&state.enabled){state={...state,enabled:false,paused:true,revision:randomUUID()};this.save(state);}
    const fresh=state.observedAt>0&&this.now()-state.observedAt<=5000&&this.now()>=state.observedAt;
    const bindings=state.bindings.filter(b=>b&&typeof b==='object'&&['fil1','fil2','fil3'].includes(b.threadId)&&typeof b.agentRef==='string'&&!!b.agentRef.trim()&&Number.isFinite(b.observedAt)&&this.now()-b.observedAt>=0&&this.now()-b.observedAt<=30000);
    return {...state,enabled:state.enabled&&policy.allowed&&fresh,paused:state.paused||!policy.allowed||!fresh,forceOff:policy.forceOff,revision:state.revision+(!policy.allowed?':policy':!fresh?':stale':''),activeInterlocutors:state.enabled&&policy.allowed&&fresh?new Set(bindings.map(b=>b.threadId)).size:0,bindings};
  }
  update(input:unknown):VoiceModeSnapshot{
    if(!input||typeof input!=='object')throw Error('ElevenLabs : état Voice Mode invalide.');const v=input as Record<string,unknown>;
    const operation=v['operation'];let state=this.raw();const policy=this.policy();
    if(operation==='bindings'){
      if(!Array.isArray(v['bindings'])||v['bindings'].length>3)throw Error('ElevenLabs : bindings vocaux invalides.');
      const bindings:LiveVoiceBinding[]=v['bindings'].map((raw:unknown)=>{const b=raw as Record<string,unknown>;if(!b||!['fil1','fil2','fil3'].includes(String(b['threadId']))||typeof b['agentRef']!=='string'||!b['agentRef'].trim()||b['agentRef'].length>128)throw Error('ElevenLabs : binding vocal invalide.');return {threadId:b['threadId'] as LiveVoiceBinding['threadId'],agentRef:b['agentRef'],observedAt:this.now()};});
      if(new Set(bindings.map(b=>b.threadId)).size!==bindings.length)throw Error('ElevenLabs : binding vocal dupliqué.');
      state={...state,bindings};this.save(state);return this.read();
    }
    if(typeof v['producerId']!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(v['producerId'])||typeof v['microphoneActive']!=='boolean')throw Error('ElevenLabs : producteur Voice Mode invalide.');
    if(operation==='activate'){
      if(!policy.allowed)throw Error('Wake : Voice Mode indisponible pendant la pause ou l’arrêt.');
      state={...state,enabled:true,paused:false,microphoneActive:v['microphoneActive'],producerId:v['producerId'],observedAt:this.now(),revision:randomUUID()};
    }else if(operation==='pause'){
      state={...state,enabled:false,paused:true,microphoneActive:v['microphoneActive'],producerId:v['producerId'],observedAt:this.now(),revision:randomUUID()};
    }else if(operation==='heartbeat'){
      if(v['expectedRevision']!==state.revision||v['producerId']!==state.producerId)throw Error('ElevenLabs : état Voice Mode périmé.');
      state={...state,microphoneActive:v['microphoneActive'],observedAt:this.now(),...(state.microphoneActive!==v['microphoneActive']?{revision:randomUUID()}: {})};
    }else throw Error('ElevenLabs : opération Voice Mode invalide.');
    this.save(state);return this.read();
  }
  assertDelivery(expectedRevision:string){const state=this.read();if(!state.enabled||!state.microphoneActive||state.paused||state.forceOff||state.revision!==expectedRevision)throw Error('Wake : Voice Mode désactivé ou révision périmée.');return state;}
}

