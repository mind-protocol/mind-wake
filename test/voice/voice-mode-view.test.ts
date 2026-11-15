/// <reference lib="dom" />
import fs from 'node:fs';import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {mountVoiceMode} from '../../desktop/ui/voice-mode-view.js';
import {DesktopVoiceMode} from '../../services/elevenlabs/voice-mode.js';
afterEach(()=>vi.unstubAllGlobals());
it('uses the canonical IPC on actual Play/Pause, heartbeats mic state and keeps the old app absent/off',async()=>{
 class Node{value='';textContent='';title='';disabled=false;dataset:Record<string,string>={};listeners=new Map<string,()=>void>();setAttribute(){}addEventListener(name:string,fn:()=>void){this.listeners.set(name,fn);}}
 const nodes=new Map<string,Node>();const get=(id:string)=>{const n=nodes.get(id)??new Node();nodes.set(id,n);return n;};let interval:(()=>void)|undefined;
 vi.stubGlobal('document',{getElementById:get});vi.stubGlobal('window',{setInterval:(fn:()=>void)=>{interval=fn;return 1;},clearInterval:vi.fn(),dispatchEvent:vi.fn()});
 const root=path.resolve('test-fixtures');fs.mkdirSync(root,{recursive:true});const mode=new DesktopVoiceMode(fs.mkdtempSync(path.join(root,'voice-ui-')),()=>({allowed:true,paused:false,forceOff:false}));
 const invoke=vi.fn(async(command:string,args?:Record<string,unknown>)=>{expect(command).toBe('elevenlabs');expect(args?.['action']).toBe('voice_mode_state');const data=args?.['payload']?mode.update(args['payload']):mode.read();return {exitCode:0,stdout:JSON.stringify({ok:true,data})};});
 let mic=false;const start=vi.fn(async()=>{mic=true;}),stop=vi.fn(()=>{mic=false;});
 const view=mountVoiceMode(invoke,{microphoneActive:()=>mic,startMicrophone:start,stopMicrophone:stop});
 await vi.waitFor(()=>expect(view.state()).toBeDefined());expect(start).not.toHaveBeenCalled();expect(mode.read().enabled).toBe(false);
 get('voice-mode-toggle').listeners.get('click')?.();await vi.waitFor(()=>expect(mode.read()).toMatchObject({enabled:true,microphoneActive:true}));expect(start).toHaveBeenCalledOnce();expect(get('voice-interlocutors').textContent).toBe('0');
 const revision=mode.read().revision;interval?.();await new Promise(resolve=>setTimeout(resolve,0));expect(view.state()?.revision).toBe(revision);
 get('voice-mode-toggle').listeners.get('click')?.();await vi.waitFor(()=>expect(mode.read()).toMatchObject({enabled:false,paused:true}));expect(stop).toHaveBeenCalledWith(false);view.dispose();
});



