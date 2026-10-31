import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {afterEach, beforeEach, expect, it} from "vitest";
import {ConversationConflict, ConversationStore} from "./store.js";
import type {NewConversationCall} from "./contracts.js";
import {ParagraphEditLimitError} from "./edit-constraints.js";

let root:string;
const opened:ConversationStore[]=[];
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),"wake-conversation-store-"));});
afterEach(()=>{for(const store of opened.splice(0))store.close();fs.rmSync(root,{recursive:true,force:true});});
function store():ConversationStore {const value=new ConversationStore(root);opened.push(value);return value;}
function call(revision=1):NewConversationCall {
  return {id:`call-test-${revision}`,conversationId:"main",revision,role:"lead",pass:1,
    systemPrompt:"Answer the current request.",messages:[{role:"user",content:"A concrete question"}]};
}
function commentary(s:ConversationStore,id="commentary-1",text="Contexte en cours de recherche"):void {
  s.addCall({...call(),id,role:"commentary"});
  s.finishCall(id,{status:"succeeded",text,publish:false});
}
function paragraphAnswer(s:ConversationStore,paragraphs:string[],separator="\n\n"):string {
  let id="";
  for(let index=0;index<paragraphs.length;index++) {
    const callId=`paragraph-${index}`;s.addCall({...call(),id:callId});
    id=s.finishCall(callId,{status:"succeeded",text:paragraphs.slice(0,index+1).join(separator)}).message!.id;
  }
  return id;
}

it("stores exact inputs and a public result, with source identity and measured usage",()=>{
  const s=store();s.submit("main","A concrete question","request-1");
  const started=s.addCall(call());
  expect(started.inputHash).toMatch(/^[a-f0-9]{64}$/);
  expect(started.messages).toEqual(call().messages);
  const result=s.finishCall(started.id,{status:"succeeded",text:"A useful answer",rawOutput:'{"text":"A useful answer"}',usage:25});
  expect(result.published).toBe(true);
  expect(result.message).toMatchObject({role:"lead",text:"A useful answer",sourceCallId:started.id,revision:1,version:1});
  expect(s.call(started.id)).toMatchObject({usage:25,rawOutput:'{"text":"A useful answer"}',status:"succeeded"});
  expect(s.events("main").map(e=>e.kind)).toEqual(["human_message","call_started","call_published"]);
});

it("replays submissions and calls idempotently, refusing a conflicting identity",()=>{
  const s=store(),first=s.submit("main","Original","request-1");
  s.submit("main","Second","request-2",1);
  expect(s.submit("main","Original","request-1")).toEqual(first);
  expect(s.messages("main").filter(m=>m.role==="human")).toHaveLength(2);
  expect(()=>s.submit("main","Different","request-1")).toThrow(ConversationConflict);
  s.addCall(call(2));s.addCall(call(2));
  expect(s.calls("main")).toHaveLength(1);
  expect(()=>s.addCall({...call(2),systemPrompt:"Other instructions"})).toThrow(ConversationConflict);
  const completion={status:"succeeded" as const,text:"Answer"};
  s.finishCall("call-test-2",completion);s.finishCall("call-test-2",completion);
  expect(s.messages("main").filter(m=>m.role==="lead")).toHaveLength(1);
  expect(()=>s.finishCall("call-test-2",{...completion,text:"Changed"})).toThrow(ConversationConflict);
});

it("keeps late output as evidence without publishing it on a newer human revision",()=>{
  const s=store();s.submit("main","Old request","request-1");s.addCall(call());
  s.submit("main","New direction","request-2",1);
  const result=s.finishCall("call-test-1",{status:"succeeded",text:"Answer to old request"});
  expect(result.published).toBe(false);
  expect(s.messages("main").every(m=>m.role==="human")).toBe(true);
  expect(s.calls("main")[0]?.text).toBe("Answer to old request");
  expect(s.events("main").at(-1)?.kind).toBe("call_stale");
});

