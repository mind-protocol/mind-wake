import fs from 'node:fs';import path from 'node:path';
import {expect,it} from 'vitest';
import {DesktopVoiceMode,type VoiceModePolicy} from './voice-mode.js';
function setup(){const root=path.resolve('test-fixtures');fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'voice-mode-'));let now=100000;let policy:VoiceModePolicy={allowed:true,paused:false,forceOff:false};const mode=new DesktopVoiceMode(dir,()=>policy,()=>now);return {mode,dir,tick:(ms:number)=>{now+=ms;},policy:(p:VoiceModePolicy)=>{policy=p;}};}
it('requires a real app producer and explicit Play rather than a microphone or TTS heuristic',()=>{
 const f=setup();expect(f.mode.read()).toMatchObject({source:'desktop-voice-mode',enabled:false,microphoneActive:false,observedAt:0,activeInterlocutors:0});
 const s=f.mode.update({operation:'activate',producerId:'app',microphoneActive:false});expect(s.enabled).toBe(true);expect(s.microphoneActive).toBe(false);expect(()=>f.mode.assertDelivery(s.revision)).toThrow();
 const live=f.mode.update({operation:'heartbeat',producerId:'app',expectedRevision:s.revision,microphoneActive:true});expect(live.revision).not.toBe(s.revision);expect(f.mode.assertDelivery(live.revision).enabled).toBe(true);
});
it('keeps revision stable on a real heartbeat, never refreshes age through reads, and fails closed when stale',()=>{
 const f=setup();const s=f.mode.update({operation:'activate',producerId:'app',microphoneActive:true});f.tick(2000);expect(f.mode.read().observedAt).toBe(s.observedAt);
 const beat=f.mode.update({operation:'heartbeat',producerId:'app',expectedRevision:s.revision,microphoneActive:true});expect(beat.revision).toBe(s.revision);
 f.tick(5001);expect(f.mode.read()).toMatchObject({enabled:false,paused:true});expect(()=>f.mode.assertDelivery(s.revision)).toThrow();
});
it('latches a real Wake pause or Force-off and refuses a stale producer instead of silently resuming',()=>{
 const f=setup();const s=f.mode.update({operation:'activate',producerId:'app',microphoneActive:true});
 f.policy({allowed:false,paused:true,forceOff:true});expect(f.mode.read()).toMatchObject({enabled:false,paused:true,forceOff:true});
 f.policy({allowed:true,paused:false,forceOff:false});expect(f.mode.read().enabled).toBe(false);
 expect(()=>f.mode.update({operation:'heartbeat',producerId:'app',expectedRevision:s.revision,microphoneActive:true})).toThrow('périmé');
 expect(f.mode.update({operation:'activate',producerId:'app',microphoneActive:true}).enabled).toBe(true);
});
it('counts only confirmed recent bindings and never the three configured placeholders',()=>{
 const f=setup();const s=f.mode.update({operation:'activate',producerId:'app',microphoneActive:true});expect(s.activeInterlocutors).toBe(0);
 const bound=f.mode.update({operation:'bindings',bindings:[{threadId:'fil1',agentRef:'/root/actual-one'},{threadId:'fil3',agentRef:'plain-chat:verified'}]});expect(bound.activeInterlocutors).toBe(2);
 f.tick(30001);const beat=f.mode.update({operation:'heartbeat',producerId:'app',expectedRevision:s.revision,microphoneActive:true});expect(beat.activeInterlocutors).toBe(0);
});
it('invalidates late delivery on mic-off and explicit Voice Pause without changing Wake policy',()=>{
 const f=setup();const s=f.mode.update({operation:'activate',producerId:'app',microphoneActive:true});
 const micOff=f.mode.update({operation:'heartbeat',producerId:'app',expectedRevision:s.revision,microphoneActive:false});expect(micOff.revision).not.toBe(s.revision);expect(()=>f.mode.assertDelivery(s.revision)).toThrow();
 const paused=f.mode.update({operation:'pause',producerId:'app',microphoneActive:false});expect(paused).toMatchObject({enabled:false,paused:true,forceOff:false});
});
