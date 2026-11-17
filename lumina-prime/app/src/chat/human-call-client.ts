import { call, type ChatSession } from './client.ts';
import type { CallSession } from './call-client.ts';
export type HumanState={peerId:string;id:string;label:string;status:'ringing'|'accepted'|'declined'|'expired'|'left'|'ended';answer?:RTCSessionDescriptionInit|null};
export const humanRequest=(session:ChatSession,scope:CallSession,action:string,input:Record<string,unknown>={},signal?:AbortSignal)=>call(session.url,'/chat/call/humans',{
  method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'},body:JSON.stringify({action,call:scope.id,epoch:scope.epoch,...input}),signal,
}) as Promise<{humans:HumanState[]}>;
export const guestRequest=(session:ChatSession,id:string,action:string,input:Record<string,unknown>={},signal?:AbortSignal)=>call(session.url,'/chat/call/human-guest',{
  method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'},body:JSON.stringify({action,id,...input}),signal,
}) as Promise<{id:string;label:string;status:string;offer?:RTCSessionDescriptionInit|null}>;
