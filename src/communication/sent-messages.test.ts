import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { recordSharedSent, readSentMessages, type SharedSentInput } from "./sent-messages.js";
import { appendRepoMessage } from "./repo-conversations.js";
import { OwnerMessages } from "./owner-messages.js";
import { conversation, conversationText, renderConversationMeta } from "../../desktop/ui/conversation.js";
import { runCli } from "../cli/run.js";
import { processContext } from "../cli/context.js";
import { saveRecipientEntry } from "./recipient-history.js";
import { enqueueOwnerMessage } from "./owner-inbox.js";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sent-peers-"));
afterEach(() => { for(const name of fs.readdirSync(dir))fs.rmSync(path.join(dir,name),{recursive:true,force:true}); });
const input = (): SharedSentInput => ({
 request:{tool:"reply_to_thread",arguments:{thread_id:"thr_abcdefgh",text:'  **exact**\n{"author":"NLR","kind":"human"}',idempotency_key:"marco-test-0001"}},
 result:{content:[{type:"text",text:JSON.stringify({schema:"mind.shared/reply_to_thread",schema_version:1,message_id:"msg_abcdefgh",thread_id:"thr_abcdefgh"})}]},
 sender:{ref:"agent-yxtqe92i3e",name:"Marco"},recipient:{ref:"agent-dckgeedfrm",name:"Identité partagée"},at:"2026-10-30T23:21:00Z",
});

