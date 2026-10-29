import {randomInt} from "node:crypto";
import {rank,MIN_SCORE,type Matchable} from "./engine.js";
export interface AdvicePeer {ref:string;kind:string;accepts_messages:boolean;guide_profile?:{languages?:string[]}|null;}
export function chooseAdviceTarget(question:string,sessions:readonly Matchable[],peers:readonly AdvicePeer[],language:string,random:(n:number)=>number=randomInt) {
 const best=rank(question,sessions)[0];
 if(best && best.score>=MIN_SCORE)return {kind:"repo" as const,session:best.session};
 const available=peers.filter(p=>p.kind==="agent" && p.accepts_messages && (!p.guide_profile?.languages?.length || p.guide_profile.languages.includes(language)));
 if(!available.length)return {kind:"none" as const};
 return {kind:"agent" as const,peer:available[random(available.length)]!};
}
