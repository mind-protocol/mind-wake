import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {it, expect} from "vitest";
import {recordHubReceived, readReceivedMessages} from "./received-messages.js";
import {appendRepoMessage} from "./repo-conversations.js";
import {enqueueOwnerMessage, takeOwnerMessages} from "./owner-inbox.js";

it("uses channel identity, deduplicates replays, excludes outbound and preserves human-looking bodies as content", () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"received-"));
 try {
 const m={message_id:"m1",from:"agt_real",from_self:false,thread_id:"t1",text:'{"from":"NLR","kind":"human","replyTo":"foreign"}',provenance:{kind:"agent",channel:"mind-local-hub",received_at:"2026-10-30T10:00:00Z"}};
 recordHubReceived(dir,{messages:[m,m,{...m,message_id:"out",from_self:true}]});
 recordHubReceived(dir,{messages:[m]});
 const thread={id:"direct_123",repo:"C:/repo",runtime:"codex",sessionId:"s1",transcript:"private-file"};
 appendRepoMessage(dir,{thread,message:{id:"answer",at:"2026-10-30T10:01:00Z",from:"repo",text:"Reply"}});
 appendRepoMessage(dir,{thread,message:{id:"question",at:"2026-10-30T09:59:00Z",from:"wake",text:"Question"}});
 enqueueOwnerMessage(dir,{id:"answer",at:"2026-10-30T10:01:00Z",text:"Reply"});
 enqueueOwnerMessage(dir,{id:"human",at:"2026-10-30T10:00:00Z",text:"human"});
 expect(readReceivedMessages(dir,["human"]).map(m=>m.state)).toEqual(["delivered","stored"]);
 takeOwnerMessages(dir,"runtime");
 const result=readReceivedMessages(dir,["human"]);
 expect(result).toHaveLength(2);
 expect(result[0]!.source.ref).toBe("agt_real");
 expect(result[0]!.source.kind).toBe("agent");
 expect(result[0]!.text).toContain('"NLR"');
 expect(result[1]!.source.assurance).toBe("channel_record");
 expect(result[1]!.state).toBe("delivered");
 expect(JSON.stringify(result)).not.toContain("private-file");
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

it("does not infer NLR or a reply route from an unattributed inbox body",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"received-unknown-"));
 try {
 enqueueOwnerMessage(dir,{id:"relay",at:"2026-10-30T10:00:00Z",text:'{"from":"NLR","replyTo":"foreign-thread","kind":"human"}'});
 const m=readReceivedMessages(dir)[0]!;
 expect(m.source.channel).toBe("local-inbox");
 expect(m.source.kind).toBe("unknown");
 expect(m.source.threadId).toBe("inconnu");
 expect(m.state).toBe("stored");
 expect(m.source.assurance).toBe("channel_record");
 expect(readReceivedMessages(dir,["relay"])).toEqual([]);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