it("serializes stale edits across independent connections, preserving every message version",()=>{
  const left=store();left.submit("main","Original","request-1");
  const right=store(),id=right.messages("main")[0]!.id;
  left.editMessage("main",id,"First edit",1);
  expect(()=>right.editMessage("main",id,"Conflicting edit",1)).toThrow(ConversationConflict);
  expect(right.current("main")).toMatchObject({revision:2,text:"First edit"});
  expect(right.messageHistory(id).map(m=>m.text)).toEqual(["Original","First edit"]);
  expect(right.snapshot("main").messageVersions).toHaveLength(2);
  expect(()=>right.submit("main","Outdated send","request-2",1)).toThrow(ConversationConflict);
  expect(right.messages("main")).toHaveLength(1);
});

it("publishes rewrite and next-call canonical state atomically, retaining originals",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());
  const completion=s.finishCall("call-test-1",{status:"succeeded",text:"Early answer"});
  const user=s.messages("main").find(m=>m.role==="human")!;
  const canonical=s.publishRewrite("main",1,"lead",[{role:"user",content:"Question"},{role:"assistant",content:"Improved answer"}]);
  expect(canonical.version).toBe(1);
  expect(s.current("main")?.revision).toBe(1);
  expect(s.messages("main").find(m=>m.role==="human")).toEqual(user);
  expect(s.messages("main").find(m=>m.role==="lead")).toMatchObject({text:"Improved answer",version:2});
  expect(s.messageHistory(completion.message!.id).map(m=>m.text)).toEqual(["Early answer","Improved answer"]);
  expect(s.canonicalHistory("lead","main")).toHaveLength(1);
  s.submit("main","Changed question","request-2");
  expect(()=>s.publishRewrite("main",1,"lead",canonical.messages)).toThrow(ConversationConflict);
  expect(s.canonical("lead","main")?.version).toBe(1);
});

it("prevents automatic rewrites from erasing a human edit, rolling back canonical changes too",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());
  const result=s.finishCall("call-test-1",{status:"succeeded",text:"Original answer"});
  s.editMessage("main",result.message!.id,"My wording",1);
  expect(()=>s.publishRewrite("main",2,"lead",[{role:"user",content:"Question"},{role:"assistant",content:"Model overwrites user"}]))
    .toThrow("human-edited");
  expect(s.canonical("lead","main")).toBeNull();
  expect(s.messages("main").find(m=>m.role==="lead")?.text).toBe("My wording");
});

it("improves the current Lead answer in place when later context arrives",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());
  const first=s.finishCall("call-test-1",{status:"succeeded",text:"Answer before context"});
  s.addCall({...call(),id:"call-more-context",messages:[{role:"user",content:"Question plus verified context"}]});
  const second=s.finishCall("call-more-context",{status:"succeeded",text:"Answer informed by context"});
  expect(second.message?.id).toBe(first.message?.id);
  expect(second.message?.version).toBe(2);
  expect(s.messages("main").filter(m=>m.role==="lead")).toHaveLength(1);
  expect(s.messageHistory(first.message!.id).map(m=>m.text)).toEqual(["Answer before context","Answer informed by context"]);
  expect(s.calls("main").map(c=>c.text)).toEqual(["Answer before context","Answer informed by context"]);
  expect(s.finishCall("call-test-1",{status:"succeeded",text:"Answer before context"}).message?.version).toBe(1);
});

it("does not replace a human-edited Lead slot with an automatic call of the current revision",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());
  const first=s.finishCall("call-test-1",{status:"succeeded",text:"Model wording"});
  s.editMessage("main",first.message!.id,"Human wording",1);
  s.addCall(call(2));
  expect(s.finishCall("call-test-2",{status:"succeeded",text:"Another model wording"}).published).toBe(false);
  expect(s.messages("main").filter(m=>m.role==="lead").map(m=>m.text)).toEqual(["Human wording"]);
});

