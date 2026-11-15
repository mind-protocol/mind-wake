import {afterEach,expect,it,vi} from 'vitest';
import {voiceInput,type VoiceRecorder} from './voice-input.js';
afterEach(()=>vi.useRealTimers());
const flush=()=>vi.advanceTimersByTimeAsync(0);
function setup(){
 vi.useFakeTimers();vi.setSystemTime(0);
 let release:((text:string)=>void)|undefined,hold=false;
 const microphone=vi.fn<()=>Promise<{stop():void;activate?():void}>>(async()=>({stop:vi.fn()})),recorders:VoiceRecorder[]=[],state=vi.fn(),send=vi.fn(async(_t:string,_i:string[],_m:unknown)=>{});
 const transcribe=vi.fn(async()=>hold?new Promise<string>(r=>{release=r;}):'texte de la session');
 const controller=voiceInput({microphone,recorder:()=>{const recorder:VoiceRecorder={start:()=>{},stop:()=>{recorder.ondataavailable?.call(recorder as MediaRecorder,{data:new Blob(['voice'])}as BlobEvent);recorder.onstop?.call(recorder as MediaRecorder,new Event('stop'));},ondataavailable:null,onstop:null,onerror:null};recorders.push(recorder);return recorder;},snapshot:async()=> 'screen',transcribe,send,state});
 return{controller,microphone,recorders,state,send,transcribe,hold:()=>{hold=true;},release:()=>{hold=false;release?.('ancien texte');}};
}
it('restarts capture on the second click while the previous final screenshot is still waiting',async()=>{
 const f=setup();await f.controller.start();await vi.advanceTimersByTimeAsync(3000);f.controller.stop();const restarting=f.controller.start();await flush();
 try{expect(f.microphone).toHaveBeenCalledTimes(2);expect(f.controller.active()).toBe(true);expect(f.state.mock.calls.at(-1)?.[0]).toBe(true);}finally{await vi.advanceTimersByTimeAsync(7000);await restarting;f.controller.stop(true);await f.controller.settled();}
});
it('restarts capture while a previous STT call is delayed, keeping the old result in order',async()=>{
 const f=setup();f.hold();await f.controller.start();await vi.advanceTimersByTimeAsync(3000);f.controller.stop();await vi.advanceTimersByTimeAsync(7000);expect(f.transcribe).toHaveBeenCalledOnce();
 const restarting=f.controller.start();await flush();
 try{expect(f.microphone).toHaveBeenCalledTimes(2);expect(f.state.mock.calls.at(-1)?.[0]).toBe(true);}finally{f.release();await restarting;await flush();f.controller.stop();await vi.advanceTimersByTimeAsync(10000);await f.controller.settled();}
 expect(f.send.mock.calls[0]?.[0]).toBe('ancien texte');expect(f.send.mock.calls[1]?.[0]).toBe('texte de la session');
});
it('does not resurrect a discarded STT result when a fresh capture starts',async()=>{
 const f=setup();f.hold();await f.controller.start();await vi.advanceTimersByTimeAsync(3000);f.controller.stop();await vi.advanceTimersByTimeAsync(7000);
 f.controller.stop(true);await f.controller.start();f.release();await flush();expect(f.send).not.toHaveBeenCalled();expect(f.controller.active()).toBe(true);
 f.controller.stop();await vi.advanceTimersByTimeAsync(10000);await f.controller.settled();expect(f.send).toHaveBeenCalledOnce();
});
it('does not let a stale microphone permission resolution replace the latest capture',async()=>{
 let firstResolve!:(m:{stop:()=>void;activate?:()=>void})=>void;const staleStop=vi.fn(),staleActivate=vi.fn(),freshActivate=vi.fn();
 const f=setup();f.microphone.mockImplementationOnce(()=>new Promise(r=>{firstResolve=r;}));f.microphone.mockImplementationOnce(async()=>({stop:vi.fn(),activate:freshActivate}));
 const first=f.controller.start();f.controller.stop();await f.controller.start();firstResolve({stop:staleStop,activate:staleActivate});await first;
 expect(staleStop).toHaveBeenCalledOnce();expect(staleActivate).not.toHaveBeenCalled();expect(freshActivate).toHaveBeenCalledOnce();expect(f.controller.active()).toBe(true);f.controller.stop(true);await f.controller.settled();
});
it('keeps legitimate repeated words from two separate manual captures',async()=>{
 const f=setup();await f.controller.start();await vi.advanceTimersByTimeAsync(3000);f.controller.stop();await f.controller.start();await vi.advanceTimersByTimeAsync(1000);f.controller.stop();await vi.advanceTimersByTimeAsync(6000);await f.controller.settled();
 expect(f.send.mock.calls.map(c=>c[0])).toEqual(['texte de la session','texte de la session']);
});
it('does not let an obsolete permission failure stop the newer microphone',async()=>{
 let rejectFirst!:(reason:Error)=>void;const f=setup();f.microphone.mockImplementationOnce(()=>new Promise((_r,reject)=>{rejectFirst=reject;}));const first=f.controller.start();f.controller.stop();await f.controller.start();rejectFirst(Error('old permission failure'));await first;expect(f.controller.active()).toBe(true);expect(f.state.mock.calls.at(-1)?.[0]).toBe(true);f.controller.stop(true);await f.controller.settled();
});
