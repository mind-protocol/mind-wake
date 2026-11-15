import {encodeVoiceParts,voicePartDisplay,type VoiceSelection,type VoiceThread} from './voice-conversations.js';
/** The transcript is rendered before attachment work or transport splitting. */
export async function deliverVoiceTranscript<B>(text:string,images:string[],metadata:{requestId:string;capturedAt:string;voiceSelection?:VoiceSelection},threads:VoiceThread[],options:{
  show:(key:string,text:string)=>B;update:(bubble:B,text:string)=>void;
  attachments:(images:string[])=>Promise<string>;
  send:(key:string,envelope:string,bubble:B)=>Promise<void|boolean>;
  attachmentsSent?:()=>void;
  imagesAllowed?:()=>boolean;
  cancelled:()=>boolean;warning:(note:string)=>void;
}):Promise<void>{
  const transcript=text.trim();if(!transcript||options.cancelled())return;
  const key=`ui-voice-${metadata.requestId}`,first=options.show(key,`[Dictée vocale]\n${transcript}`);
  let suffix='';try{if(images.length&&options.imagesAllowed?.()!==false)suffix=await options.attachments(images);}catch{options.warning('Captures indisponibles ; transcription conservée et envoyée seule.');}
  if(options.cancelled())return;
  const selection=metadata.voiceSelection??{capturedAt:metadata.capturedAt,threadIds:['fil1','fil2','fil3'],replyTo:'principal',mode:'principal'};
  if(options.imagesAllowed?.()===false)suffix='';
  const parts=encodeVoiceParts(transcript,suffix,metadata.requestId,selection,threads);
  let confirmed=true,sentAttachments=false;
  for(const part of parts){
    if(options.cancelled())return;
    if(options.imagesAllowed?.()===false)part.attachments='';
    const id=part.index===0?key:`${key}-p${part.index}`,body=voicePartDisplay(part),bubble=part.index===0?first:options.show(id,body);
    options.update(bubble,body);
    if(await options.send(id,JSON.stringify(part),bubble)===false)confirmed=false;
    if(part.attachments)sentAttachments=true;
  }
  if(confirmed&&sentAttachments)options.attachmentsSent?.();
}
