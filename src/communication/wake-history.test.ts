import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {it,expect} from "vitest";
import {parseWakeTranscript,readWakeHistory,readWakeLocations} from "./wake-history.js";
import {claudeSessionUuid} from "../adapters/claude/conversation.js";
const row=(type:string,id:string,content:unknown)=>JSON.stringify({type,uuid:id,timestamp:"2026-10-29T19:00:00Z",message:{content}});
it("links to the prompt recorded for the current conversation, not an arbitrary newer file",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wake-locations-"));
 try {
  expect(readWakeLocations(dir).systemPrompt).toBeNull();
  const runtime=path.join(dir,"runtimes","claude"),prompts=path.join(runtime,"prompts");
  fs.mkdirSync(prompts,{recursive:true});
  const digest="a".repeat(64),file=path.join(prompts,"system-prompt-"+digest.slice(0,16)+".md");
  fs.writeFileSync(file,"Actual loaded direction");
  fs.writeFileSync(path.join(prompts,"system-prompt-newer.md"),"Not loaded");
  fs.writeFileSync(path.join(runtime,"default-conversation.json"),JSON.stringify({key:"current"}));
  fs.writeFileSync(path.join(runtime,"conversations.json"),JSON.stringify({current:{promptDigest:digest}}));
  expect(readWakeLocations(dir)).toEqual({workspace:path.join(dir,"workspace"),systemPrompt:fs.realpathSync(file)});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
it("shows real wake prompts and visible assistant text, excluding reasoning, tool outputs and duplicate events",()=>{
 const raw=["partial line",row("user","p","Where was I?"),
 row("user","image","[Image: original 1200x2600, displayed at 923x2000. Multiply coordinates by 1.30 to map to original image.]"),
 row("assistant","a",[{type:"thinking",thinking:"private reasoning"},{type:"text",text:"I made a sketch."},{type:"tool_use",name:"Bash"}]),
 row("user","tool",[{type:"tool_result",content:"tool output"}]),
 row("assistant","a",[{type:"text",text:"I made a sketch."}]),
 row("user","q",[{type:"text",text:"Let’s continue."}])].join("\n");
 const turns=parseWakeTranscript(raw,"s");
 expect(turns).toHaveLength(2);
 expect(turns[0]!.prompt).toContain("Where was I?");
 expect(turns[0]!.prompt).toContain("[Image: original");
 expect(turns[0]!.responses.map(r=>r.text)).toEqual(["I made a sketch."]);
 expect(turns[1]!.responses).toEqual([]);
 expect(JSON.stringify(turns)).not.toContain("private reasoning");
});
it("reads only sessions recorded by this Wake profile, not other local conversations",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wake-history-"));
 try {
 const data=path.join(dir,"profile"),config=path.join(dir,"config");
 fs.mkdirSync(path.join(data,"runtimes","claude"),{recursive:true});
 fs.writeFileSync(path.join(data,"runtimes","claude","conversations.json"),JSON.stringify({w:{key:"w",generation:0}}));
 const projects=path.join(config,"projects",path.join(data,"workspace").replace(/[^a-zA-Z0-9]/g,"-"));
 fs.mkdirSync(projects,{recursive:true});
 fs.writeFileSync(path.join(projects,claudeSessionUuid("w",0)+".jsonl"),row("user","p","A genuine wake"));
 fs.writeFileSync(path.join(projects,"unrelated.jsonl"),row("user","x","Do not show this"));
 const result=readWakeHistory(data,config);
 expect(result.turns.map(t=>t.prompt)).toEqual(["A genuine wake"]);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

it("keeps replies with their wake across compaction and internal task notifications",()=>{
 const raw=[row("user","wake","Where was I?"),
 row("assistant","a",[{type:"text",text:"First answer"}]),
 row("user","compact-command","<command-name>/compact</command-name>"),
 JSON.stringify({type:"user",uuid:"summary",isCompactSummary:true,message:{content:"This session is being continued..."}}),
 row("user","compact-output","<local-command-stdout>Compacted</local-command-stdout>"),
 row("user","task","<task-notification>Done</task-notification>"),
 row("assistant","b",[{type:"text",text:"Second answer"}])].join("\n");
 const turns=parseWakeTranscript(raw,"s");
 expect(turns).toHaveLength(1);
 expect(turns[0]!.responses.map(r=>r.text)).toEqual(["First answer","Second answer"]);
});
it("retains visible replies when the loaded tail starts after their wake prompt",()=>{
 const turns=parseWakeTranscript(row("assistant","a",[{type:"text",text:"Still a real answer"}]),"s");
 expect(turns[0]).toMatchObject({prompt:"",promptMissing:true,responses:[{id:"a",text:"Still a real answer"}]});
});
it("includes owner-channel answers only after successful local MCP publication",()=>{
 const call=(id:string,text:string)=>row("assistant",id,[{type:"tool_use",id,name:"mcp__mind__message_owner",input:{text}}]);
 const result=(id:string,text:string,error=false)=>row("user",`r-${id}`,[{type:"tool_result",tool_use_id:id,is_error:error,content:[{type:"text",text:JSON.stringify({schema:"mind.mcp/message_owner",message:{id:`own-${id}`,text}})}]}]);
 const turns=parseWakeTranscript([row("user","wake","Continue"),call("ok","Published"),result("ok","Published"),call("failed","Do not display"),result("failed","Do not display",true),call("pending","Not yet sent")].join("\n"),"s");
 expect(turns[0]!.responses.map(r=>r.text)).toEqual(["Published"]);
});
