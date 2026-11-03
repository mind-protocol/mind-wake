import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  FORK_IDS,
  forkDir,
  forkEnabled,
  forkProjects,
  forksRunning,
  readForks,
  runForks,
  sendToFork,
  setForkEnabled,
} from "./forks.js";
import { SecondThreadStore } from "./second-thread.js";
import { runForkTurn, type ForkTurnResult } from "./fork-runtime.js";
import type { CodexProcess } from "../adapters/codex/launch.js";
import { FileThreadStore } from "../adapters/codex/continuity.js";
import type { UtcTimestamp } from "../contracts/index.js";
import { ProcessTreeSupervisor } from "../runner/process-tree.js";
import type { ProfileId, SessionId } from "../contracts/index.js";
import { WakeManager } from "./wake-manager.js";

let dir: string, workspace: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-forks-"));
  workspace = path.join(dir, "workspace");
  fs.mkdirSync(path.join(workspace, "artifacts"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "artifacts/projets-compteur.json"),
    JSON.stringify({
      current: "a",
      projects: Object.fromEntries(
        "abcdefghijklmnop".split("").map((id) => [id, { status: "en cours", title: id }]),
      ),
    }),
  );
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
it("partitions the rotation without duplicates for every combination of switches", () => {
  const order = "abcdefghijklmnop".split("");
  for (let mask = 1; mask < 128; mask++) {
    const slots = FORK_IDS.filter((_, i) => (mask & (1 << i)) !== 0);
    const assigned = slots.flatMap((id) => forkProjects([...order, "b"], slots, id, "a"));
    expect(assigned.length).toBe(new Set(assigned).size);
    expect([...assigned].sort()).toEqual(order.slice(1));
  }
});
it("preserves each fork's inbox independently across off/on", () => {
  expect(forkEnabled(dir, 2)).toBe(false);
  sendToFork(dir, 2, "Pour le deuxième");
  sendToFork(dir, 3, "Pour le troisième");
  setForkEnabled(dir, 2, true);
  setForkEnabled(dir, 2, false);
  const view = readForks(dir, workspace);
  expect(view.forks[0]?.entries.map((e) => e.text)).toEqual(["Pour le deuxième"]);
  expect(view.forks[1]?.entries.map((e) => e.text)).toEqual(["Pour le troisième"]);
  expect(() => {
    setForkEnabled(dir, 9, true);
  }).toThrow();
});
it("excludes the principal's newly reserved project at a block transition", () => {
  setForkEnabled(dir, 2, true);
  const manager = new WakeManager(workspace);
  try {
    manager.configure(true);
    for (let n = 0; n < 10; n++) {
      const session = `principal-${String(n)}`;
      manager.reserve(session);
      manager.started(session);
      manager.finish(session, "completed");
    }
    const reserved = manager.reserve("principal-next");
    expect(reserved?.projectId).not.toBe("a");
    expect(readForks(dir, workspace).forks[0]?.projects).not.toContain(reserved?.projectId);
  } finally {
    manager.close();
  }
});
const success: ForkTurnResult = {
  outcome: "completed",
  text: "Résultat",
  tokens: 23,
  accepted: true,
  detail: null,
  retryAtMs: null,
};
it("runs seven distinct agents concurrently, resumes threads and delivers inboxes once", async () => {
  FORK_IDS.forEach((id) => {
    setForkEnabled(dir, id, true);
  });
  sendToFork(dir, 2, "Bonjour");
  const projects = new Set<string>();
  const first = new Set<number>();
  let all!: () => void;
  const barrier = new Promise<void>((resolve) => {
    all = resolve;
  });
  await runForks({
    dataDir: dir,
    workspace,
    profile: () => "run",
    maxTurns: 2,
    turn: async (input) => {
      expect(forksRunning(dir)).toBe(true);
      const project = /Projet : ([a-z])/.exec(input.message)?.[1];
      if (project === undefined) throw Error("Projet absent");
      if (!first.has(input.id)) {
        expect(input.threadId).toBe(null);
        expect(projects.has(project)).toBe(false);
        projects.add(project);
        first.add(input.id);
        input.onThread(`thread-${String(input.id)}`);
        if (first.size === 7) all();
        await barrier;
      } else {
        expect(input.threadId).toBe(`thread-${String(input.id)}`);
        expect(input.message).not.toContain("Bonjour");
      }
      return success;
    },
  });
  expect(first.size).toBe(7);
  expect(forksRunning(dir)).toBe(false);
  const view = readForks(dir, workspace);
  expect(view.forks.every((f) => f.lastTurn?.outcome === "completed")).toBe(true);
  expect(view.forks[0]?.entries[0]?.delivered).toBe(true);
});
it("marks unfinished turns interrupted after a worker restart", async () => {
  setForkEnabled(dir, 2, true);
  const store = new SecondThreadStore(forkDir(dir, 2));
  store.beginTurn("b");
  store.close();
  await runForks({
    dataDir: dir,
    workspace,
    profile: () => "run",
    maxTurns: 1,
    turn: () => Promise.resolve(success),
  });
  expect(readForks(dir, workspace).forks[0]?.lastTurn).toMatchObject({ outcome: "completed" });
});

