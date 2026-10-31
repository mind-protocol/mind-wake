/** Isolated SQLite/control tests: no provider or installed profile is addressed. */
import fs from "node:fs";
import path from "node:path";
import {afterEach,beforeEach,expect,it} from "vitest";
import {conversationCommand} from "./cli.js";
import {ConversationStore} from "./store.js";
import {serveConversation,workerFile} from "./worker.js";
import {openStore,openStoreReadOnly} from "../store/index.js";
import {StopFlag} from "../runner/controls.js";
import {prepareProfile,PROFILE} from "../../test/fixtures/runner/setup.js";
import type {UtcTimestamp} from "../contracts/index.js";

let root:string;
beforeEach(()=>{
  const parent=path.resolve(".local/conversation-control-tests");fs.mkdirSync(parent,{recursive:true});
  root=fs.mkdtempSync(path.join(parent,"case-"));
  const store=openStore(path.join(root,"control.sqlite"));try{prepareProfile(store.uow);}finally{store.close();}
});
afterEach(()=>{
  if(!root.startsWith(path.resolve(".local/conversation-control-tests")+path.sep))throw Error("Unexpected fixture path");
  fs.rmSync(root,{recursive:true,force:true});
});
it("read and submit preserve a global stop and expose its exact reason without launching",async()=>{
  new StopFlag(root).write("Synthetic human Force-off",new Date().toISOString() as UtcTimestamp);
  let launches=0;
  const options={launch:async()=>{launches++;}};
  const read=await conversationCommand(root,"read",{},options);
  expect(read["controls"]).toEqual({allowed:false,reason:"emergency_stop_pending"});
  const sent=await conversationCommand(root,"submit",{text:"Keep this message queued",idempotencyKey:"request-1"},options);
  expect(sent["controls"]).toEqual({allowed:false,reason:"emergency_stop_pending"});
  expect(launches).toBe(0);expect(new StopFlag(root).exists()).toBe(true);
});
it("can activate a hibernating profile without incorrectly requesting a pause resume",async()=>{
  const control=openStore(path.join(root,"control.sqlite"));
  const at=new Date().toISOString() as UtcTimestamp;
  try{
    control.uow.profiles.transition(PROFILE,{from:"ready",to:"running",at,reason:"Synthetic fixture"});
    control.uow.profiles.transition(PROFILE,{from:"running",to:"checkpointing",at,reason:"Synthetic fixture"});
    control.uow.profiles.transition(PROFILE,{from:"checkpointing",to:"hibernating",at,reason:"Synthetic fixture"});
  }finally{control.close();}
  const actions:string[]=[];
  const result=await conversationCommand(root,"activate",{},{allow:()=>true,
    enableMode:async()=>{actions.push("mode-confirmed");},launch:async()=>{actions.push("launch");}});
  expect(actions[0]).toBe("mode-confirmed");expect(actions.at(-1)).toBe("launch");
  expect(result["controls"]).toEqual({allowed:true});
});
it("only explicit activation clears a persisted Force-off, after the mode handoff",async()=>{
  const control=openStore(path.join(root,"control.sqlite"));
  const at=new Date().toISOString() as UtcTimestamp;
  try{control.uow.profiles.transition(PROFILE,{from:"ready",to:"stopped",at,reason:"Synthetic human stop"});control.uow.profiles.setEmergencyStopLocked(PROFILE,true,at);}finally{control.close();}
  new StopFlag(root).write("Synthetic human stop",at);
  const before: boolean[]=[];
  await conversationCommand(root,"activate",{},{allow:()=>true,enableMode:async()=>{before.push(new StopFlag(root).exists());},launch:async()=>{}});
  expect(before[0]).toBe(true);
  expect(new StopFlag(root).exists()).toBe(false);
  const read=openStoreReadOnly(path.join(root,"control.sqlite"));
  try{expect(read.uow.profiles.get(PROFILE)).toMatchObject({state:"ready",emergencyStopLocked:false});}finally{read.close();}
});
it("releases the worker pipe when ownership-file validation fails before the loop",async()=>{
  const store=new ConversationStore(root);store.createConversation("main");store.close();
  const file=workerFile(root,"main");fs.mkdirSync(file);
  const runtime={run:async()=>{throw Error("No model call is expected in this test");}};
  await expect(serveConversation(root,"main",{runtime,allow:()=>false})).rejects.toThrow("Invalid worker owner file");
  fs.rmdirSync(file);
  await serveConversation(root,"main",{runtime,allow:()=>false});
  const read=new ConversationStore(root);
  try{expect(read.events("main").some(e=>e.kind==="runtime_blocked")).toBe(true);}finally{read.close();}
  expect(fs.existsSync(file)).toBe(false);
});
