import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {it,expect} from "vitest";
import {appendRepoMessage,readRepoConversations} from "./repo-conversations.js";
import {OwnerMessages} from "./owner-messages.js";
it("keeps real repo and Wake messages in one ordered thread without duplicates or unrelated owner messages",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"repo-thread-"));
 try {
 const thread={id:"REPO-1234",repo:"C:/repo",runtime:"claude",sessionId:"s",transcript:"C:/s.jsonl"};
 const record={thread,message:{id:"first",at:"2026-10-29T10:00:00Z",from:"repo" as const,text:"A real discovery"}};
 appendRepoMessage(dir,record);appendRepoMessage(dir,record);
 const owner=new OwnerMessages(dir,"agent");
 owner.publish("Unrelated private message","unrelated","2026-10-29T10:00:01Z");
 owner.publish("REPO-1234: question for the repo","reply","2026-10-29T10:00:02Z");owner.close();
 appendRepoMessage(dir,{thread,message:{id:"next",at:"2026-10-29T10:00:03Z",from:"repo",text:"Answer"}});
 appendRepoMessage(dir,{thread:{...thread,repo:"Conseils/Recherche d’un interlocuteur",sessionId:""},message:record.message});
 const result=readRepoConversations(dir);
 expect(result).toHaveLength(1);
 expect(result[0]!.repo).toBe("C:/repo");
 expect(result[0]!.messages.map(m=>m.from)).toEqual(["repo","wake","repo"]);
 expect(result[0]!.messages.map(m=>m.text)).not.toContain("Unrelated private message");
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
