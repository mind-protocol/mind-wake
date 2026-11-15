import {expect,it} from 'vitest';import fs from 'node:fs';
it('keeps the composer clear without removing transport settings or image attachments',()=>{
 const html=fs.readFileSync(new URL('./index.html',import.meta.url),'utf8');const main=fs.readFileSync(new URL('./main.ts',import.meta.url),'utf8');const composer=html.match(/<form id="chat-form">([\s\S]*?)<\/form>/)![1]!;
 for(const id of ['chat-text','chat-voice','chat-image-files','chat-image-preview'])expect(composer).toContain('id="'+id+'"');
 for(const id of ['chat-recipient','chat-transcription-provider','chat-bump']){expect(composer).not.toContain('id="'+id+'"');expect(html.match(new RegExp('id="'+id+'"','g'))).toHaveLength(1);}
 expect(main).toContain("byId('voice-advanced-controls').append(voiceDestinationLabel,voiceRouteStatus,voiceThreadEditor)");expect(main).toContain('metadata.voiceSelection?.threads');expect(main).toContain('dictation.cancelled(metadata.requestId)');
});