function fakeProcess(hang = false, status = "completed", errorInfo?: string) {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let closed = false,
    waiter: ((line: string | null) => void) | null = null;
  const lines: string[] = [];
  const push = (value: unknown) => {
    const line = JSON.stringify(value);
    if (waiter) {
      const take = waiter;
      waiter = null;
      take(line);
    } else lines.push(line);
  };
  let ended!: () => void;
  const exited = new Promise<void>((resolve) => {
    ended = resolve;
  });
  let kills = 0;
  const child: CodexProcess = {
    started: () => Promise.resolve(123),
    exited,
    get hasExited() {
      return closed;
    },
    readLine: async () =>
      lines.shift() ??
      (closed
        ? null
        : await new Promise<string | null>((resolve) => {
            waiter = resolve;
          })),
    send: (line) => {
      const request = JSON.parse(line) as {
        id?: number;
        method: string;
        params: Record<string, unknown>;
      };
      requests.push(request);
      if (request.id === undefined) return;
      push({
        id: request.id,
        result: request.method.startsWith("thread/") ? { thread: { id: "own-thread" } } : {},
      });
      if (request.method === "turn/start" && !hang) {
        push({
          method: "turn/completed",
          params: { threadId: "another-agent", turn: { status: "failed" } },
        });
        push({
          method: "item/completed",
          params: { threadId: "own-thread", item: { type: "agentMessage", text: "Mon résultat" } },
        });
        push({
          method: "turn/completed",
          params: {
            threadId: "own-thread",
            turn: {
              status,
              ...(errorInfo ? { error: { message: "Limite", codexErrorInfo: errorInfo } } : {}),
            },
          },
        });
      }
    },
    terminateTree: () => {
      kills++;
      closed = true;
      waiter?.(null);
      waiter = null;
      ended();
      return Promise.resolve({ confirmed: true, elapsedMs: 0 });
    },
  };
  return { child, requests, kills: () => kills };
}
it("forks from the principal once, then resumes its own Codex thread", async () => {
  new FileThreadStore(path.join(dir, "codex-threads")).save("default", {
    threadId: "principal",
    promptFingerprint: "a".repeat(64),
    updatedAt: new Date().toISOString() as UtcTimestamp,
  });
  for (const threadId of [null, "own-thread"]) {
    const fake = fakeProcess();
    let saved = "";
    const result = await runForkTurn(
      {
        dataDir: dir,
        workspace,
        id: 2,
        threadId,
        control: () => "run",
        onThread: (id) => {
          saved = id;
        },
        instructions: "Instructions",
        message: "Reprenons",
      },
      () => fake.child,
    );
    expect(result).toMatchObject({ outcome: "completed", text: "Mon résultat", accepted: true });
    expect(saved).toBe("own-thread");
    const open = fake.requests.find(
      (r) => r.method === (threadId ? "thread/resume" : "thread/fork"),
    );
    expect(open?.params["threadId"]).toBe(threadId ?? "principal");
    expect(fake.kills()).toBeGreaterThan(0);
  }
});
it("terminates the process tree when Pause, Off or Force-off arrives mid-turn", async () => {
  const fake = fakeProcess(true);
  let state: "run" | "hold" = "run";
  const result = runForkTurn(
    {
      dataDir: dir,
      workspace,
      id: 2,
      threadId: null,
      control: () => state,
      onThread: () => {
        setTimeout(() => {
          state = "hold";
        }, 30);
      },
      instructions: "",
      message: "",
    },
    () => fake.child,
  );
  expect((await result).outcome).toBe("interrupted");
  expect(fake.kills()).toBeGreaterThan(0);
  expect(fake.requests.some((r) => r.method === "turn/start")).toBe(true);
});
it("recognizes provider refusal without claiming success", async () => {
  const fake = fakeProcess(false, "failed", "usageLimitExceeded");
  const result = await runForkTurn(
    {
      dataDir: dir,
      workspace,
      id: 2,
      threadId: null,
      control: () => "run",
      onThread: () => {},
      instructions: "",
      message: "",
    },
    () => fake.child,
  );
  expect(result.outcome).toBe("rate_limited");
});
it.skipIf(process.platform !== "win32")(
  "executes the IPC loop through a real Windows Job Object with a local fake Codex",
  async () => {
    const flow = path.join(dir, "flow.json");
    fs.writeFileSync(
      flow,
      JSON.stringify({
        on: {
          initialize: { result: {} },
          "thread/start": { result: { thread: { id: "own-thread" } } },
          "turn/start": {
            result: { turn: { id: "turn-1" } },
            then: [
              {
                notify: "item/completed",
                params: {
                  threadId: "own-thread",
                  item: { type: "agentMessage", text: "Résultat IPC" },
                },
              },
              {
                notify: "turn/completed",
                params: { threadId: "own-thread", turn: { id: "turn-1", status: "completed" } },
              },
            ],
          },
        },
      }),
    );
    const supervisor = new ProcessTreeSupervisor(path.join(dir, "runtime"));
    expect(supervisor.available).toBe(true);
    const result = await runForkTurn(
      {
        dataDir: dir,
        workspace,
        id: 2,
        threadId: null,
        control: () => "run",
        onThread: () => {},
        instructions: "",
        message: "Test local",
      },
      () =>
        supervisor.spawn("test-fork" as ProfileId, "test-ipc" as SessionId, {
          executable: process.execPath,
          args: [path.resolve("test/fixtures/codex/fake-codex.ts"), "app-server"],
          cwd: workspace,
          env: { FAKE_CODEX_FLOW: flow },
        }),
    );
    expect(result).toMatchObject({ outcome: "completed", text: "Résultat IPC", accepted: true });
    expect(supervisor.query("test-fork" as ProfileId, "test-ipc" as SessionId).active ?? 0).toBe(0);
  },
  20_000,
);

