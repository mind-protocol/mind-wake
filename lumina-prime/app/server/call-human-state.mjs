import { ChatError } from './chat-server.mjs';

export const humanTerminal = status => ['declined','expired','left','ended'].includes(status);
export function humanInvitation(id, label, now) {
  return {id:`human-${id}`,kind:'peer-human',caller:'mind',label,until:now+60_000,status:'ringing',owner:null,lastSeen:now,offer:null,answer:null};
}
export function expireHuman(h, now) {
  if(h.status==='ringing'&&now>=h.until)h.status='expired';
  if(h.status==='accepted'&&now-h.lastSeen>45_000)h.status='left';
  if(humanTerminal(h.status)){h.offer=null;h.answer=null;}
  return h;
}
export function decideHuman(h, owner, decision, now) {
  expireHuman(h,now);
  if(h.status!=='ringing'||!['accept','decline'].includes(decision))throw new ChatError('call_expired',409);
  h.status=decision==='accept'?'accepted':'declined';h.owner=decision==='accept'?owner:null;h.lastSeen=now;
  return {caller:h.caller,kind:h.kind,id:h.id};
}
export function requireHuman(h, owner, now) {
  if(!h||expireHuman(h,now).status!=='accepted')throw new ChatError('call_ended',410);
  if(owner!==undefined&&h.owner!==owner)throw new ChatError('call_session_forbidden',403);
}
export function humanDescription(value,type) {
  if(!value||value.type!==type||typeof value.sdp!=='string'||value.sdp.length>24_000||!value.sdp.startsWith('v=0'))throw new ChatError('human_signal_invalid');
  return {type,sdp:value.sdp};
}