it("materializes an edited live Lead preview and supersedes its still-running call",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());
  const next=s.editPreview("main","call-test-1","Human edits the visible beginning",1);
  expect(next.revision).toBe(2);
  expect(s.call("call-test-1")?.status).toBe("running");
  expect(s.messages("main").find(m=>m.role==="lead")).toMatchObject({text:"Human edits the visible beginning",revision:2,edited:true,version:1,sourceCallId:"call-test-1"});
  expect(s.finishCall("call-test-1",{status:"succeeded",text:"Late model completion"}).published).toBe(false);
  expect(s.messages("main").filter(m=>m.role==="lead").map(m=>m.text)).toEqual(["Human edits the visible beginning"]);
});

it("rejects editing a preview when a final answer won the race, without losing either text",()=>{
  const left=store();left.submit("main","Question","request-1");left.addCall(call());
  const right=store();right.finishCall("call-test-1",{status:"succeeded",text:"The real final answer"});
  expect(()=>left.editPreview("main","call-test-1","Unsaved user draft",1)).toThrow("final Lead answer");
  expect(left.current("main")?.revision).toBe(1);
  expect(left.messages("main").find(m=>m.role==="lead")?.text).toBe("The real final answer");
  expect(left.messageVersions("main")).toHaveLength(2);
});

it("accepts only one concurrent edit of a live preview",()=>{
  const left=store();left.submit("main","Question","request-1");left.addCall(call());
  const right=store();left.editPreview("main","call-test-1","First editor",1);
  expect(()=>right.editPreview("main","call-test-1","Second editor",1)).toThrow(ConversationConflict);
  expect(right.messages("main").filter(m=>m.role==="lead")).toMatchObject([{text:"First editor",version:1}]);
});

it("refuses preview edits from another role, pass, conversation or revision",()=>{
  const s=store();s.submit("main","Question","request-1");
  s.addCall({...call(),id:"context-call",role:"context"});
  s.addCall({...call(),id:"rewrite-call",pass:2});
  s.addCall(call());
  s.submit("other","Other question","other-request");
  for(const id of ["context-call","rewrite-call"])
    expect(()=>s.editPreview("main",id,"Wrong preview",1)).toThrow(ConversationConflict);
  expect(()=>s.editPreview("other","call-test-1","Other conversation preview",1)).toThrow(ConversationConflict);
  s.submit("main","New question","request-2");
  expect(()=>s.editPreview("main","call-test-1","Old preview",2)).toThrow(ConversationConflict);
  expect(s.messages("main").filter(m=>m.role==="lead")).toEqual([]);
});

it("stores pass two output without publishing raw rewrite JSON as a message",()=>{
  const s=store();s.submit("main","Question","request-1");
  s.addCall({...call(),pass:2});
  const result=s.finishCall("call-test-1",{status:"succeeded",text:'{"messages":[]}',rawOutput:'{"messages":[]}'});
  expect(result.published).toBe(false);
  expect(s.messages("main")).toHaveLength(1);
  expect(s.calls("main")[0]?.rawOutput).toBe('{"messages":[]}');
});

it("keeps stop controls on new submissions and results until explicitly resumed",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());s.stopConversation("main");
  expect(s.finishCall("call-test-1",{status:"succeeded",text:"Late answer"}).published).toBe(false);
  s.submit("main","Queued while stopped","request-2");
  expect(s.current("main")).toMatchObject({status:"stopped",revision:2});
  expect(()=>s.addCall(call(2))).toThrow("not active");
  const resumed=s.resumeConversation("main",2);s.addCall(call(resumed.revision));
  expect(s.current("main")?.status).toBe("active");
  expect(()=>s.resumeConversation("main",1)).toThrow(ConversationConflict);
});

it("cannot publish a pre-stop result after a rapid stop and resume",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());
  s.stopConversation("main");
  const resumed=s.resumeConversation("main",1);
  expect(resumed.revision).toBe(2);
  expect(s.finishCall("call-test-1",{status:"succeeded",text:"An answer from the stopped run"}).published).toBe(false);
  expect(s.messages("main").filter(m=>m.role==="lead")).toEqual([]);
});

