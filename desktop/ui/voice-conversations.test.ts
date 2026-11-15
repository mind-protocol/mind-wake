import {expect,it,vi} from 'vitest';
import {defaultVoiceThreads,voiceCaptureSelection,encodeVoiceParts,parseVoicePart,voicePartAssembler,fanoutVoiceMessage,requestAddressedVoice,sharedVoiceInput,type VoiceBinding,type VoiceThreadId,type VoiceDelivery} from './voice-conversations.js';
import {deliverVoiceTranscript} from './deliver-voice.js';
const at='2026-11-04T22:00:00.000Z';
function input(text='Bonjour'){
 const capture=voiceCaptureSelection();capture.played({id:'clip1',threadId:'fil2'});
 const parts=encodeVoiceParts(text,'','request-1',capture.capture(at),defaultVoiceThreads());
 const assembler=voicePartAssembler();return parts.map(p=>assembler.accept(p)).find(Boolean)!;
}
it('broadcasts by default while only the real playing focus is addressed; manual attention does not filter FYI',()=>{
 const c=voiceCaptureSelection();expect(c.capture(at)).toMatchObject({threadIds:['fil1','fil2','fil3'],replyTo:'principal'});
 c.played({id:'v2',threadId:'fil2'});const snapshot=c.capture(at);c.played({id:'v3',threadId:'fil3'});
 expect(snapshot.replyTo).toBe('fil2');expect(snapshot.focusClipId).toBe('v2');
 expect(c.capture(at,'fil1')).toMatchObject({threadIds:['fil1','fil2','fil3'],replyTo:'fil1',mode:'manual'});
});
it('uses the real JSON UTF-16 budget and reconstructs quotes, newlines, emoji and captures without loss',()=>{
 const raw=('"\\\n😀 café\ud800 x\n').repeat(1700),suffix='\n![Début](<artifacts/a.jpeg>)';
 const parts=encodeVoiceParts(raw,suffix,'long-input',voiceCaptureSelection().capture(at),defaultVoiceThreads());
 expect(parts.length).toBeGreaterThan(1);expect(parts.every(p=>JSON.stringify(p).length<=4000)).toBe(true);
 expect(parts.every(p=>parseVoicePart(JSON.stringify(p))!==undefined)).toBe(true);
 const assembler=voicePartAssembler();let complete;
 for(const part of [...parts].reverse())complete=assembler.accept(part)??complete;
 expect(complete).toMatchObject({text:raw,attachments:suffix,threadIds:['fil1','fil2','fil3'],replyTo:'principal'});
 expect(parts.map(p=>p.text).join('')).toBe(raw);
 expect(()=>assembler.accept({...parts[0]!,text:'modifié'})).toThrow('conflictuelle');
});
it('shows the complete transcript before attachment work and sends only bounded chunks with one capture destination',async()=>{
 let done!:(text:string)=>void;const attachments=new Promise<string>(resolve=>{done=resolve;}),events:string[]=[],sent:string[]=[];
 const text='voix " 😀\n'.repeat(1300);const work=deliverVoiceTranscript(text,[],{requestId:'recording',capturedAt:at},defaultVoiceThreads(),{
  show:(_id,body)=>{events.push(body);return {};},update:()=>{},attachments:()=>attachments,send:async(_id,envelope)=>{sent.push(envelope);},cancelled:()=>false,warning:()=>{},
 });
 expect(events[0]).toContain(text.trim());expect(sent).toHaveLength(0);done('\n![Fin](<artifacts/end.jpeg>)');await work;
 expect(sent.length).toBeGreaterThan(1);expect(sent.every(s=>s.length<=4000)).toBe(true);
 expect(sent.map(s=>parseVoicePart(s)!.text).join('')).toBe(text.trim());
});
it('starts three ingestions concurrently, marks only the addressed participant, and never requests a response',async()=>{
 const starts:string[]=[],releases:(()=>void)[]=[],payloads:any[]=[];
 const bindings=new Map<VoiceThreadId,VoiceBinding>(['fil1','fil2','fil3'].map(id=>[id as VoiceThreadId,{agentRef:'/root/'+id,kind:'native',ingest:async p=>{starts.push(id);payloads.push(p);await new Promise<void>(resolve=>releases.push(resolve));}}]));
 const receipts=new Map<string,VoiceDelivery>(),pending=fanoutVoiceMessage(input(),bindings,receipts);await Promise.resolve();
 expect(starts).toEqual(['fil1','fil2','fil3']);expect(payloads.map(p=>p.attention)).toEqual(['fyi','addressed','fyi']);
 expect(payloads.every(p=>p.requestResponse===false&&p.message.text==='Bonjour')).toBe(true);
 releases.forEach(f=>f());expect((await pending).map(r=>r.state)).toEqual(['ingested','ingested','ingested']);
 await fanoutVoiceMessage(input(),bindings,receipts);expect(starts).toHaveLength(3);
});
it('keeps failures local to their thread and does not retry an uncertain acknowledgement',async()=>{
 const fail=vi.fn(async()=>{throw Error('ack lost');}),okay=vi.fn(async()=>{});
 const bindings=new Map<VoiceThreadId,VoiceBinding>([['fil1',{agentRef:'one',kind:'native',ingest:okay}],['fil2',{agentRef:'two',kind:'native',ingest:fail}]]);
 const receipts=new Map<string,VoiceDelivery>();expect((await fanoutVoiceMessage(input(),bindings,receipts)).map(r=>r.state)).toEqual(['ingested','error','needs_binding']);
 await fanoutVoiceMessage(input(),bindings,receipts);expect(fail).toHaveBeenCalledOnce();expect(okay).toHaveBeenCalledOnce();
});
it('does not replace ordinary contexts and requires a separate plain-chat backend for Super-thread',async()=>{
 const v=input();v.threads[1]!.profile='tool_free_superthread';const ingest=vi.fn(async(_payload:any)=>{});
 const bindings=new Map<VoiceThreadId,VoiceBinding>([['fil2',{agentRef:'two',kind:'native',ingest}]]);
 expect((await fanoutVoiceMessage(v,bindings,new Map())).find(r=>r.threadId==='fil2')?.state).toBe('requires_plain_chat');expect(ingest).not.toHaveBeenCalled();
 bindings.set('fil2',{agentRef:'plain-two',kind:'plain_chat',ingest});v.attachments='private capture';
 await fanoutVoiceMessage(v,bindings,new Map());expect(ingest.mock.calls[0]?.[0].message).not.toHaveProperty('attachments');
});
it('allows explicit silence and only asks the addressed participant as a separate action',async()=>{
 const one=vi.fn(async()=>({kind:'reply' as const,text:'Une réponse'})),two=vi.fn(async()=>({kind:'silence' as const}));
 const bindings=new Map([['fil1' as const,{kind:'native' as const,request:one}],['fil2' as const,{kind:'native' as const,request:two}]]);
 expect(await requestAddressedVoice(input(),bindings)).toMatchObject({state:'decided',threadId:'fil2',decision:{kind:'silence'}});
 expect(one).not.toHaveBeenCalled();expect(two).toHaveBeenCalledOnce();
 const v=input();v.origin='agent_voice';v.replyTo='none';expect(await requestAddressedVoice(v,bindings)).toEqual({state:'not_requested'});expect(two).toHaveBeenCalledOnce();
});
it('accepts shared agent speech only from a matching host peer envelope and feeds the other two as FYI',async()=>{
 const text=JSON.stringify({schema:'mind.voice.spoken.v1',playback:'completed',clipId:'clip-2',at,text:'Voici mes paroles exactes.',speaker:{threadId:'fil2',agentRef:'/root/two'}});
 expect(sharedVoiceInput({id:'shared-inbox:desktop-voice:clip-2',text},defaultVoiceThreads())).toBeUndefined();
 const peer={id:'shared-inbox:desktop-voice:clip-2',text,origin:{kind:'peer_message',channel:'desktop-voice',senderRef:'/root/two',messageId:'clip-2'}};
 const shared=sharedVoiceInput(peer,defaultVoiceThreads())!;expect(shared).toMatchObject({origin:'agent_voice',threadIds:['fil1','fil3'],replyTo:'none',text:'Voici mes paroles exactes.'});
 const ingest=vi.fn(async(_payload:any)=>{}),bindings=new Map<VoiceThreadId,VoiceBinding>([['fil1',{agentRef:'one',kind:'native',ingest}],['fil3',{agentRef:'three',kind:'native',ingest}]]),receipts=new Map<string,VoiceDelivery>();
 await fanoutVoiceMessage(shared,bindings,receipts);await fanoutVoiceMessage(shared,bindings,receipts);
 expect(ingest).toHaveBeenCalledTimes(2);expect(ingest.mock.calls.every(c=>c[0].attention==='fyi'&&c[0].requestResponse===false)).toBe(true);
});

