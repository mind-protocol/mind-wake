import {expect,it} from 'vitest';
import {completedVoiceMessage} from './voice-exchange.js';
it('keeps exact public words and a peer author with stable clip identity',()=>{
 const clip={id:'c1',text:'Voici mes paroles, sans reformulation.',threadId:'fil2',agentRef:'/root/second',cycleId:'request1'};
 const first=completedVoiceMessage(clip,'2026-11-04T22:00:00Z')!;
 expect(first.origin.kind).toBe('peer_message');expect(first.origin.senderRef).toBe('/root/second');expect(first.id).toBe('shared-inbox:desktop-voice:c1');
 expect(JSON.parse(first.text)).toMatchObject({text:clip.text,speaker:{threadId:'fil2',agentRef:clip.agentRef},clipId:'c1'});
 expect(completedVoiceMessage({...clip,agentRef:undefined},first.at)).toBeNull();
});