it("keeps repository scope, provenance and superseded versions across reopened stores",()=>{
  const s=store();s.createConversation("main");
  const first=s.contributeRepository("context","main",{key:"source-1",text:"A sourced fact",sources:["file.md:12"],status:"accepted"});
  s.contributeRepository("context","main",{key:"source-1",text:"Fact corrected",status:"superseded",sources:["correction.md:4"],expectedVersion:first.version});
  expect(()=>s.contributeRepository("context","main",{key:"source-1",text:"Stale correction",expectedVersion:1})).toThrow(ConversationConflict);
  const second=store();
  expect(second.repository("context","main")).toMatchObject([{version:2,text:"Fact corrected",sources:["correction.md:4"],status:"superseded"}]);
  expect(second.repository("lead","main")).toEqual([]);
});

it("keeps an append-only change log linking human edits, Lead improvements and rewrites",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());
  const first=s.finishCall("call-test-1",{status:"succeeded",text:"First wording"});
  s.addCall({...call(),id:"better-call"});s.finishCall("better-call",{status:"succeeded",text:"Better wording"});
  const beforeRewrite=s.changes("main");
  s.publishRewrite("main",1,"lead",[{role:"user",content:"Question"},{role:"assistant",content:"Clearer answer with the same known facts"}],
    {callId:"rewrite-source",reason:"Clarified the causal connection"});
  const snapshot=s.snapshot("main");
  expect(snapshot.changes.slice(0,beforeRewrite.length)).toEqual(beforeRewrite);
  const improved=snapshot.changes.find(c=>c.kind==="lead_improved")!;
  expect(improved).toMatchObject({revision:1,role:"lead",callId:"better-call",messageId:first.message!.id,before:{text:"First wording"},after:{text:"Better wording"}});
  expect(snapshot.changes.find(c=>c.kind==="message_rewritten")).toMatchObject({callId:"rewrite-source",reason:"Clarified the causal connection",before:{text:"Better wording"},after:{text:"Clearer answer with the same known facts"}});
  expect(snapshot.canonicalVersions).toHaveLength(1);
  expect(s.changes("main",beforeRewrite.at(-1)!.sequence).length).toBe(snapshot.changes.length-beforeRewrite.length);
});

it("never appends a successful change when a rewrite or user edit conflicts",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());
  const result=s.finishCall("call-test-1",{status:"succeeded",text:"Original"});
  s.editMessage("main",result.message!.id,"Human wording",1);
  const before=s.changes("main");
  expect(()=>s.editMessage("main",result.message!.id,"Stale wording",1)).toThrow(ConversationConflict);
  expect(()=>s.publishRewrite("main",2,"lead",[{role:"user",content:"Question"},{role:"assistant",content:"Overwrite human wording"}])).toThrow(ConversationConflict);
  expect(s.changes("main")).toEqual(before);
  expect(s.snapshot("main").canonicalVersions).toEqual([]);
});

it("retains reusable Expertise instructions with applicability, sources and a public explanation",()=>{
  const s=store();s.submit("main","Improve this process","request-1");
  const text="When working on an offer, improve the central value before detailing its format.";
  s.contributeRepository("expertise","main",{key:"offer-core",text,sources:["human-message:request-1"],sourceCallId:"expertise-call",reason:"Reusable instruction expressed by the human"});
  const snapshot=store().snapshot("main");
  expect(snapshot.repository).toMatchObject([{role:"expertise",text,sources:["human-message:request-1"]}]);
  expect(snapshot.changes.find(c=>c.kind==="repository_updated")).toMatchObject({role:"expertise",callId:"expertise-call",reason:"Reusable instruction expressed by the human",before:null,after:{key:"offer-core",text}});
});