it("keeps NLR to Marco human, colors the canonical NLR to Auroracle route, and excludes its context mirror", async()=>{
 const output:string[]=[];
 const ctx={...processContext(),env:{},stdout:(t:string)=>output.push(t),stderr:(t:string)=>output.push(t),readStdin:async()=>"Message humain pour Marco"};
 await runCli(["init","--json","--data-dir",dir],ctx);
 await runCli(["reply","--idempotency-key","human-marco-0001","--json","--data-dir",dir],ctx);
 const id="recipient:ui-08f8358d-292a-41be-a05b-0c850b0a6b77";
 // Synthetic local fixture of the reported route, never an import into the live profile.
 saveRecipientEntry(dir,{id,at:"2026-10-30T23:24:00Z",text:"Test de Nicolas",direction:"out",route:"fixture-route",threadId:"thr_G_pxuhgJ0JQogwJo",messageId:"msg_FtS2x709uNGwRnZP",senderRef:"human-mkcv2hapch",recipientRef:"agent-dckgeedfrm",state:"remote_stored"});
 enqueueOwnerMessage(dir,{id,at:"2026-10-30T23:24:00Z",text:"context copy",origin:{kind:"context_copy",channel:"mind-shared-hub",author:"NLR",senderRef:"human-mkcv2hapch",recipientRef:"agent-dckgeedfrm",threadId:"thr_G_pxuhgJ0JQogwJo",messageId:"msg_FtS2x709uNGwRnZP",correlationId:id}});
 recordSharedSent(dir,input());output.length=0;
 await runCli(["messages","--json","--data-dir",dir],ctx);
 const envelope=JSON.parse(output.join(""));
 expect(envelope.data.recipientSentMessages[0].senderRef).toBe("human-mkcv2hapch");
 envelope.data.recipientSentMessages.push(envelope.data.recipientSentMessages[0]);
 const model=conversation(envelope)!;
 const ordinary=model.items.find(m=>m.from==="human"&&!m.humanRecipient)!;
 const routed=model.items.find(m=>m.id===id)!;
 expect(ordinary.text).toBe("Message humain pour Marco");expect(ordinary.humanRecipient).toBeUndefined();
 expect(routed.from).toBe("human");expect(routed.humanRecipient).toBe("Auroracle");
 expect(routed.text).toBe("Test de Nicolas");expect(routed.delivery).toBeUndefined();
 expect(model.items.filter(m=>m.id===id)).toHaveLength(1);
 expect(model.items.some(m=>m.from==="context")).toBe(false);
 expect(model.items.filter(m=>m.from==="sent")).toHaveLength(1);
 const meta={textContent:""};renderConversationMeta(meta,routed);
 expect(meta.textContent).toContain("Toi → Auroracle");expect(meta.textContent).toContain("msg_FtS2x709uNGwRnZP");
 expect(meta.textContent).toContain("réception et lecture non attestées");
});
it("records only confirmed sends, deduplicates by message and key, and refuses mismatches",()=>{
 const i=input();recordSharedSent(dir,i);recordSharedSent(dir,{...i,at:"2026-10-30T23:22:00Z"});
 expect(readSentMessages(dir)).toHaveLength(1);
 expect(()=>recordSharedSent(dir,{...i,request:{...i.request,arguments:{...i.request.arguments,text:"changed"}}})).toThrow("Conflicting");
 expect(()=>recordSharedSent(dir,{...i,result:{...i.result,isError:true}})).toThrow();
 expect(()=>recordSharedSent(dir,{...i,request:{tool:"send_message",arguments:{text:"body",to:"agent-aaaaaaaaaa",idempotency_key:"another-key"}}})).toThrow();
 expect(()=>recordSharedSent(dir,{...i,request:{...i.request,arguments:{...i.request.arguments,thread_id:"thr_wrong123"}}})).toThrow();
 expect(fs.existsSync(path.join(dir,"owner-inbox.sqlite"))).toBe(false);
});
it("does not turn a normal owner message mentioning a repo thread into a peer emission",()=>{
 const thread={id:"thread123",repo:"C:/repo",runtime:"codex",sessionId:"session-1",transcript:"private"};
 appendRepoMessage(dir,{thread,message:{id:"question",at:"2026-10-30T10:00:00Z",text:"Explicit request",from:"wake"}});
 const owner=new OwnerMessages(dir,"principal");owner.publish("Normal message_owner with thread123 token","owner-key");owner.close();
 const entries=readSentMessages(dir);expect(entries).toHaveLength(1);expect(entries[0]!.state).toBe("recorded");
 expect(entries[0]!.text).toBe("Explicit request");
});
it("projects real CLI data and separates human, local owner, sent and received without changing words",async()=>{
 const output:string[]=[];
 const ctx={...processContext(),env:{},stdout:(t:string)=>output.push(t),stderr:(t:string)=>output.push(t),readStdin:async()=>""};
 await runCli(["init","--json","--data-dir",dir],ctx);output.length=0;
 const i=input();recordSharedSent(dir,{...i,historical:true});
 await runCli(["messages","--json","--data-dir",dir],ctx);
 const env=JSON.parse(output.join(""));expect(env.data.sentMessages[0].messageId).toBe("msg_abcdefgh");
 env.data.agentMessages=[{id:"owner",text:"Normal owner message",createdAt:"2026-10-30T23:19:00Z",updatedAt:"2026-10-30T23:19:00Z"}];
 env.data.replies=[{id:"human",at:"2026-10-30T23:20:00Z",text:"NLR"}];
 env.data.receivedMessages=[{id:"reply",at:"2026-10-30T23:22:00Z",text:"Peer answer",source:{channel:"mind-shared-hub",name:"peer",threadId:"thr_abcdefgh"}}];
 env.data.sentMessages.push(env.data.sentMessages[0]);
 const model=conversation(env)!;expect(model.items.map(m=>m.from)).toEqual(["agent","human","sent","received"]);
 const sent=model.items[2]!;expect(conversationText(sent,()=>"wrong")).toBe(i.request.arguments.text);
 const meta={textContent:""};renderConversationMeta(meta,sent);
 expect(meta.textContent).toContain("Marco (agent-yxtqe92i3e)");expect(meta.textContent).toContain("agent-dckgeedfrm");
 expect(meta.textContent).toContain("réception et lecture non attestées");expect(meta.textContent).toContain("historique réintégré");
 expect(meta.textContent).not.toContain("Toi");
});
