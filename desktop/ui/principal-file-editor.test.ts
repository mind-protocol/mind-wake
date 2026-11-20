import {expect,it} from "vitest";
import {deleteRequest, inlineSaveRequest, principalEditorHue, replaceConversationText} from "./principal-file-editor.js";
it("sends only the edited message with its own revision",()=>{
 expect(inlineSaveRequest({source:"artifacts/principal/90-fil.md",id:"principal:90-fil.md:own_1",text:"Avant",revision:"r1"}," Après\r\nSuite \n"))
  .toEqual({action:"principalMessageSave",source:"artifacts/principal/90-fil.md",id:"principal:90-fil.md:own_1",revision:"r1",text:"Après\nSuite"});
});
it("refuses missing or ambiguous passages instead of modifying another message",()=>{
 expect(()=>replaceConversationText("Bonjour\nBonjour","Bonjour","Autre")).toThrow("plusieurs fois");
 expect(()=>replaceConversationText("Nouveau texte","Ancien texte","Autre")).toThrow("a changé");
});
it("gives each editor a stable hue",()=>{
 expect(principalEditorHue("human")).toBe(principalEditorHue("human"));
 expect(principalEditorHue("human")).toBeGreaterThanOrEqual(0);
});
it("asks the runtime to delete only this message, with its revision",()=>{
 expect(deleteRequest({source:"artifacts/principal/90-fil.md",id:"principal:90-fil.md:Marco:2",text:"x",revision:"r2"}))
  .toEqual({action:"principalMessageDelete",source:"artifacts/principal/90-fil.md",id:"principal:90-fil.md:Marco:2",revision:"r2"});
});