it("applies Commentary inside the stable streamed Lead message",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());
  const draft=s.updateLeadDraft("main",1,"call-test-1","Le début de réponse")!;
  commentary(s);
  const updated=s.applyCommentary("main",1,"commentary-1",draft.id,draft.version,"Contexte en cours de recherche");
  expect(updated).toMatchObject({id:draft.id,draft:true,version:2});
  expect(updated.segments).toEqual([{role:"lead",text:"Le début de réponse"},{role:"commentary",text:"\n\nContexte en cours de recherche"}]);
  expect(updated.segments!.map(segment=>segment.text).join("")).toBe(updated.text);
  expect(s.messages("main").filter(message=>message.role!=="human")).toHaveLength(1);
  expect(s.changes("main").find(c=>c.kind==="commentary_applied")).toMatchObject({callId:"commentary-1",messageId:draft.id,before:{version:1},after:{version:2}});
});

it("replaces the draft with the final Lead text while preserving its Commentary segment",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());
  const draft=s.updateLeadDraft("main",1,"call-test-1","Début")!;
  commentary(s);s.applyCommentary("main",1,"commentary-1",draft.id,draft.version,"Un résultat vérifié vient d’arriver.");
  s.finishCall("call-test-1",{status:"succeeded",text:"Début",publish:false});
  s.addCall({...call(),id:"lead-final"});
  const result=s.finishCall("lead-final",{status:"succeeded",text:"Réponse finale informée."});
  expect(result.message).toMatchObject({id:draft.id,draft:false,version:3,text:"Réponse finale informée.\n\nUn résultat vérifié vient d’arriver."});
  expect(result.message?.segments).toEqual([{role:"lead",text:"Réponse finale informée."},{role:"commentary",text:"\n\nUn résultat vérifié vient d’arriver."}]);
  expect(s.messages("main").filter(m=>m.role==="lead")).toHaveLength(1);
});

it("rebases Commentary only over automatic Lead updates",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());
  const draft=s.updateLeadDraft("main",1,"call-test-1","Début")!;
  commentary(s);
  s.updateLeadDraft("main",1,"call-test-1","Début maintenant développé");
  const result=s.applyCommentary("main",1,"commentary-1",draft.id,1,"Recherche en cours");
  expect(result.text).toBe("Début maintenant développé\n\nRecherche en cours");
  expect(s.changes("main").at(-1)?.reason).toContain("Rebased on automatic Lead changes");
});

it("rejects a stale Commentary even if another Commentary wrote identical text",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());
  const draft=s.updateLeadDraft("main",1,"call-test-1","Réponse")!;
  commentary(s,"comment-1","État");
  const v2=s.applyCommentary("main",1,"comment-1",draft.id,1,"État");
  commentary(s,"comment-2","État");commentary(s,"comment-stale","Vieil état");
  s.applyCommentary("main",1,"comment-2",draft.id,v2.version,"État");
  const before=s.changes("main");
  expect(()=>s.applyCommentary("main",1,"comment-stale",draft.id,v2.version,"Vieil état")).toThrow("Another Commentary");
  expect(s.messages("main").find(m=>m.role==="lead")?.text).toBe("Réponse\n\nÉtat");
  expect(s.changes("main")).toEqual(before);
});

it("protects a human-edited draft against late Lead and Commentary output",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());
  const draft=s.updateLeadDraft("main",1,"call-test-1","Début")!;
  commentary(s);
  const edited=s.editMessage("main",draft.id,"Mon texte",draft.version);
  expect(edited.revision).toBe(2);
  expect(s.updateLeadDraft("main",1,"call-test-1","Nouvelle sortie")).toBeNull();
  expect(()=>s.applyCommentary("main",1,"commentary-1",draft.id,draft.version,"État tardif")).toThrow(ConversationConflict);
  expect(s.finishCall("call-test-1",{status:"succeeded",text:"Réponse ancienne"}).published).toBe(false);
  expect(s.messages("main").find(m=>m.id===draft.id)).toMatchObject({text:"Mon texte",edited:true,draft:false,segments:[{role:"lead",text:"Mon texte"}]});
});

it("lets a preview edit freeze an already-materialized draft even when its text is unchanged",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());
  const draft=s.updateLeadDraft("main",1,"call-test-1","Mon début choisi")!;
  s.editPreview("main","call-test-1","Mon début choisi",1);
  expect(s.current("main")?.revision).toBe(2);
  expect(s.messages("main").find(m=>m.id===draft.id)).toMatchObject({version:2,edited:true,draft:false});
});

