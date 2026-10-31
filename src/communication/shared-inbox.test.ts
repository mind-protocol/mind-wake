import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SharedInboxSession, loadSharedInboxBinding, openSharedInboxSession, type SharedInboxTransport } from "./shared-inbox.js";
import type { SharedInboxCall } from "./shared-inbox-https.js";
import { CodexOwnerSteering } from "../adapters/codex/owner-steering.js";
import { ownerMessagePending, readOwnerInboxHistory, readOwnerReceipts, enqueueOwnerMessage } from "./owner-inbox.js";

let dir: string;
const sessions: SharedInboxSession[] = [], steerings: CodexOwnerSteering[] = [];
const agent = "agent-dckgeedfrm", marco = "agent-abcdefghjk", human = "human-mkcv2hapch";
const binding = {enabled:true as const, profileId:"chosen", endpoint:"https://hub.example/v1/messages", agentRef:agent, keyFile:"C:/private/existing-agent.key"};
const entry = (sequence: number, from: string, thread = "thr_Marco123", to = agent, from_self = false) => ({
  message_id:`msg_number${sequence}ab`, sequence, from, to, from_self, thread_id:thread,
  text:from === human ? "Bonjour, tu confirmes reception ?" : "Point SciSense",
  provenance:{kind:from === human ? "human" : "agent", channel:"mind-shared-hub", received_at:"2026-10-31T00:07:41Z"},
});
function transport(messages: ReturnType<typeof entry>[], identity = {ref:agent,kind:"agent"}) {
  const calls: SharedInboxCall[] = [];
  const wire: SharedInboxTransport = {async call<T>(call: SharedInboxCall): Promise<T> {
    calls.push(call);
    return (call.op === "whoami" ? identity : (() => {
      const page = messages.filter(m => m.sequence > call.after).slice(0,call.limit);
      return {messages:page,next:page.at(-1)?.sequence ?? call.after};
    })()) as T;
  }};
  return {wire,calls};
}
function receiver(wire:SharedInboxTransport,active:()=>boolean = ()=>true) {
  const session = new SharedInboxSession(dir,binding,wire,active); sessions.push(session); return session;
}
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),"wake-shared-inbox-"));});
afterEach(()=>{
  for(const item of sessions.splice(0)) item.stop();
  for(const item of steerings.splice(0)) item.stop();
  vi.useRealTimers(); fs.rmSync(dir,{recursive:true,force:true});
});

it("receives all correspondents into an active Codex turn, including the human thread distinct from Marco",async()=>{
  const messages=[entry(1,marco)],remote=transport(messages),session=receiver(remote.wire);
  const request=vi.fn(async()=>({turnId:"turn"}));
  const steering=new CodexOwnerSteering(dir,"wake-session","codex-thread","turn",{request},()=>true);steerings.push(steering);
  await session.sync(); await steering.flush();
  messages.push(entry(2,human,"thr_Human123"));
  await session.sync(); await steering.flush();
  expect(remote.calls.filter(c=>c.op==="read_inbox")).toEqual([
    {op:"read_inbox",after:0,limit:50},{op:"read_inbox",after:1,limit:50},
  ]);
  expect(request).toHaveBeenCalledTimes(2);
  const last=request.mock.calls[1] as unknown as [string,{expectedTurnId:string;input:{text:string}[]}];
  expect(last[0]).toBe("turn/steer");expect(last[1].expectedTurnId).toBe("turn");
  const delivered=JSON.parse(last[1].input[0]!.text.split("\n").slice(1).join("\n"));
  expect(delivered.origin).toMatchObject({kind:"peer_message",senderRef:human,threadId:"thr_Human123"});
  expect(delivered.text).toBe(messages[1]!.text);
  expect(Object.keys(readOwnerReceipts(dir))).toHaveLength(2);
  await session.sync();await steering.flush();expect(request).toHaveBeenCalledTimes(2);
  expect(ownerMessagePending(dir,true)).toBe(false);
});

