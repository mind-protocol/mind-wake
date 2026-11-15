import {afterEach,expect,it,vi} from 'vitest';
import {mountVoiceCycle,voiceCycleModel,voicePillState,VOICE_PILL_ERROR_MS} from './voice-cycle.js';
import {defaultVoiceThreads} from './voice-conversations.js';
const bindings=[{threadId:'fil1' as const,agentRef:'one'},{threadId:'fil2' as const,agentRef:'two'},{threadId:'fil3' as const,agentRef:'three'}];
it('shows no estimate or moving model progress without a real confirmed exchange',()=>{
 const model=voiceCycleModel();expect(model.snapshot().estimate).toContain('Pas d’échange');expect(model.snapshot().fraction).toBeNull();
 expect(model.event({kind:'context',cycleId:'c',bindings:bindings.slice(0,2),at:0})).toBe(false);
 expect(model.event({kind:'context',cycleId:'c',bindings,at:0})).toBe(true);
 expect(model.snapshot(100000).estimate).toContain('aucun délai prévu');expect(model.snapshot().fraction).toBeNull();
});
it('keeps silence distinct from preparation and ready distinct from audible playback',()=>{
 const m=voiceCycleModel();m.event({kind:'context',cycleId:'c',bindings,at:0});m.event({kind:'state',cycleId:'c',threadId:'fil3',phase:'silent',at:1});
 expect(m.snapshot(100).estimate).toContain('attente volontaire');
 m.event({kind:'state',cycleId:'c',threadId:'fil3',phase:'preparing',at:100});expect(m.snapshot(500).estimate).toBe('Estimation indisponible');
 m.event({kind:'state',cycleId:'c',threadId:'fil3',phase:'ready',clipId:'three',at:1000});expect(m.snapshot(1100).threads.fil3.phase).toBe('ready');expect(m.snapshot(1100).estimate).toContain('prêt');
});
it('uses measured historical preparation only as an explicit bounded estimate and never invents completion',()=>{
 const m=voiceCycleModel();m.event({kind:'context',cycleId:'old',bindings,at:0});m.event({kind:'state',cycleId:'old',threadId:'fil3',phase:'preparing',at:0});m.event({kind:'state',cycleId:'old',threadId:'fil3',phase:'ready',clipId:'old',at:10000});
 m.event({kind:'context',cycleId:'new',bindings,at:20000});m.event({kind:'state',cycleId:'new',threadId:'fil3',phase:'preparing',at:20000});
 expect(m.snapshot(25000).estimate).toContain('(estimation)');expect(m.snapshot(40000).threads.fil3.phase).toBe('preparing');expect(m.snapshot(40000).fraction).toBeLessThan(1);
});
it('uses actual media time, rejects overlap, and stops ticking estimates on Stop',()=>{
 const m=voiceCycleModel();m.event({kind:'context',cycleId:'c',bindings,at:0});m.event({kind:'state',cycleId:'c',threadId:'fil1',phase:'playing',clipId:'one',at:100});
 expect(m.event({kind:'state',cycleId:'c',threadId:'fil2',phase:'playing',clipId:'two',at:200})).toBe(false);
 m.event({kind:'playback',threadId:'fil1',clipId:'one',at:500,elapsed:4,duration:10});expect(m.snapshot(500).fraction).toBe(.4);
 m.event({kind:'state',cycleId:'c',threadId:'fil3',phase:'ready',clipId:'three',at:600});expect(m.snapshot(600).estimate).toContain('prêt');
 m.event({kind:'stop',at:700});expect(m.snapshot(20000)).toMatchObject({paused:true,active:null,fraction:null,estimate:'Échange arrêté'});
});
const labels=defaultVoiceThreads();
const idle=()=>voiceCycleModel().snapshot(0);
it('pill: hidden when idle, then J’écoute > Transcription > Réponse, badge only from 2 pending extracts',()=>{
 expect(voicePillState({listening:false,pending:0,snapshot:idle(),labels,now:0})).toMatchObject({visible:false,label:'',badge:null});
 expect(voicePillState({listening:true,pending:3,snapshot:idle(),labels,now:0})).toMatchObject({visible:true,tone:'listening',label:'J’écoute',badge:null});
 expect(voicePillState({listening:false,pending:1,snapshot:idle(),labels,now:0})).toMatchObject({tone:'transcribing',label:'Transcription',badge:null});
 expect(voicePillState({listening:false,pending:2,snapshot:idle(),labels,now:0})).toMatchObject({tone:'transcribing',badge:2,detail:'2 extraits en attente'});
 expect(voicePillState({listening:false,pending:Number.NaN,snapshot:idle(),labels,now:0}).visible).toBe(false);
 const m=voiceCycleModel();m.event({kind:'context',cycleId:'c',bindings,at:0});m.event({kind:'state',cycleId:'c',threadId:'fil2',phase:'preparing',at:1});
 expect(voicePillState({listening:false,pending:0,snapshot:m.snapshot(2),labels,now:2})).toMatchObject({tone:'reply',label:'Réponse · Fil 2',detail:'en préparation'});
 expect(voicePillState({listening:false,pending:2,snapshot:m.snapshot(2),labels,now:2}).tone).toBe('transcribing');
 m.event({kind:'state',cycleId:'c',threadId:'fil2',phase:'ended',at:3});
 expect(voicePillState({listening:false,pending:0,snapshot:m.snapshot(4),labels,now:4}).visible).toBe(false);
 m.event({kind:'state',cycleId:'c',threadId:'fil1',phase:'playing',clipId:'one',at:5});m.event({kind:'stop',at:6});
 expect(voicePillState({listening:false,pending:0,snapshot:m.snapshot(7),labels,now:7}).visible).toBe(false);
 expect(voicePillState({listening:false,pending:0,snapshot:idle(),labels,errorUntil:10,now:9})).toMatchObject({tone:'error',label:'Échec'});
 expect(voicePillState({listening:false,pending:0,snapshot:idle(),labels,errorUntil:10,now:10}).visible).toBe(false);
});
class Node {
 className='';hidden=false;dataset:Record<string,string>={};attributes:Record<string,string>={};children:Node[]=[];parent:Node|undefined;private text='';
 get textContent():string{return this.text+this.children.map(c=>c.textContent).join('');}
 set textContent(v:string){this.text=v;this.children=[];}
 setAttribute(k:string,v:string){this.attributes[k]=v;}
 append(...nodes:Node[]){for(const n of nodes){n.parent=this;this.children.push(n);}}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);}
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('mounts one polite pill (no SVG), fed by listening/transcribing/events, with a brief Échec and clean dispose',()=>{
 vi.useFakeTimers();vi.setSystemTime(1000);
 const created:string[]=[];
 vi.stubGlobal('document',{createElement:(tag:string)=>{created.push(tag);return new Node();},createElementNS:()=>{throw Error('no SVG expected');}});
 vi.stubGlobal('window',{setTimeout:(f:()=>void,ms:number)=>setTimeout(f,ms),clearTimeout:(id:number)=>{clearTimeout(id);},setInterval:()=>{throw Error('no interval expected');}});
 const host=new Node(),ui=mountVoiceCycle(host as unknown as HTMLElement,()=>labels);
 const region=host.children[0]!,pill=region.children[0]!,[label,badge]=pill.children as [Node,Node,Node];
 expect(host.children).toHaveLength(1);expect(region.attributes).toMatchObject({role:'status','aria-live':'polite'});expect(pill.hidden).toBe(true);
 ui.listening(true);expect(pill.hidden).toBe(false);expect(label.textContent).toBe('J’écoute');expect(pill.dataset['tone']).toBe('listening');
 ui.listening(false);ui.transcribing(1);expect(label.textContent).toBe('Transcription');expect(badge.hidden).toBe(true);
 ui.transcribing(3);expect(badge.hidden).toBe(false);expect(badge.textContent).toBe('3');expect(region.textContent).toContain('3 extraits en attente');
 ui.transcribing(0);expect(pill.hidden).toBe(true);
 expect(ui.event({kind:'context',cycleId:'c',bindings,at:Date.now()})).toBe(true);expect(pill.hidden).toBe(true);
 ui.event({kind:'state',cycleId:'c',threadId:'fil3',phase:'playing',clipId:'x',at:Date.now()});expect(label.textContent).toBe('Réponse · Fil 3');
 ui.event({kind:'state',cycleId:'c',threadId:'fil3',phase:'error',at:Date.now()});expect(label.textContent).toBe('Échec');expect(pill.dataset['tone']).toBe('error');
 vi.advanceTimersByTime(VOICE_PILL_ERROR_MS);expect(pill.hidden).toBe(true);expect(pill.dataset['tone']).toBeUndefined();
 ui.dispose();expect(host.children).toHaveLength(0);expect(created).not.toContain('svg');
});