it("makes a rewritten Lead message wholly Lead-attributed when exact old attribution is unavailable",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());
  const draft=s.updateLeadDraft("main",1,"call-test-1","Début")!;
  commentary(s);s.applyCommentary("main",1,"commentary-1",draft.id,1,"Contexte intégré");
  s.finishCall("call-test-1",{status:"succeeded",text:"Réponse finale"});
  s.publishRewrite("main",1,"lead",[{role:"user",content:"Question"},{role:"assistant",content:"Réponse reconstruite et cohérente\n\nContexte intégré"}]);
  const result=s.messages("main").find(m=>m.role==="lead")!;
  expect(result.segments).toEqual([{role:"lead",text:"Réponse reconstruite et cohérente\n\nContexte intégré"}]);
  expect(result.segments!.map(segment=>segment.text).join("")).toBe(result.text);
  expect(s.changes("main").find(c=>c.kind==="message_rewritten")).toMatchObject({before:{segments:[{role:"lead"},{role:"commentary"}]},after:{segments:[{role:"lead"}]}});
});

it("rejects a multi-paragraph Commentary operation without a phantom target version",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());
  const draft=s.updateLeadDraft("main",1,"call-test-1","Lead answer")!;
  commentary(s,"too-large","First comment\n\nSecond comment");
  const before=s.messageHistory(draft.id);
  expect(()=>s.applyCommentary("main",1,"too-large",draft.id,1,"First comment\n\nSecond comment")).toThrow(ParagraphEditLimitError);
  expect(s.messageHistory(draft.id)).toEqual(before);
  expect(s.events("main").at(-1)).toMatchObject({kind:"paragraph_edit_rejected",role:"commentary",callId:"too-large"});
});

it("permits a pure deletion of Commentary without deleting the Lead content",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());
  const draft=s.updateLeadDraft("main",1,"call-test-1","Lead answer")!;
  commentary(s,"comment-on");const withComment=s.applyCommentary("main",1,"comment-on",draft.id,1,"A comment");
  commentary(s,"comment-off","");
  const removed=s.applyCommentary("main",1,"comment-off",draft.id,withComment.version,"");
  expect(removed.text).toBe("Lead answer");expect(removed.segments).toEqual([{role:"lead",text:"Lead answer"}]);
});

it("rejects two paragraph replacements from one Lead call while retaining its actual output",()=>{
  const s=store();s.submit("main","Question","request-1");
  const id=paragraphAnswer(s,["First","Second","Third"]),before=s.messageHistory(id);
  s.addCall({...call(),id:"too-large-lead"});
  const raw='{"text":"Changed first\\n\\nChanged second\\n\\nThird"}';
  expect(()=>s.finishCall("too-large-lead",{status:"succeeded",text:"Changed first\n\nChanged second\n\nThird",rawOutput:raw})).toThrow(ParagraphEditLimitError);
  expect(s.messageHistory(id)).toEqual(before);
  expect(s.call("too-large-lead")).toMatchObject({status:"failed",rawOutput:raw,published:false});
  expect(s.events("main").at(-1)?.kind).toBe("paragraph_edit_rejected");
});

it("validates the entire rewrite before atomically projecting its individual paragraph operations",()=>{
  const s=store();s.submit("main","Question","request-1");
  const id=paragraphAnswer(s,["First","Second","Third"]),start=s.messageHistory(id).length;
  s.publishRewrite("main",1,"lead",[{role:"user",content:"Question"},{role:"assistant",content:"First"}],{callId:"deletion-pass",reason:"Removed redundant paragraphs"});
  const versions=s.messageHistory(id).slice(start);
  expect(versions.map(v=>v.text)).toEqual(["First\n\nThird","First"]);
  const operations=s.changes("main").filter(c=>c.kind==="message_rewritten");
  expect(operations.map(c=>c.operation)).toEqual([{kind:"delete",paragraphIndex:1},{kind:"delete",paragraphIndex:1}]);
  expect(operations.every(c=>c.callId==="deletion-pass" && c.reason==="Removed redundant paragraphs")).toBe(true);
  expect(s.changes("main").findLast(c=>c.kind==="canonical_updated")!.sequence).toBeGreaterThan(operations.at(-1)!.sequence);
});