it("persists deduplication across receiver restarts and crash-style cursor replay, without creating a wake request",async()=>{
  const remote=transport([entry(1,marco),entry(2,human,"thr_Human123")]);
  await receiver(remote.wire).sync();
  expect(ownerMessagePending(dir)).toBe(true);expect(ownerMessagePending(dir,true)).toBe(false);
  const db=new Database(path.join(dir,"shared-inbox.sqlite"));db.prepare("UPDATE cursors SET sequence=0").run();db.close();
  await receiver(remote.wire).sync();
  expect(readOwnerInboxHistory(dir)).toHaveLength(2);
  await receiver(remote.wire).sync();
  expect(remote.calls.at(-1)).toMatchObject({after:2});
  enqueueOwnerMessage(dir,{id:"local-human",at:"2026-10-31T00:07:41Z",text:"local"});
  expect(ownerMessagePending(dir,true)).toBe(true);
});

it.each(["pause","force-off"])("does not access network while %s, and discards in-flight results before persistence",async()=>{
  let active=false;
  const remote=transport([entry(1,human,"thr_Human123")]);const session=receiver(remote.wire,()=>active);
  await session.sync();expect(remote.calls).toHaveLength(0);
  active=true;
  let finish!: (result:unknown)=>void;
  const slow:SharedInboxTransport={async call<T>(call:SharedInboxCall):Promise<T>{
    if(call.op==="whoami")return {ref:agent,kind:"agent"} as T;
    return await new Promise<T>(resolve=>{finish=resolve as (result:unknown)=>void;});
  }};
  const pending=receiver(slow,()=>active).sync();
  await vi.waitFor(()=>expect(finish).toBeDefined());
  active=false;finish({messages:[entry(1,human,"thr_Human123")],next:1});await pending;
  expect(readOwnerInboxHistory(dir)).toEqual([]);
  active=true;await receiver(remote.wire,()=>active).sync();expect(readOwnerInboxHistory(dir)).toHaveLength(1);
  await receiver(remote.wire,()=>active).sync();expect(readOwnerInboxHistory(dir)).toHaveLength(1);
});

