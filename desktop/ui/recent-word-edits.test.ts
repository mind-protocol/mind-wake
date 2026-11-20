import {expect,it} from "vitest";
import {changedWords,recentEditColor} from "./recent-word-edits.js";
it("does not invent edits at first load, and only marks inserted or replaced words",()=>{
 const before=changedWords(undefined,"Le chat voit le chat.",1000);
 expect(before.every(w=>w.at===0)).toBe(true);
 const after=changedWords(before,"Le grand chat voit le chien.",2000);
 expect(after.filter(w=>w.at===2000).map(w=>w.text)).toEqual(["grand","chien"]);
});
it("keeps each word's age across later edits and deletion",()=>{
 const first=changedWords(changedWords(undefined,"Un chat dort.",1000),"Un petit chat dort.",2000);
 const next=changedWords(first,"Un petit chat mange.",3000);
 expect(next.find(w=>w.text==="petit")?.at).toBe(2000);
 expect(next.find(w=>w.text==="mange")?.at).toBe(3000);
 expect(changedWords(next,"Un chat mange.",4000).filter(w=>w.at===4000)).toEqual([]);
});
it("moves from blue toward yellow, expires at five minutes, and rejects future timestamps",()=>{
 expect(recentEditColor(1000,1000)).toBe("rgb(230 237 244)");
 expect(recentEditColor(1000,300999)).toBe("rgb(246 243 223)");
 expect(recentEditColor(1000,301000)).toBeNull();
 expect(recentEditColor(2000,1000)).toBeNull();
});