it("preserves exact CRLF separators when changing one paragraph",()=>{
  const s=store();s.submit("main","Question","request-1");
  const id=paragraphAnswer(s,["First","Second","Third"],"\r\n\r\n"),start=s.messageHistory(id).length;
  const wanted="First\r\n\r\nImproved second\r\n\r\nThird";
  s.publishRewrite("main",1,"lead",[{role:"user",content:"Question"},{role:"assistant",content:wanted}]);
  expect(s.messageHistory(id).slice(start).map(v=>v.text)).toEqual([wanted]);
  expect(s.changes("main").findLast(c=>c.kind==="message_rewritten")?.operation).toEqual({kind:"replace",paragraphIndex:1});
});

it("rejects two changed messages in one rewrite without partially rewriting the first",()=>{
  const s=store();s.submit("main","Question one","request-1");s.addCall(call());s.finishCall("call-test-1",{status:"succeeded",text:"Answer one"});
  s.submit("main","Question two","request-2");s.addCall(call(2));s.finishCall("call-test-2",{status:"succeeded",text:"Answer two"});
  const before=s.snapshot("main");
  expect(()=>s.publishRewrite("main",2,"lead",[{role:"user",content:"Question one"},{role:"assistant",content:"Changed one"},{role:"user",content:"Question two"},{role:"assistant",content:"Changed two"}])).toThrow(ParagraphEditLimitError);
  expect(s.snapshot("main").messages).toEqual(before.messages);
  expect(s.snapshot("main").messageVersions).toEqual(before.messageVersions);
  expect(s.snapshot("main").canonicalVersions).toEqual([]);
});

it("does not duplicate a preserved Commentary suffix echoed by a final Lead result",()=>{
  const s=store();s.submit("main","Question","request-1");s.addCall(call());
  const draft=s.updateLeadDraft("main",1,"call-test-1","Lead beginning")!;
  commentary(s);s.applyCommentary("main",1,"commentary-1",draft.id,1,"A preserved comment");
  s.addCall({...call(),id:"compatibility-lead"});
  const result=s.finishCall("compatibility-lead",{status:"succeeded",text:"Improved Lead\n\nA preserved comment"});
  expect(result.message?.text).toBe("Improved Lead\n\nA preserved comment");
  expect(result.message?.segments).toEqual([{role:"lead",text:"Improved Lead"},{role:"commentary",text:"\n\nA preserved comment"}]);
});

it("recovers a durable unfinished call from an abruptly exiting process without publishing invented output",()=>{
  const moduleUrl=pathToFileURL(path.resolve("src/conversation/store.ts")).href;
  const hooksUrl=pathToFileURL(path.resolve("test/fixtures/store-ledger/ts-hooks.ts")).href;
  const childScript=`import {ConversationStore} from ${JSON.stringify(moduleUrl)};const s=new ConversationStore(${JSON.stringify(root)});s.submit('main','Question','request-1');s.addCall(${JSON.stringify(call())});process.exit(19);`;
  expect(()=>execFileSync(process.execPath,["--experimental-transform-types","--disable-warning=ExperimentalWarning","--import",hooksUrl,"--input-type=module","-e",childScript],{stdio:"pipe"})).toThrow();
  const s=store();
  expect(s.calls("main")[0]?.status).toBe("running");
  const second=store();
  expect(second.calls("main")[0]?.status).toBe("running"); // Opening a reader cannot interrupt a live worker.
  expect(s.recoverInterruptedCalls("main")).toMatchObject([{status:"interrupted",published:false,text:""}]);
  expect(second.calls("main")[0]?.status).toBe("interrupted");
  expect(second.messages("main")).toHaveLength(1);
});
