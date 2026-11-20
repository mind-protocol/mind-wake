import {expect,it} from "vitest";
import {dictationRequest} from "./principal-dictation.js";
const target={source:"artifacts/principal/90-fil.md",id:"principal:90-fil.md:editorial:2",text:"### Jeton et push",revision:"r1"};
it("appends the first dictated segment to the element, then extends the added line",()=>{
 expect(dictationRequest(target,null," Et le\nhook ? ")).toEqual({action:"principalMessageAppend",source:target.source,id:target.id,revision:"r1",text:"Et le hook ?"});
 const added={source:target.source,id:"principal:90-fil.md:Humain:1",text:"Et le hook ?",revision:"r2"};
 expect(dictationRequest(target,added,"Il tourne.")).toEqual({action:"principalMessageSave",source:target.source,id:added.id,revision:"r2",text:"Et le hook ? Il tourne."});
});
