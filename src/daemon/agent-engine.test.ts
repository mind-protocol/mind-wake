import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  alternate,
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
  "retries an unavailable %s once and remembers the cooldown",
  async (primary) => {
    const { dir, choice } = setup(primary);
    const attempts: Engine[] = [];
    const result = await launchAgentSession(
      dir,
      primary,
      async (engine) => {
        attempts.push(engine);
        if (engine === primary) throw Error("lanceur : CreateProcess 2");
        return "OK";
      },
      () => null,
      () => true,
    );
    expect(result).toBe("OK");
    expect(attempts).toEqual([primary, alternate(primary)]);
    expect(preferredEngine(dir, choice)).toBe(alternate(primary));
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

it("lets the available backend handle a room retry tied exactly to the blocked provider", async () => {
  const {dir,choice}=setup("claude"),now=Date.now(),until=now+60*60_000;
  const file=path.join(dir,"agent-engine-claude.json");
  fs.writeFileSync(file,JSON.stringify({revision:choice.revision,until}));
  fs.writeFileSync(path.join(dir,"agent-engine-codex.json"),JSON.stringify({revision:choice.revision,until:now-1000}));
  const before=fs.readFileSync(file,"utf8");
  expect(preferredEngine(dir,choice)).toBe("codex");expect(engineAwareRetryAt(dir,until,now)).toBe(0);
  const attempts:Engine[]=[];
  await launchAgentSession(dir,"claude",async engine=>{attempts.push(engine);return "OK";},()=>null,()=>true);
  expect(attempts).toEqual(["codex"]);expect(fs.readFileSync(file,"utf8")).toBe(before);
});
it("preserves a disk or unknown retry even when a different provider cooldown exists",()=>{
  const {dir,choice}=setup("claude"),now=Date.now(),providerUntil=now+60*60_000,unknownRetry=now+2*60_000;
  fs.writeFileSync(path.join(dir,"agent-engine-claude.json"),JSON.stringify({revision:choice.revision,until:providerUntil}));
  expect(engineAwareRetryAt(dir,unknownRetry,now)).toBe(unknownRetry);
});
it("waits while both providers are blocked, including a room without its own retry",()=>{
  const {dir,choice}=setup("claude"),now=Date.now(),claudeUntil=now+60*60_000,codexUntil=now+10*60_000;
  fs.writeFileSync(path.join(dir,"agent-engine-claude.json"),JSON.stringify({revision:choice.revision,until:claudeUntil}));
  fs.writeFileSync(path.join(dir,"agent-engine-codex.json"),JSON.stringify({revision:choice.revision,until:codexUntil}));
  expect(engineAwareRetryAt(dir,claudeUntil,now)).toBe(codexUntil);expect(engineAwareRetryAt(dir,0,now)).toBe(codexUntil);
});
it("retains legacy or unproven barriers without matching provider evidence",()=>{
  const {dir,choice}=setup("claude"),now=Date.now(),retryAt=now+60_000;
  expect(engineAwareRetryAt(dir,retryAt,now)).toBe(retryAt);
  fs.writeFileSync(path.join(dir,"agent-engine-claude.json"),JSON.stringify({revision:"other-revision",until:retryAt}));
  expect(engineAwareRetryAt(dir,retryAt,now)).toBe(retryAt);
  fs.rmSync(path.join(dir,"agent-engine.json"));expect(engineAwareRetryAt(dir,retryAt,now)).toBe(retryAt);
  expect(choice.preferred).toBe("claude");
});
