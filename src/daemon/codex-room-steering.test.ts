import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as roles from "./codex-role-turn.js";
import { roomInboxHookLaunch, saveForkAssignment } from "./fork-assignment.js";
import { forkDir, sendNoticeToFork, sendToFork } from "./forks.js";
import { roomAgentInjected, roomInjected } from "./room-agents.js";
import { runClaudeTurn, SecondThreadStore } from "./second-thread.js";
import { setEngineChoice } from "./agent-engine.js";
import type { CodexProcess } from "../adapters/codex/launch.js";
import { createHolderLiveInbox, prepareHolderLiveInbox } from "../communication/holder-live-inbox.js";
import { enqueueOwnerMessage, takeOwnerMessages } from "../communication/owner-inbox.js";

let dir: string, workspace: string, prompt: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-room-steering-"));
  workspace = path.join(dir, "workspace");
  fs.mkdirSync(workspace);
  prompt = path.join(workspace, "ROOM.md");
  fs.writeFileSync(prompt, "Room test");
  saveForkAssignment(forkDir(dir, 3), { instructions: prompt, workspace, engine: "claude", agents: [
    { id: "alice", name: "Alice", instructions: prompt },
    { id: "bob", name: "Bob", instructions: prompt },
  ] });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

function fakeServer(afterStart: () => void, acknowledgement = "turn-1", beforeAck = () => {}) {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const lines: string[] = [];
  let waiter: ((line: string | null) => void) | undefined;
  let closed = false;
  let exit!: () => void;
  const exited = new Promise<void>(resolve => { exit = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const push = (value: unknown) => {
    const line = JSON.stringify(value);
    if (waiter) { const resolve = waiter; waiter = undefined; resolve(line); }
    else lines.push(line);
  };
  const complete = () => push({ method: "turn/completed", params: { threadId: "room-thread", turn: { id: "turn-1", status: "completed" } } });
  const child: CodexProcess = {
    started: async () => 123, exited,
    get hasExited() { return closed; },
    readLine: async () => lines.shift() ?? (closed ? null : await new Promise(resolve => { waiter = resolve; })),
    send: line => {
      const request = JSON.parse(line); requests.push(request);
      if (request.id === undefined) return;
      if (request.method === "turn/steer") beforeAck();
      if (request.method === "turn/steer" && acknowledgement === "completed-before-ack") complete();
      if (request.method === "turn/steer" && acknowledgement === "rpc-error") {
        push({ id: request.id, error: { code: -32601, message: "steering unavailable" } });
        return;
      }
      push({ id: request.id, result: request.method.startsWith("thread/") ? { thread: { id: "room-thread" } }
        : request.method === "turn/start" ? { turn: { id: "turn-1" } }
        : request.method === "turn/steer" ? { turnId: acknowledgement === "completed-before-ack" ? "turn-1" : acknowledgement } : {} });
      if (request.method === "turn/start") {
        afterStart();
        timer = setTimeout(complete, 850);
      }
    },
    terminateTree: async () => {
      clearTimeout(timer); closed = true; waiter?.(null); waiter = undefined; exit();
      return { confirmed: true, elapsedMs: 0 };
    },
  };
  return { child, requests };
}

function options(agentId?: string) {
  return { dataDir: dir, cwd: workspace, instructions: "Room role", message: "Initial message",
    key: "stable-session", allowed: () => true, timeoutMs: 5000,
    roomInbox: { dataDir: dir, forkId: 3, sessionId: "stable-session", floor: 0, ...(agentId ? { agentId } : {}) } };
}

it.each(["turn-1", "wrong-turn", "rpc-error", "completed-before-ack"])("steers each holder's human inbox with acknowledgement %s", async acknowledgement => {
  const liveInbox = createHolderLiveInbox(dir, path.join(dir, "alpha"), []);
  const other = createHolderLiveInbox(dir, path.join(dir, "beta"), []);
  const fake = fakeServer(() => {
    enqueueOwnerMessage(dir, { id: "human-live", at: "2026-11-20T10:00:00Z", text: "Correction pendant le passage" });
  }, acknowledgement);
  await roles.codexRoleTurn({ dataDir: dir, cwd: workspace, instructions: "Holder editor", message: "Commence",
    allowed: () => true, timeoutMs: 5000, liveInbox, workspaceWrite: true }, () => fake.child);
  const steers = fake.requests.filter(request => request.method === "turn/steer");
  expect(steers).toHaveLength(1);
  expect(JSON.stringify(steers[0])).toContain("Correction pendant le passage");
  expect(prepareHolderLiveInbox(liveInbox) === null).toBe(acknowledgement === "turn-1");
  expect(prepareHolderLiveInbox(other)?.context).toContain("Correction pendant le passage");
  expect(takeOwnerMessages(dir, "principal").some(message => message.id === "human-live")).toBe(true);
});

it("steers a human message and targeted call into the active agent exactly once, preserving other recipients", async () => {
  let human = 0, call = 0;
  const fake = fakeServer(() => {
    human = sendToFork(dir, 3, "Human mid-turn").entryId;
    call = sendNoticeToFork(dir, 3, "Call transcript mid-turn", "telegram-route:call-test", "NLR (Telegram) → Alice", true).entryId;
    sendNoticeToFork(dir, 3, "Only Bob", "telegram-route:call-bob", "NLR (Telegram) → Bob", true);
  }, "turn-1", () => {
    const store = new SecondThreadStore(forkDir(dir, 3));
    try { expect(roomAgentInjected(store, "alice").size).toBe(0); } finally { store.close(); }
  });
  const result = await roles.codexRoleTurn(options("alice"), () => fake.child);
  expect(result.outcome).toBe("completed");
  const steers = fake.requests.filter(r => r.method === "turn/steer");
  expect(steers).toHaveLength(1);
  expect(steers[0]?.params).toMatchObject({ threadId: "room-thread", expectedTurnId: "turn-1" });
  const text = JSON.stringify(steers[0]);
  expect(text).toContain("Human mid-turn"); expect(text).toContain("Call transcript mid-turn");
  expect(text).not.toContain("Only Bob");
  const store = new SecondThreadStore(forkDir(dir, 3));
  try {
    expect([...roomAgentInjected(store, "alice")]).toEqual([human, call]);
    expect(store.pendingHuman().map(e => e.text)).toEqual(["Human mid-turn", "Only Bob"]);
    expect(roomAgentInjected(store, "bob").size).toBe(0);
  } finally { store.close(); }
  const resumed = fakeServer(() => {});
  await roles.codexRoleTurn(options("alice"), () => resumed.child);
  expect(resumed.requests.some(r => r.method === "thread/resume" && r.params["threadId"] === "room-thread")).toBe(true);
  expect(resumed.requests.some(r => r.method === "turn/steer")).toBe(false);
});

it.each(["wrong-turn", "pause", "completed-before-ack", "rpc-error"])("retains queued messages after %s", async mode => {
  let allowed = true;
  const fake = fakeServer(() => { sendToFork(dir, 3, "Keep me queued"); }, mode === "wrong-turn" ? "another-turn" : mode === "pause" ? "turn-1" : mode, () => {
    if (mode === "pause") allowed = false;
  });
  await roles.codexRoleTurn({ ...options(), allowed: () => allowed }, () => fake.child);
  const store = new SecondThreadStore(forkDir(dir, 3));
  try { expect(store.pendingHuman()).toHaveLength(1); expect(roomInjected(store).size).toBe(0); }
  finally { store.close(); }
});

it("confirms live messages for a single-session room only after acknowledgement", async () => {
  const fake = fakeServer(() => { sendToFork(dir, 3, "Call in single-agent room", "telegram-route:call-single", "telegram"); });
  await roles.codexRoleTurn(options(), () => fake.child);
  const store = new SecondThreadStore(forkDir(dir, 3));
  try { expect(store.pendingHuman()).toHaveLength(0); expect(roomInjected(store).size).toBe(1); }
  finally { store.close(); }
});

it("passes the room and agent inbox through the global Codex provider switch", async () => {
  setEngineChoice(dir, "codex");
  const call = vi.spyOn(roles, "codexRoleTurn").mockResolvedValue({ outcome: "completed", text: "ok", tokens: null,
    sessionConfirmed: true, retryAtMs: null, detail: null });
  await runClaudeTurn({ dataDir: dir, workspace, promptFile: prompt, session: { id: "session", mode: "new" },
    message: "First", control: () => "run", claude: { executable: "unused", model: "unused" },
    roomInboxHook: roomInboxHookLaunch(dir, 3, "session", 42, "alice") });
  expect(call).toHaveBeenCalledWith(expect.objectContaining({ roomInbox: {
    dataDir: dir, forkId: 3, sessionId: "session", floor: 42, agentId: "alice",
  } }));
});
