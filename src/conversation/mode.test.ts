import fs from "node:fs";
import path from "node:path";
import {spawn, type ChildProcess} from "node:child_process";
import {pathToFileURL} from "node:url";
import Database from "better-sqlite3";
import {afterEach,beforeEach,expect,it} from "vitest";
import {enableConversationMode,inspectConversationMode,CONVERSATION_MODE_FILE} from "./mode.js";
import {acquireInstanceLock,instanceLockPath} from "../scheduler/instance-lock.js";
import type {AdapterId, ProfileId, UtcTimestamp} from "../contracts/index.js";
import {WakeDaemon} from "../daemon/daemon.js";
import {openStore,openStoreReadOnly} from "../store/index.js";
import {prepareProfile,grantLaunch} from "../../test/fixtures/runner/setup.js";
import {ProcessTreeSupervisor} from "../runner/process-tree.js";
import {SessionRunner} from "../runner/runner.js";
import {StopFlag} from "../runner/controls.js";
import {FakeAdapter,fakeScenario} from "../adapters/fake/index.js";

let root:string;
beforeEach(()=>{
  const parent=path.resolve(".local/conversation-mode-tests");fs.mkdirSync(parent,{recursive:true});
  root=fs.mkdtempSync(path.join(parent,"case-"));
});
afterEach(()=>{
  if (!root.startsWith(path.resolve(".local/conversation-mode-tests")+path.sep)) throw Error("Unexpected test workspace");
  fs.rmSync(root,{recursive:true,force:true});
});

it("a read does not create a mode or profile",()=>{
  const before=fs.readdirSync(root);
  expect(inspectConversationMode(root)).toMatchObject({enabled:false,ready:false});
  expect(fs.readdirSync(root)).toEqual(before);
});
it("commits the autonomous-launch guard before stopping a legacy engine and never clears Force-off",async()=>{
  fs.writeFileSync(path.join(root,"emergency-stop.flag"),"human stop");
  let stopped=false;
  const result=await enableConversationMode(root,{
    stopOwnedEngine:async()=>{expect(inspectConversationMode(root)).toMatchObject({enabled:true,ready:false});stopped=true;},
    assertSchedulerStopped:()=>{expect(stopped).toBe(true);},
  });
  expect(result).toMatchObject({enabled:true,ready:true});
  expect(fs.readFileSync(path.join(root,"emergency-stop.flag"),"utf8")).toBe("human stop");
  expect(fs.existsSync(path.join(root,"control.sqlite"))).toBe(false);
});
it("keeps the launch guard enabled when an unowned engine cannot be stopped",async()=>{
  await expect(enableConversationMode(root,{stopOwnedEngine:async()=>{},assertSchedulerStopped:()=>{throw Error("Unowned engine remains");}})).rejects.toThrow("Unowned");
  expect(inspectConversationMode(root)).toMatchObject({enabled:true,ready:false,detail:"Unowned engine remains"});
});
it("requires the actual scheduler lock to be free even if an engine report says stopped",async()=>{
  const lock=acquireInstanceLock(instanceLockPath(root,"default" as ProfileId));
  try {
    await expect(enableConversationMode(root,{stopOwnedEngine:async()=>{},assertSchedulerStopped:()=>{}})).rejects.toThrow("verrou");
    expect(inspectConversationMode(root)).toMatchObject({enabled:true,ready:false});
  } finally {lock.release();}
  await enableConversationMode(root,{stopOwnedEngine:async()=>{},assertSchedulerStopped:()=>{}});
  expect(inspectConversationMode(root).ready).toBe(true);
});
it("fails closed on a damaged mode file instead of resuming auto-wakes",()=>{
  fs.writeFileSync(path.join(root,CONVERSATION_MODE_FILE),"{partial");
  expect(inspectConversationMode(root)).toMatchObject({enabled:true,ready:false});
});
it("prevents daemon preparation before reading or mutating the profile",async()=>{
  await enableConversationMode(root,{stopOwnedEngine:async()=>{},assertSchedulerStopped:()=>{}});
  await expect(WakeDaemon.open({dataDir:root,profileId:"default" as ProfileId,simulated:true})).rejects.toMatchObject({code:"conversation_mode"});
  expect(fs.existsSync(path.join(root,"control.sqlite"))).toBe(false);
});

