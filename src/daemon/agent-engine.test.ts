import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  alternate,
  engineChoice,
  launchAgentSession,
  preferredEngine,
  providerFailure,
  setEngineChoice,
  engineAwareRetryAt,
  type Engine,
} from "./agent-engine.js";

const dirs: string[] = [];
function setup(primary: Engine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-engine-test-"));
  dirs.push(dir);
  const choice = setEngineChoice(dir, primary);
  return { dir, choice };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
it.each(["claude", "codex"] as const)(
  "keeps the global %s choice even when unavailable",
  async (primary) => {
    const { dir, choice } = setup(primary);
    const attempts: Engine[] = [];
    await expect(launchAgentSession(
      dir,
      primary,
      async (engine) => {
        attempts.push(engine);
        if (engine === primary) throw Error("lanceur : CreateProcess 2");
        return "OK";
      },
      () => null,
      () => true,
    )).rejects.toThrow("CreateProcess 2");
    expect(attempts).toEqual([primary]);
    expect(preferredEngine(dir, choice)).toBe(primary);
  },
);
it.each([
  [false, true],
  [true, false],
])("respects pause and work already executed", async (allowed, replay) => {
  const { dir } = setup("claude");
  const attempts: Engine[] = [];
  await launchAgentSession(
    dir,
    "claude",
    async (engine) => {
      attempts.push(engine);
      return "rate_limited";
    },
    () => ({ replay }),
    () => allowed,
  );
  expect(attempts).toEqual(["claude"]);
});
it("distinguishes a transport failure from a local permission error", () => {
  expect(providerFailure("ECONNRESET")).toBe(true);
  expect(providerFailure("policy refused this command")).toBe(false);
});

it("keeps rooms on the selected provider and preserves its cooldown", async () => {
  const {dir,choice}=setup("claude"),now=Date.now(),until=now+60*60_000;
  const file=path.join(dir,"agent-engine-claude.json");
  fs.writeFileSync(file,JSON.stringify({revision:choice.revision,until}));
  fs.writeFileSync(path.join(dir,"agent-engine-codex.json"),JSON.stringify({revision:choice.revision,until:now-1000}));
  const before=fs.readFileSync(file,"utf8");
  expect(preferredEngine(dir,choice)).toBe("claude");expect(engineAwareRetryAt(dir,until,now)).toBe(until);
  const attempts:Engine[]=[];
  await launchAgentSession(dir,"claude",async engine=>{attempts.push(engine);return "OK";},()=>null,()=>true);
  expect(attempts).toEqual(["claude"]);expect(fs.readFileSync(file,"utf8")).toBe(before);
});
it("preserves a disk or unknown retry even when a different provider cooldown exists",()=>{
  const {dir,choice}=setup("claude"),now=Date.now(),providerUntil=now+60*60_000,unknownRetry=now+2*60_000;
  fs.writeFileSync(path.join(dir,"agent-engine-claude.json"),JSON.stringify({revision:choice.revision,until:providerUntil}));
  expect(engineAwareRetryAt(dir,unknownRetry,now)).toBe(providerUntil);
});
it("waits for the selected provider even if the other recovers sooner",()=>{
  const {dir,choice}=setup("claude"),now=Date.now(),claudeUntil=now+60*60_000,codexUntil=now+10*60_000;
  fs.writeFileSync(path.join(dir,"agent-engine-claude.json"),JSON.stringify({revision:choice.revision,until:claudeUntil}));
  fs.writeFileSync(path.join(dir,"agent-engine-codex.json"),JSON.stringify({revision:choice.revision,until:codexUntil}));
  expect(engineAwareRetryAt(dir,claudeUntil,now)).toBe(claudeUntil);expect(engineAwareRetryAt(dir,0,now)).toBe(claudeUntil);
});
it("retains legacy or unproven barriers without matching provider evidence",()=>{
  const {dir,choice}=setup("claude"),now=Date.now(),retryAt=now+60_000;
  expect(engineAwareRetryAt(dir,retryAt,now)).toBe(retryAt);
  fs.writeFileSync(path.join(dir,"agent-engine-claude.json"),JSON.stringify({revision:"other-revision",until:retryAt}));
  expect(engineAwareRetryAt(dir,retryAt,now)).toBe(retryAt);
  fs.rmSync(path.join(dir,"agent-engine.json"));expect(engineAwareRetryAt(dir,retryAt,now)).toBe(retryAt);
  expect(choice.preferred).toBe("claude");
});

it.each(["claude", "codex"] as const)("uses global %s instead of any agent assignment", async selected => {
  const {dir}=setup(selected);
  const attempts:Engine[]=[];
  const result=await launchAgentSession(dir,alternate(selected),async engine=>{attempts.push(engine);return "rate_limited";},()=>({replay:true}),()=>true);
  expect(result).toBe("rate_limited");
  expect(attempts).toEqual([selected]);
});
it("uses one default for all agents without a legacy global setting", async()=>{
  const {dir}=setup("codex");
  fs.rmSync(path.join(dir,"agent-engine.json"));
  expect(engineChoice(dir).preferred).toBe("claude");
  for(const original of ["claude","codex"] as const)
    expect(await launchAgentSession(dir,original,async engine=>engine,()=>null,()=>true)).toBe("claude");
});
it("ignores only a retry proven to belong to the unselected provider",()=>{
  const {dir,choice}=setup("codex"),now=Date.now(),until=now+60_000;
  fs.writeFileSync(path.join(dir,"agent-engine-claude.json"),JSON.stringify({revision:choice.revision,until}));
  expect(engineAwareRetryAt(dir,until,now)).toBe(0);
  expect(engineAwareRetryAt(dir,until+1,now)).toBe(until+1);
});
