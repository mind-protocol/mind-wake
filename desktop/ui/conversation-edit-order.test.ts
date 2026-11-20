import {expect,it} from "vitest";
import {orderByModification} from "./conversation-edit-order.js";
import type {ConversationItem} from "./conversation.js";
const message = (id: string, orderAt?: string): ConversationItem => ({id,text:id,from:"received",at:"",corpusSource:"artifacts/principal/90-fil.md",corpusSpeaker:"Marco",...(orderAt ? {orderAt} : {})});
it("places an edited message at its modification time, after later messages and pending human ones",()=>{
 const a=message("a","2026-11-20T10:00:00Z"), b=message("b","2026-11-20T10:05:00Z");
 const human: ConversationItem={id:"human",text:"Bonjour",from:"human",at:"2026-11-20T10:10:00Z"};
 expect(orderByModification([a,b,human]).map(i=>i.id)).toEqual(["a","b","human"]);
 expect(orderByModification([{...a,orderAt:"2026-11-20T10:20:00Z"},b,human]).map(i=>i.id)).toEqual(["b","human","a"]);
 expect(orderByModification([{...a,orderAt:"2026-11-20T10:30:00Z"},{...b,orderAt:"2026-11-20T10:20:00Z"},human]).map(i=>i.id)).toEqual(["human","b","a"]);
});
it("keeps undated passages on top in file order",()=>{
 expect(orderByModification([message("intro"),message("x","2026-11-20T09:00:00Z"),message("intro2")]).map(i=>i.id)).toEqual(["intro","intro2","x"]);
});
