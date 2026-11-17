import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FORK_IDS,
  ONE_SHOT_CAP,
  ONE_SHOT_NOTE,
  claimOneShot,
  clusterStatusPublisher,
  oneShotTriggers,
  oneShotTurns,
  forkDir,
  forkEnabled,
  forkProjects,
  forksRunning,
  readForks,
  runForks,
  discardPendingBeforeAssignment,
  sendNoticeToFork,
  sendToFork,
  setForkEnabled,
} from "./forks.js";
import { saveForkAssignment } from "./fork-assignment.js";
import { SecondThreadStore } from "./second-thread.js";
import { runForkTurn, type ForkTurnResult } from "./fork-runtime.js";
import type { CodexProcess } from "../adapters/codex/launch.js";
import { FileThreadStore } from "../adapters/codex/continuity.js";
import type { UtcTimestamp } from "../contracts/index.js";
import { ProcessTreeSupervisor } from "../runner/process-tree.js";
import type { ProfileId, SessionId } from "../contracts/index.js";
import { WakeManager } from "./wake-manager.js";
import { clusterStatus } from "../communication/cluster-status.js";
import { readOwnerInboxHistory } from "../communication/owner-inbox.js";
import { readReceivedMessages } from "../communication/received-messages.js";

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
it("delivers a queued screen atlas only to its selected fork and releases its bytes after acceptance", async () => {
  setForkEnabled(dir, 2, true);
  setForkEnabled(dir, 3, true);
  const screen = ["AA=="];
  const receipt = sendToFork(dir, 2, "Regarde le menu", undefined, "", undefined, screen);
  sendToFork(dir, 3, "Autre message");
  const observed = new Map<number, unknown>();
  await runForks({
    dataDir: dir, workspace, profile: () => "run", maxTurns: 1,
    turn: async input => {
      const fake = fakeProcess();
      const result = await runForkTurn(input, () => fake.child);
      const turn = fake.requests.find(request => request.method === "turn/start");
      observed.set(input.id, turn?.params["input"]);
      return result;
    },
  });
  expect(observed.get(2)).toEqual([expect.objectContaining({ type: "text" }), { type: "image", url: "data:image/png;base64,AA==" }]);
  expect(observed.get(3)).toEqual([expect.objectContaining({ type: "text" })]);
  const store = new SecondThreadStore(forkDir(dir, 2));
  try { expect(store.pendingScreen(receipt.entryId)).toEqual([]); }
  finally { store.close(); }
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
      const project = /Project: ([a-z])/.exec(input.message)?.[1];
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

it("broadcasts changed public statuses to enabled peers with explicit FYI provenance", () => {
  setForkEnabled(dir, 4, true);
  setForkEnabled(dir, 8, true);
  const item = { type: "agentMessage", phase: "commentary", text: "[status]  Carte analysée. [/status]" };
  expect(clusterStatus({ ...item, type: "mcpToolCall" })).toBeUndefined();
  expect(clusterStatus({ ...item, text: "Citation : " + item.text })).toBeUndefined();
  const status = clusterStatus(item);
  expect(status).toBe("Carte analysée.");
  const publish = clusterStatusPublisher(dir, 8, "Room 8");
  publish(status!);
  publish(status!);
  publish("Comparaison terminée.");
  clusterStatusPublisher(dir, 8, "Room 8")("Comparaison terminée.");
  const store = new SecondThreadStore(forkDir(dir, 4));
  try {
    expect(store.pendingHuman().map(entry => entry.text)).toEqual([
      "FYI — Room 8 : Carte analysée.",
      "FYI — Room 8 : Comparaison terminée.",
    ]);
    expect(store.pendingSteering(0)?.senderFork).toBe("8");
    expect(store.entries().map(entry => entry.clusterStatus)).toEqual([true, true]);
  } finally { store.close(); }
  expect(readOwnerInboxHistory(dir)).toHaveLength(2);
  expect(readOwnerInboxHistory(dir)[0]?.origin).toMatchObject({ kind: "peer_message", author: "Room 8" });
  expect(readReceivedMessages(dir).map(message => message.source.kind)).toEqual(["cluster-status", "cluster-status"]);
  expect(fs.existsSync(forkDir(dir, 2))).toBe(false);
  clusterStatusPublisher(dir, 1, "Fil principal")("Données de partie reçues.");
  const recipient = new SecondThreadStore(forkDir(dir, 8));
  try {
    expect(recipient.pendingHuman()).toMatchObject([
      { text: "FYI — Fil principal : Données de partie reçues.", senderFork: 1, clusterStatus: true },
    ]);
  } finally { recipient.close(); }
  expect(readOwnerInboxHistory(dir)).toHaveLength(2);
});

function fakeProcess(hang = false, status = "completed", errorInfo?: string, turns?: unknown[], steerAck?: string) {
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
        result: request.method === "thread/read" ? { thread: { id: "principal", turns } }
          : request.method.startsWith("thread/") ? { thread: { id: "own-thread" } }
          : request.method === "turn/start" ? { turn: { id: "active-turn" } }
          : request.method === "turn/steer" ? { turnId: steerAck } : {},
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
      if (request.method === "turn/steer" && (steerAck !== "active-turn"
        || requests.filter(r => r.method === "turn/steer").length === 2)) push({
        method: "turn/completed",
        params: { threadId: "own-thread", turn: { id: "active-turn", status: "completed" } },
      });
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
it.each(["active-turn", "different-turn"])("steers new interfil messages and checks acknowledgement %s", async ack => {
  setForkEnabled(dir, 8, true);
  sendToFork(dir, 8, "Déjà en attente", "earlier-message", "", 4);
  const fake = fakeProcess(true, "completed", undefined, undefined, ack);
  await runForks({
    dataDir: dir, workspace, profile: () => "run", maxTurns: 1,
    turn: input => {
      sendToFork(dir, 8, "La case B est sur l’eau douce.", "new-message", "", 4);
      sendToFork(dir, 8, "Capture automatique", "app-message", '{"humanInstruction":false}');
      sendToFork(dir, 8, "Nouveau message humain", undefined, "", undefined, ["AA=="]);
      return runForkTurn(input, () => fake.child);
    },
  });
  const steers = fake.requests.filter(request => request.method === "turn/steer");
  expect(steers).toHaveLength(ack === "active-turn" ? 2 : 1);
  expect(steers[0]?.params).toMatchObject({
    threadId: "own-thread", expectedTurnId: "active-turn",
    input: [{ type: "text", text: expect.stringMatching(/^Message de Room 4.*La case B/) }],
  });
  if (ack === "active-turn") expect(steers[1]?.params["input"]).toEqual([
    { type: "text", text: expect.stringMatching(/^Message humain.*Nouveau message humain/) },
    { type: "image", url: "data:image/png;base64,AA==" },
  ]);
  const store = new SecondThreadStore(forkDir(dir, 8));
  try {
    expect(store.pendingHuman().map(entry => entry.text)).toEqual(ack === "active-turn"
      ? ["Capture automatique"]
      : ["La case B est sur l’eau douce.", "Capture automatique", "Nouveau message humain"]);
  } finally { store.close(); }
});
it("coaching reads the last completed turn's public messages and starts separately", async () => {
  const fake = fakeProcess(false, "completed", undefined, [
    { id: "finished", status: "completed", items: [{ type: "agentMessage", text: "Une idée à ouvrir" }, { type: "reasoning", text: "private reasoning" }] },
    { id: "current", status: "inProgress", items: [{ type: "agentMessage", text: "work in progress" }] },
  ]);
  const result = await runForkTurn({ dataDir: dir, workspace, id: 0, threadId: null, inheritPrincipal: false,
    sourceThreadId: "principal", onSourceTurn: id => { expect(id).toBe("finished"); return true; },
    control: () => "run", onThread: () => {}, instructions: "Coach", message: "Reprenons" }, () => fake.child);
  expect(result.outcome).toBe("completed");
  expect(fake.requests.some(r => r.method === "thread/start")).toBe(true);
  const request = JSON.stringify(fake.requests.find(r => r.method === "turn/start"));
  expect(request).toContain("Une idée à ouvrir"); expect(request).not.toContain("private reasoning"); expect(request).not.toContain("work in progress");
  expect(fake.kills()).toBeGreaterThan(0);
});
it("releases the runtime without a model turn when coaching has no new completed source", async () => {
  const fake = fakeProcess(false, "completed", undefined, []);
  const result = await runForkTurn({ dataDir: dir, workspace, id: 0, threadId: null, sourceThreadId: "principal",
    control: () => "run", onThread: () => {}, instructions: "Coach", message: "Reprenons" }, () => fake.child);
  expect(result.accepted).toBe(false); expect(fake.requests.some(r => r.method === "turn/start")).toBe(false);
  expect(fake.kills()).toBeGreaterThan(0);
});
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

it("delivers a labelled notice (Vigie) to an assigned room under its label, never as NLR", async () => {
  const instructions = path.join(workspace, "room4.md");
  fs.writeFileSync(instructions, "Consigne de la room.");
  saveForkAssignment(forkDir(dir, 4), { instructions, engine: "claude", workspace });
  setForkEnabled(dir, 4, true);
  const label = "Vigie · voix-juge de la room";
  expect(sendNoticeToFork(dir, 4, "Coup joué : vérifie la règle 3.", "vigie-test-0001", label).status).toBe("recorded");
  expect(sendNoticeToFork(dir, 4, "Coup joué : vérifie la règle 3.", "vigie-test-0001", label).status).toBe("duplicate");
  // L'étiquette est stockée avec l'entrée ; la notice réveille la room (pendingHuman).
  const before = new SecondThreadStore(forkDir(dir, 4));
  expect(before.get("entry-notice:1")).toBe(JSON.stringify({ label, hidden: false }));
  expect(before.pendingHuman().map((e) => e.notice?.label)).toEqual([label]);
  before.close();
  // La vue desktop lit l'auteur dans le store (entrée visible, étiquetée).
  const view = readForks(dir, workspace).forks.find((f) => f.id === 4);
  expect(view?.entries.map((e) => [e.role, e.notice])).toEqual([["human", { label, hidden: false }]]);
  const messages: string[] = [];
  await runForks({
    dataDir: dir, workspace, profile: () => "run", claudeProfile: () => "run", maxTurns: 1,
    claudeTurn: async (input) => {
      messages.push(input.message);
      return { outcome: "completed", text: "", tokens: null, accepted: true, detail: null, retryAtMs: null, sessionId: "s" };
    },
  });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatch(/^Vigie · voix-juge de la room \[[^\]]+\] : Coup joué : vérifie la règle 3\.$/);
  expect(messages[0]).not.toContain("NLR");
});
it("sets aside, without deleting, pending messages older than a new assignment", () => {
  sendToFork(dir, 4, "Ancienne diffusion");
  const store = new SecondThreadStore(forkDir(dir, 4));
  store.addNoticeOnce("old-notice-01", "Ancienne notice", "Principal");
  store.close();
  const instructions = path.join(workspace, "room4.md");
  fs.writeFileSync(instructions, "Consigne.");
  const assignment = saveForkAssignment(forkDir(dir, 4), { instructions, engine: "claude", workspace });
  expect(discardPendingBeforeAssignment(dir, 4, assignment.assignedAt)).toEqual([1, 2]);
  sendToFork(dir, 4, "Après affectation");
  const after = new SecondThreadStore(forkDir(dir, 4));
  expect(after.pendingHuman().map((e) => e.text)).toEqual(["Après affectation"]);
  const kept = after.entries();
  expect(kept.filter((e) => e.role === "human").map((e) => [e.text, e.delivered])).toEqual([
    ["Ancienne diffusion", true], ["Ancienne notice", true], ["Après affectation", false],
  ]);
  expect(JSON.parse(after.get("entry-discarded:1") ?? "{}")).toMatchObject({ before: assignment.assignedAt });
  expect(kept.find((e) => e.role === "event")?.text).toContain("entrées 1, 2");
  after.close();
  expect(discardPendingBeforeAssignment(dir, 5, assignment.assignedAt)).toEqual([]);
});
describe("disabled room: one turn per human message", () => {
  const assign = (room: number) => {
    const instructions = path.join(workspace, `room${String(room)}.md`);
    fs.writeFileSync(instructions, "Consigne.");
    saveForkAssignment(forkDir(dir, room), { instructions, engine: "claude", workspace });
  };
  const since = (room: number, at = "1970-01-01T00:00:00.000Z") => {
    const s = new SecondThreadStore(forkDir(dir, room));
    s.set("oneshot-since", at);
    s.close();
  };
  // Room 4, active, garde le worker vivant le temps d'un tour (maxTurns) ; Room 7 reste désactivée.
  let telegram: { text: string; key: string }[] = [];
  let telegramFails = false;
  const run = async (reply = (id: number) => `réponse ${String(id)}`) => {
    sendToFork(dir, 4, `tour de la room 4 ${String(Math.random())}`);
    const calls: { id: number; message: string; control: string }[] = [];
    await runForks({
      dataDir: dir, workspace, profile: () => "run", claudeProfile: () => "run", maxTurns: 1, telegramInbound: false,
      telegramReply: async (text, key) => {
        telegram.push({ text, key });
        if (telegramFails) throw Error("réseau indisponible");
      },
      claudeTurn: async (input) => {
        calls.push({ id: input.id, message: input.message, control: input.control() });
        return { outcome: "completed", text: reply(input.id), tokens: null, accepted: true, detail: null, retryAtMs: null, sessionId: "s" };
      },
    });
    return calls.filter((c) => c.id === 7);
  };
  beforeEach(() => {
    telegram = [];
    telegramFails = false;
    assign(4);
    assign(7);
    setForkEnabled(dir, 4, true);
    setForkEnabled(dir, 7, false);
    since(7);
  });

  it("runs exactly one turn for a Telegram-routed message, then never again, without enabling the room", async () => {
    sendToFork(dir, 7, "@vox hello !", "telegram-route:msg-000001", "telegram", undefined, [], true);
    const first = await run();
    expect(first).toHaveLength(1);
    expect(first[0]?.control).toBe("run");
    expect(first[0]?.message).toContain(ONE_SHOT_NOTE);
    expect(first[0]?.message).toContain("@vox hello !");
    expect(forkEnabled(dir, 7)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(forkDir(dir, 7), "enabled.json"), "utf8"))).toEqual({ enabled: false });
    const store = new SecondThreadStore(forkDir(dir, 7));
    expect(store.pendingHuman()).toEqual([]);
    expect(store.entries().filter((e) => e.role === "agent").map((e) => e.text)).toEqual(["réponse 7"]);
    expect(oneShotTurns(store)).toHaveLength(1);
    store.close();
    // Retry of the same Telegram message: duplicate, no second turn.
    expect(sendToFork(dir, 7, "@vox hello !", "telegram-route:msg-000001", "telegram", undefined, [], true).status).toBe("duplicate");
    expect(await run()).toHaveLength(0);
    // La réponse de VOX, et elle seule, est partie une fois vers le téléphone de NLR.
    expect(telegram).toEqual([{ text: "VOX : réponse 7", key: expect.stringMatching(/^room7-reply-\d+$/) as unknown as string }]);
  });

  it("sends nothing to Telegram for a desktop message, and splits long Telegram replies at 4000 chars", async () => {
    sendToFork(dir, 7, "message direct du desktop");
    expect(await run()).toHaveLength(1);
    expect(telegram).toEqual([]);
    sendToFork(dir, 7, "@vox raconte", "telegram-route:msg-000002", "telegram", undefined, [], true);
    expect(await run(() => "x".repeat(5000))).toHaveLength(1);
    expect(telegram.map((t) => t.text.length)).toEqual([4000, 5006 - 4000]);
    expect(telegram[0]?.text.startsWith("VOX : xxx")).toBe(true);
    expect(telegram.map((t) => /^room7-reply-\d+-(\d)$/.exec(t.key)?.[1])).toEqual(["0", "1"]);
  });

  it("logs a failed Telegram send once and never retries it", async () => {
    telegramFails = true;
    sendToFork(dir, 7, "@vox hello", "telegram-route:msg-000003", "telegram", undefined, [], true);
    expect(await run()).toHaveLength(1);
    expect(telegram).toHaveLength(1);
    const store = new SecondThreadStore(forkDir(dir, 7));
    const reply = store.entries().find((e) => e.role === "agent")!;
    expect(store.get(`telegram-reply:${String(reply.id)}`)).toMatch(/^failed: réseau indisponible/);
    store.close();
    expect(await run()).toHaveLength(0);
    expect(telegram).toHaveLength(1);
  });

  it("does not re-run a claimed message that stayed pending (turn not accepted)", async () => {
    sendToFork(dir, 7, "message direct du desktop");
    const store = new SecondThreadStore(forkDir(dir, 7));
    expect(oneShotTriggers(store).map((e) => e.text)).toEqual(["message direct du desktop"]);
    claimOneShot(store, oneShotTriggers(store));
    expect(oneShotTriggers(store)).toEqual([]);
    expect(store.pendingHuman()).toHaveLength(1);
    store.close();
    expect(await run()).toHaveLength(0);
  });

  it("never wakes the room for agent messages (principal, other room, simulation, relay)", async () => {
    sendNoticeToFork(dir, 7, "VOX, ton outil est prêt.", "post:principal:abcdefgh", "Principal");
    sendNoticeToFork(dir, 7, "Simulation NLR : continue.", "post:nlr:abcdefgh", "Simulation NLR");
    sendToFork(dir, 7, "FYI — Room 2 : statut", "status:abcdefgh", JSON.stringify({ kind: "interfil" }), 2);
    sendToFork(dir, 7, "relais applicatif", "relay:abcdefgh", "vox-relay");
    const store = new SecondThreadStore(forkDir(dir, 7));
    expect(store.pendingHuman()).toHaveLength(4);
    expect(oneShotTriggers(store)).toEqual([]);
    store.close();
    expect(await run()).toHaveLength(0);
  });

  it("ignores the backlog received before the worker's first start", async () => {
    since(7, new Date(Date.now() + 60_000).toISOString());
    sendToFork(dir, 7, "ancien message");
    expect(await run()).toHaveLength(0);
  });

  it("caps one-shot turns at 30 per room over a rolling 24 h and logs once", () => {
    sendToFork(dir, 7, "message au-delà du plafond");
    const store = new SecondThreadStore(forkDir(dir, 7));
    const now = Date.now();
    store.set("oneshot-turns", JSON.stringify([now - 25 * 3_600_000, ...Array.from({ length: ONE_SHOT_CAP }, (_, i) => now - i * 60_000)]));
    expect(oneShotTurns(store, now)).toHaveLength(ONE_SHOT_CAP);
    const logs: string[] = [];
    expect(claimOneShot(store, oneShotTriggers(store), now, (l) => logs.push(l), 7)).toBeNull();
    expect(claimOneShot(store, oneShotTriggers(store), now, (l) => logs.push(l), 7)).toBeNull();
    expect(logs).toHaveLength(1);
    expect(store.pendingHuman()).toHaveLength(1);
    // Once the oldest leaves the 24 h window, the message gets its turn.
    expect(claimOneShot(store, oneShotTriggers(store), now + 24 * 3_600_000 - 29 * 60_000 + 1)?.map((e) => e.text)).toEqual(["message au-delà du plafond"]);
    store.close();
  });
});