it("cancels the session-owned timer and in-flight request on pause or stop",async()=>{
  vi.useFakeTimers();let active=true;let signal:AbortSignal|undefined;let reads=0;
  const wire:SharedInboxTransport={async call<T>(call:SharedInboxCall,cancel?:AbortSignal):Promise<T>{
    if(call.op==="whoami")return {ref:agent,kind:"agent"} as T;
    reads++;signal=cancel;
    return await new Promise<T>((_resolve,reject)=>cancel?.addEventListener("abort",()=>reject(Error("aborted")),{once:true}));
  }};
  const session=receiver(wire,()=>active);session.start(()=>{});
  await vi.advanceTimersByTimeAsync(250);expect(reads).toBe(1);
  active=false;await vi.advanceTimersByTimeAsync(250);expect(signal?.aborted).toBe(true);
  active=true;await vi.advanceTimersByTimeAsync(20_000);expect(reads).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("requires an explicit matching profile and authenticated agent, never a human key",async()=>{
  expect(loadSharedInboxBinding(dir,"chosen")).toBeNull();
  expect(openSharedInboxSession(dir,"chosen",()=>false)).toBeNull();
  fs.writeFileSync(path.join(dir,"shared-inbox.json"),JSON.stringify(binding));
  expect(()=>loadSharedInboxBinding(dir,"other")).toThrow("mismatch");
  fs.writeFileSync(path.join(dir,"shared-inbox.json"),JSON.stringify({...binding,enabled:false}));
  expect(loadSharedInboxBinding(dir,"chosen")).toBeNull();
  for(const identity of [{ref:human,kind:"human"},{ref:marco,kind:"agent"}]){
    const remote=transport([],identity);await expect(receiver(remote.wire).sync()).rejects.toThrow("bound agent");
    expect(remote.calls).toEqual([{op:"whoami"}]);
  }
  expect(fs.existsSync(path.join(dir,"shared-inbox.sqlite"))).toBe(false);
});

it("filters self and other-recipient entries and rejects a broken page before advancing its cursor",async()=>{
  const remote=transport([entry(1,agent,"thr_Marco123",agent,true),entry(2,human,"thr_Human123",marco),entry(3,marco)]);
  await receiver(remote.wire).sync();expect(readOwnerInboxHistory(dir).map(m=>m.origin?.senderRef)).toEqual([marco]);
  const broken:SharedInboxTransport={async call<T>(call:SharedInboxCall):Promise<T>{return (call.op==="whoami"?{ref:agent,kind:"agent"}:{messages:[entry(4,human,"thr_Human123")],next:100}) as T;}};
  await expect(receiver(broken).sync()).rejects.toThrow("cursor");
  expect(readOwnerInboxHistory(dir)).toHaveLength(1);
  await receiver(remote.wire).sync();expect(remote.calls.at(-1)).toMatchObject({after:3});
});

it("separates global cursors by endpoint and identity, never adopting tool thread cursors",async()=>{
 const remote=transport([entry(1,marco)]);await receiver(remote.wire).sync();
 const otherEndpoint=transport([entry(1,marco)]);
 const second=new SharedInboxSession(dir,{...binding,endpoint:"https://other-hub.example/v1/messages"},otherEndpoint.wire,()=>true);sessions.push(second);
 await second.sync();expect(otherEndpoint.calls.at(-1)).toEqual({op:"read_inbox",after:0,limit:50});
 const otherAgent="agent-bcdefghjkm";
 const otherIdentity=transport([entry(1,human,"thr_Human123",otherAgent)],{ref:otherAgent,kind:"agent"});
 const third=new SharedInboxSession(dir,{...binding,agentRef:otherAgent},otherIdentity.wire,()=>true);sessions.push(third);
 await third.sync();expect(otherIdentity.calls.at(-1)).toEqual({op:"read_inbox",after:0,limit:50});
 const db=new Database(path.join(dir,"shared-inbox.sqlite"));
 expect(db.prepare("SELECT * FROM cursors").all()).toHaveLength(3);db.close();
 expect(remote.calls.every(call=>!("threadId" in call))).toBe(true);
});

it("keeps the global cursor unchanged after a partial page enqueue failure and replays stable IDs",async()=>{
 const remote=transport([entry(1,marco),entry(2,human,"thr_Human123")]);
 const route=createHash("sha256").update(JSON.stringify(["global-inbox",binding.endpoint,binding.agentRef])).digest("hex");
 const failedId=`shared-inbox:${route}:msg_number2ab`;
 enqueueOwnerMessage(dir,{id:failedId,at:"2026-10-31T00:07:41Z",text:"conflict simulates a failed second enqueue"});
 await expect(receiver(remote.wire).sync()).rejects.toThrow("Conflicting");
 const cursor=new Database(path.join(dir,"shared-inbox.sqlite"));expect(cursor.prepare("SELECT * FROM cursors").all()).toEqual([]);cursor.close();
 expect(readOwnerInboxHistory(dir).filter(m=>m.origin?.messageId==="msg_number1ab")).toHaveLength(1);
 const queue=new Database(path.join(dir,"owner-inbox.sqlite"));queue.prepare("DELETE FROM inbox WHERE id=?").run(failedId);queue.close();
 await receiver(remote.wire).sync();
 expect(remote.calls.at(-1)).toMatchObject({after:0});
 expect(readOwnerInboxHistory(dir)).toHaveLength(2);
 expect(readOwnerInboxHistory(dir).filter(m=>m.origin?.messageId==="msg_number1ab")).toHaveLength(1);
 await receiver(remote.wire).sync();expect(remote.calls.at(-1)).toMatchObject({after:2});
});