it("reads public activity for each fork independently while a turn is still running", () => {
  const codex=path.join(dir,"codex"),sessions=path.join(codex,"sessions");
  fs.mkdirSync(sessions,{recursive:true});
  for(const id of [2,3]){
    const threadId=`00000000-0000-0000-0000-00000000000${String(id)}`;
    fs.mkdirSync(forkDir(dir,id),{recursive:true});
    const store=new SecondThreadStore(forkDir(dir,id));
    store.set("threadId",threadId);store.beginTurn("b");store.close();
    fs.writeFileSync(path.join(sessions,`${String(id)}.jsonl`),JSON.stringify({type:"session_meta",payload:{id:threadId,timestamp:"2026-11-03T12:00:00Z"}})+"\n"+
      JSON.stringify({type:"response_item",timestamp:"2026-11-03T12:01:00Z",payload:{type:"message",role:"assistant",channel:"commentary",content:[{type:"output_text",text:`Activité du fork ${String(id)}`}]}}));
  }
  const view=readForks(dir,workspace,codex);
  expect(view.forks[0]?.lastTurn?.endedAt).toBeNull();
  expect(view.forks[0]?.activity.map(a=>a.text)).toEqual(["Activité du fork 2"]);
  expect(view.forks[1]?.activity.map(a=>a.text)).toEqual(["Activité du fork 3"]);
});
