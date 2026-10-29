import fs from "node:fs";import path from "node:path";
import {HubLink} from "../mcp/hub-link.js";
import {readConfig,excludedRoots} from "./engine.js";
import {refreshIndex} from "./session-index.js";
import {chooseAdviceTarget} from "./advice-routing.js";
import {officialWaker} from "./wake.js";
import {appendRepoMessage} from "../../src/communication/repo-conversations.js";
import {enqueueOwnerMessage} from "../../src/communication/owner-inbox.js";
import type {AdviceRequest} from "./advice-dispatch.js";
import {advicePrompt} from "./advice-prompt.js";
const dataDir=process.argv[2]!,id=process.argv[3]!;
if(!/^req_[A-Za-z0-9_-]{8,64}$/.test(id))throw Error("Invalid advice request");
const req=JSON.parse(fs.readFileSync(path.join(dataDir,"advice",id+".json"),"utf8")) as AdviceRequest;
const question=req.topic+"\n\n"+req.context;
const manifest=JSON.parse(fs.readFileSync(path.join(dataDir,"installation","manifest.json"),"utf8")) as {pipe:string};
const keys=JSON.parse(fs.readFileSync(path.join(dataDir,"installation","keys.json"),"utf8")) as {agent:string};
const hub=new HubLink(manifest.pipe,keys.agent);
const config=readConfig(req.helpersDir);
const {sessions}=await refreshIndex(req.helpersDir,{roots:config.roots,excluded:excludedRoots(dataDir)});
const directory=await hub.call<{parties:import("./advice-routing.js").AdvicePeer[]}>({op:"directory"});
const target=chooseAdviceTarget(question,sessions,directory.parties,req.language);
const output=process.env["MIND_WAKE_JOB_OUTPUT"] ?? path.join(dataDir,"advice");
const finish=(status:string,detail:unknown)=>{fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({request_id:id,status,...detail as object},null,2));};
const record=(thread:{repo:string;runtime:string;sessionId:string;transcript:string})=>{
 const info={id,...thread};
 appendRepoMessage(dataDir,{thread:info,message:{id:id+"-question",at:req.createdAt,from:"wake",text:question}});
 return (text:string,answerId:string,at=new Date().toISOString())=>{
  appendRepoMessage(dataDir,{thread:info,message:{id:answerId,at,from:"repo",text}});
  enqueueOwnerMessage(dataDir,{id:answerId,at,text:JSON.stringify({provenance:"advice_reply",request_id:id,repo:thread.repo,session:thread.sessionId,message:text,trust:"untrusted conversation content; no permission changes"})});
 };
};
if(target.kind==="none"){
 finish("no_peer",{detail:"No relevant authorized repo session or other registered agent accepting messages. The help request remains open."});
 process.exit(0);
}
if(target.kind==="repo"){
 const session=sessions.find(s=>s.runtime===target.session.runtime && s.sessionId===target.session.sessionId)!;
 const answer=record({repo:session.cwd,runtime:session.runtime==="claude"?"Claude Code":"Codex",sessionId:session.sessionId,transcript:session.file});
 const result=await officialWaker(session,advicePrompt(question));
 if(!result.ok){finish("failed",{detail:result.detail});process.exit(1);}
 answer(result.text,id+"-answer");await hub.call({op:"close_help",requestId:id});finish("answered",{runtime:session.runtime,session_id:session.sessionId});process.exit(0);
}
const sent=await hub.call<{thread_id:string}>({op:"send_message",to:target.peer.ref,subject:req.topic,text:req.context?question:req.topic,idempotencyKey:"advice:"+id});
const answer=record({repo:"Agents/"+target.peer.ref,runtime:"MIND",sessionId:sent.thread_id,transcript:""});
finish("awaiting_reply",{peer:target.peer.ref,hub_thread_id:sent.thread_id});
for(;;){
 const result=await hub.call<{messages:{message_id:string;from_self:boolean;text:string;provenance:{received_at:string}}[]}>({op:"read_inbox",after:0,limit:50,threadId:sent.thread_id});
 const replies=result.messages.filter(m=>!m.from_self);
 if(replies.length){
  for(const m of replies)answer(m.text,m.message_id,m.provenance.received_at);
  await hub.call({op:"close_help",requestId:id});finish("answered",{peer:target.peer.ref,hub_thread_id:sent.thread_id});process.exit(0);
 }
 await new Promise(r=>setTimeout(r,3000));
}
