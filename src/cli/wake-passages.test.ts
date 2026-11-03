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
afterEach(() => {
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function setup(state: ProfileState = "ready", locked = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-passages-cli-"));
  folders.push(dir);
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(path.join(workspace, "artifacts"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "artifacts/projets-compteur.json"),
    JSON.stringify({ current: "a", projects: { a: { status: "en cours" } } }),
  );
  const manager = new WakeManager(workspace);
  manager.configure(true);
  const expectedRevision = manager.status()!.revision;
  const uow = new MemoryUnitOfWork();
  uow.profiles.create({
    id: DEFAULT_PROFILE_ID,
    agentId: DEFAULT_AGENT_ID,
    state,
    activePolicyRevisionId: null,
    nextWakeAt: null,
    emergencyStopLocked: locked,
    stateReason: "fixture",
    updatedAt: new Date().toISOString() as UtcTimestamp,
  });
  let body: Record<string, unknown> = {
    operation: "import",
    mode: "validate",
    expectedRevision,
    passages: [
      {
        id: "one",
        projectId: "a",
        question: "question",
        expected: "proof",
        sources: ["source.md"],
      },
    ],
  };
  const ctx = {
    ...processContext(),
    env: {},
    stdout: () => {},
    stderr: () => {},
    readStdin: async () => JSON.stringify(body),
    openStore: () => ({ uow, persistence: "memory" as const, dataDir: dir, close: () => {} }),
  };
  return {
    manager,
    uow,
    dir,
    get body(): Record<string, unknown> {
      return body;
    },
    set body(value: Record<string, unknown>) {
      body = value;
    },
    run: () => runCli(["wake-passages", "--data-dir", dir, "--json"], ctx),
  };
}
it("requires explicit validation/apply and revision, routes import and targeted planning, rejects stale replay", async () => {
  const f = setup();
  try {
    const before = JSON.stringify(f.manager.status());
    expect(await f.run()).toBe(0);
    expect(JSON.stringify(f.manager.status())).toBe(before);
    f.body = { ...f.body, mode: "apply" };
    expect(await f.run()).toBe(0);
    expect(await f.run()).toBe(1);
    f.body = {
      operation: "plan",
      mode: "apply",
      expectedRevision: f.manager.status()!.revision,
      passageId: "one",
      steps: Array.from({ length: 10 }, (_, i) => ({
        wake: i + 1,
        objective: `new ${i}`,
        expected: "proof",
      })),
    };
    expect(await f.run()).toBe(0);
    expect(f.manager.status()!.passages!["one"]!.steps![0]!.objective).toBe("new 0");
    f.body = { ...f.body, expectedRevision: undefined };
    expect(await f.run()).toBe(1);
    f.body = { ...f.body, expectedRevision: f.manager.status()!.revision, mode: undefined };
    expect(await f.run()).toBe(1);
    expect(f.manager.status()!.used).toBe(0);
  } finally {
    f.manager.close();
  }
});
it.each(["paused", "stopped", "disabled", "checkpointing"] as ProfileState[])(
  "allows read-only validation but refuses mutation while %s",
  async (state) => {
    const f = setup(state);
    try {
      const before = JSON.stringify(f.manager.status());
      expect(await f.run()).toBe(0);
      f.body = { ...f.body, mode: "apply" };
      expect(await f.run()).toBe(1);
      expect(JSON.stringify(f.manager.status())).toBe(before);
      expect(f.uow.profiles.get(DEFAULT_PROFILE_ID)?.state).toBe(state);
    } finally {
      f.manager.close();
    }
  },
);
it("refuses emergency lock and Force-off file without touching planning", async () => {
  const f = setup("ready", true);
  try {
    f.body = { ...f.body, mode: "apply" };
    expect(await f.run()).toBe(1);
    expect(f.manager.status()!.revision).toBe(1);
  } finally {
    f.manager.close();
  }
  const g = setup();
  try {
    fs.writeFileSync(path.join(g.dir, "emergency-stop.flag"), "human");
    g.body = { ...g.body, mode: "apply" };
    expect(await g.run()).toBe(1);
    expect(g.manager.status()!.revision).toBe(1);
  } finally {
    g.manager.close();
  }
});
