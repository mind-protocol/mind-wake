import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCli } from "./run.js";
import { processContext, DEFAULT_PROFILE_ID, DEFAULT_AGENT_ID } from "./context.js";
import { MemoryUnitOfWork } from "./store/memory.js";
import { WakeManager } from "../daemon/wake-manager.js";
import type { ProfileState, UtcTimestamp } from "../contracts/index.js";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, {recursive:true, force:true}); });
it.each(["paused", "stopped", "disabled", "checkpointing"] as ProfileState[])("rejects owner scheduling changes while %s", async state => {
  const fixture = setup(state);
  expect(await fixture.run()).toBe(1);
  expect(fixture.manager.status()?.revision).toBe(fixture.revision);
  fixture.manager.close();
});
it("routes an owner reorder through the CLI and rejects stale replay", async () => {
  const fixture = setup("blocked");
  try {
    expect(await fixture.run()).toBe(0);
    expect(fixture.manager.next(1).wakes[0]?.projectId).toBe("b");
    expect(await fixture.run()).toBe(1);
    expect(fixture.manager.status()?.used).toBe(0);
  } finally { fixture.manager.close(); }
});
function setup(state: ProfileState) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-order-")); folders.push(dir);
  const workspace = path.join(dir, "workspace"); fs.mkdirSync(path.join(workspace, "artifacts"), {recursive:true});
  fs.writeFileSync(path.join(workspace,"artifacts/projets-compteur.json"), JSON.stringify({current:"a", projects:{a:{status:"en cours"},b:{status:"en cours"}}}));
  const manager = new WakeManager(workspace); manager.configure(true);
  const revision = manager.status()!.revision;
  const projects = manager.next(500).wakes.filter(wake => wake.inBlock === 1).map(wake => wake.projectId!).reverse();
  const uow = new MemoryUnitOfWork();
  uow.profiles.create({id:DEFAULT_PROFILE_ID,agentId:DEFAULT_AGENT_ID,state,activePolicyRevisionId:null,nextWakeAt:null,emergencyStopLocked:false,stateReason:"test",updatedAt:new Date().toISOString() as UtcTimestamp});
  const ctx = {...processContext(), env:{},stdout:()=>{},stderr:()=>{},readStdin:async()=>JSON.stringify({revision,projectIds:projects}),openStore:()=>({uow,persistence:"memory" as const,dataDir:dir,close:()=>{}})};
  return {manager, revision, run:()=>runCli(["wake-order","--data-dir",dir,"--json"],ctx)};
}
