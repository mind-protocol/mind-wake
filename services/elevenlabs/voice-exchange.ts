/** A public oral contribution remains an agent message, never a human request. */
export function completedVoiceMessage(clip:{id:string;text:string;threadId?:string|undefined;agentRef?:string|undefined;cycleId?:string|undefined},at:string){
  if(!['fil1','fil2','fil3'].includes(clip.threadId??'')||!clip.agentRef?.trim()||!Number.isFinite(Date.parse(at)))return null;
  return {
    id:`shared-inbox:desktop-voice:${clip.id}`,at,
    text:JSON.stringify({schema:'mind.voice.spoken.v1',playback:'completed',clipId:clip.id,at,text:clip.text,speaker:{threadId:clip.threadId,agentRef:clip.agentRef},...(clip.cycleId?{cycleId:clip.cycleId}:{})}),
    origin:{kind:'peer_message' as const,channel:'desktop-voice',author:clip.agentRef,senderRef:clip.agentRef,recipientRef:'/root',threadId:clip.threadId!,messageId:clip.id,correlationId:`desktop-voice:${clip.id}`},
  };
}