it.runIf(process.platform==="win32")("migrates an authenticated old owner using the verified Windows stop fallback",async()=>{
  const {OwnedRuntime}=await import(pathToFileURL(path.resolve("scripts/owned-runtime.mjs")).href);
  const installation=path.join(root,"installation");fs.mkdirSync(installation);
  const manifest=path.join(installation,"manifest.json"),entry=path.join(root,"fixture-engine.cjs");
  fs.writeFileSync(manifest,JSON.stringify({version:1,dataDir:root,repoDir:path.resolve(".")}));
  fs.writeFileSync(path.join(installation,"keys.json"),JSON.stringify({owner:"fixture-owner-key"}));
  fs.writeFileSync(path.join(root,"emergency-stop.flag"),"human stop");
  fs.writeFileSync(entry,`const fs=require('node:fs'),crypto=require('node:crypto');fs.writeFileSync(process.env.MIND_WAKE_OWNED_RECEIPT,JSON.stringify({role:'daemon',pid:process.pid,instance:process.env.MIND_WAKE_OWNED_INSTANCE,entry:__filename,loadedRevision:'${"a".repeat(40)}',artifactSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')}));setInterval(()=>{},1000);`);
  let child:ChildProcess|undefined;
  const owner=new OwnedRuntime(manifest,"daemon",async({file,instance}:{file:string;instance:string})=>{
    child=spawn(process.execPath,[entry],{windowsHide:true,stdio:["ignore","ignore","ignore","ipc"],env:{...process.env,MIND_WAKE_OWNED_RECEIPT:file,MIND_WAKE_OWNED_INSTANCE:instance}});
    return {entry,child};
  },{guard:()=>{throw Error("Force-off prevents restart");},readyTimeout:3000});
  owner.stop=async()=>{throw Error("Old owner has no stop operation");};
  try {
    await owner.start();
    const db=new Database(path.join(root,"control.sqlite"));
    db.exec("CREATE TABLE daemon_runs(id TEXT,profile_id TEXT,pid INTEGER,mode TEXT,adapter_id TEXT,started_at TEXT,ended_at TEXT,end_reason TEXT)");
    db.prepare("INSERT INTO daemon_runs VALUES (?,?,?,?,?,?,NULL,NULL)").run("fixture-run","default",child!.pid,"simulated","fake",new Date().toISOString());db.close();
    expect(await enableConversationMode(root)).toMatchObject({enabled:true,ready:true});
    expect(inspectConversationMode(root).ready).toBe(true);
    expect(fs.readFileSync(path.join(root,"emergency-stop.flag"),"utf8")).toBe("human stop");
    expect((await owner.observe()).state).toBe("stopped");
  } finally {await owner.close();}
},20000);

async function orphanFixture(supervisor:ProcessTreeSupervisor,paused=false) {
  const s=openStore(path.join(root,"control.sqlite"));prepareProfile(s.uow);
  try {
    const profileId="default" as ProfileId;
    const runner=new SessionRunner({uow:s.uow,profileId,supervisor,stopFlag:new StopFlag(root),
      liveChecks:()=>({onSubscription:false,sandboxOperational:true}),adapter:host=>new FakeAdapter({host,scenario:fakeScenario("success")})});
    const grant=await grantLaunch(s.uow,runner);
    if(grant.decision.verdict!=="allow")throw Error("Fixture launch not authorized");
    const at=new Date().toISOString() as UtcTimestamp;
    s.uow.sessions.create({id:grant.sessionId,profileId,experimentId:null,adapterId:"fake" as AdapterId,
      policyRevisionId:grant.decision.revisionId,reservationId:grant.reservationId,startedAt:at,endedAt:null,outcome:null,outcomeReason:null});
    s.uow.profiles.transition(profileId,{from:"ready",to:paused?"paused":"running",at,reason:"Synthetic orphan fixture; no model or process started"});
    return grant;
  }finally{s.close();}
}
function absentModelTree():ProcessTreeSupervisor {
  const supervisor=new ProcessTreeSupervisor(path.join(root,"fixture-runtime"),"linux");
  supervisor.query=()=>({found:false,active:0});
  return supervisor;
}
it("reconciles proven stopped model sessions and conservatively closes their reservation",async()=>{
  const supervisor=absentModelTree(),grant=await orphanFixture(supervisor);
  await enableConversationMode(root,{stopOwnedEngine:async()=>{},recoverySupervisor:supervisor});
  const s=openStoreReadOnly(path.join(root,"control.sqlite"));
  try {
    expect(s.uow.sessions.get(grant.sessionId)?.outcome).toBe("orphaned");
    expect(s.uow.ledger.getReservation(grant.reservationId)?.status).toBe("uncertain");
    expect(s.uow.profiles.get("default" as ProfileId)?.state).toBe("blocked");
    expect(s.uow.journal.list("default" as ProfileId).filter(e=>e.type==="session_started")).toEqual([]);
  }finally{s.close();}
});
it("never closes an orphan when the old model tree cannot be proven stopped",async()=>{
  const supervisor=absentModelTree(),grant=await orphanFixture(supervisor);
  supervisor.query=()=>({found:null,active:null});
  await expect(enableConversationMode(root,{stopOwnedEngine:async()=>{},recoverySupervisor:supervisor})).rejects.toThrow("Cannot prove");
  const s=openStoreReadOnly(path.join(root,"control.sqlite"));
  try {expect(s.uow.sessions.get(grant.sessionId)?.outcome).toBeNull();}finally{s.close();}
  expect(inspectConversationMode(root).ready).toBe(false);
});
it("preserves Pause and Force-off during orphan reconciliation",async()=>{
  const supervisor=absentModelTree(),grant=await orphanFixture(supervisor,true);
  await enableConversationMode(root,{stopOwnedEngine:async()=>{},recoverySupervisor:supervisor});
  let s=openStoreReadOnly(path.join(root,"control.sqlite"));
  try {expect(s.uow.profiles.get("default" as ProfileId)?.state).toBe("paused");expect(s.uow.sessions.get(grant.sessionId)?.outcome).toBe("orphaned");}finally{s.close();}
  fs.writeFileSync(path.join(root,"emergency-stop.flag"),"preserve this human stop");
  await enableConversationMode(root,{stopOwnedEngine:async()=>{},recoverySupervisor:supervisor});
  s=openStoreReadOnly(path.join(root,"control.sqlite"));
  try {expect(s.uow.profiles.get("default" as ProfileId)).toMatchObject({state:"stopped",emergencyStopLocked:true});}finally{s.close();}
  expect(fs.readFileSync(path.join(root,"emergency-stop.flag"),"utf8")).toBe("preserve this human stop");
});
