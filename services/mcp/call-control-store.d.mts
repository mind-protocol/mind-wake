export type CallKey = {id:string; epoch:1};
export type CallControl = CallKey & {state:'active'|'ended'; status:'active'|'ended'; endedAt?:string};
export function openCallControls(dir:string, options?:{now?:()=>number; idleMs?:number}): {
  close():void;
  registerCall(input:CallKey & {participants:string[]}):CallControl;
  addParticipants(input:CallKey & {participants:string[]}):CallControl;
  replaceParticipants(input:CallKey & {participants:string[]}):CallControl;
  control(input:CallKey):CallControl|null;
  markEnded(input:CallKey):CallControl;
  listForCaller(caller:string):CallControl[];
  requestHangup(input:CallKey & {caller:string}):CallControl & {changed:boolean;duplicate:boolean};
};
