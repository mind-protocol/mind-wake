export type CallKey = {id:string; epoch:1};
export type CallControl = CallKey & {state:'active'|'ended'; status:'active'|'ended'; endedAt?:string};
export type CallInvite = {request?:number; call_id:string; epoch:number; target:string; state:'pending'|'settled'; status?:string; error?:string; label?:string};
export type PendingCallInvite = CallKey & {request:number; caller:string; callerLabel:string; target:string; reason:string};
export function openCallControls(dir:string, options?:{now?:()=>number; idleMs?:number}): {
  close():void;
  registerCall(input:CallKey & {participants:string[]}):CallControl;
  addParticipants(input:CallKey & {participants:string[]}):CallControl;
  replaceParticipants(input:CallKey & {participants:string[]}):CallControl;
  control(input:CallKey):CallControl|null;
  markEnded(input:CallKey):CallControl;
  listForCaller(caller:string):CallControl[];
  requestInvite(input:{id?:string; epoch?:1; caller:string; callerLabel?:string; target:string; reason?:string}):CallInvite;
  pendingInvites():PendingCallInvite[];
  settleInvite(request:number, result:{status:string; error?:string; label?:string}):CallInvite|null;
  invite(request:number):CallInvite|null;
  requestHangup(input:CallKey & {caller:string}):CallControl & {changed:boolean;duplicate:boolean};
};
