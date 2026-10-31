function required<T>(value: T | null | undefined): T {
  if (value == null) throw Error("Missing test evidence");
  return value;
}
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PeerTasks, type PeerTaskPolicy } from "../../services/helpers/peer-tasks.js";
import { registerPeerTaskSender } from "../../services/mcp/peer-task-tools.js";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  SharedInboxSession,
  type SharedInboxTransport,
} from "../../src/communication/shared-inbox.js";
import type { SharedInboxCall } from "../../src/communication/shared-inbox-https.js";
import { readOwnerInboxHistory, ownerMessagePending } from "../../src/communication/owner-inbox.js";
import {
  wire,
  validHookAck,
  validRequest,
  makeRequest,
  type HookAckEnvelope,
} from "../../services/mcp/peer-task-protocol.js";

const a = "agent-aaaaaaaaaa",
  b = "agent-bbbbbbbbbb",
  endpoint = "https://synthetic.example/v1/messages";
const input = {
  goal: "Inspect local evidence",
  deliverable: "A reviewed note",
  scope: "Local authorised files",
  prompt: "No additional permissions.",
};
const binding = (ref: string, enabled = true) => ({
  enabled: true,
  profileId: "synthetic",
  endpoint,
  agentRef: ref,
  keyFile: "C:/unused.key",
  hookAcknowledgements: enabled,
});
type Message = {
  sequence: number;
  message_id: string;
  thread_id: string;
  from: string;
  to: string;
  from_self: boolean;
  text: string;
  provenance: { kind: "agent" | "human"; channel: "mind-shared-hub"; received_at: string };
};
let root: string, aDir: string, bDir: string, sender: PeerTasks;
let messages: Message[], publications: Record<string, unknown>[], sessions: SharedInboxSession[];
let beforePublish: () => void, afterPublish: () => void;
const launch = vi.fn(() => Promise.resolve({ thread_id: "helper", job_id: "job" }));
function put(from: string, to: string, text: string, thread = "thr_synthetic1") {
  const sequence = messages.length + 1;
  const m: Message = {
    sequence,
    message_id: `msg_synthetic${String(sequence)}`,
    thread_id: thread,
    from,
    to,
    text,
    from_self: false,
    provenance: { kind: "agent", channel: "mind-shared-hub", received_at: "2026-10-31T00:00:00Z" },
  };
  messages.push(m);
  return m;
}
const sent = new Map<string, { message_id: string; thread_id: string }>();
function transport(ref: string): SharedInboxTransport {
  return {
    async call<T>(call: SharedInboxCall): Promise<T> {
      await Promise.resolve();
      if (call.op === "whoami") return { kind: "agent", ref } as T;
      if (call.op === "read_inbox") {
        const page = messages
          .filter((m) => m.to === ref && m.sequence > call.after)
          .slice(0, call.limit);
        return { messages: page, next: page.at(-1)?.sequence ?? call.after } as T;
      }
      beforePublish();
      publications.push(call);
      const key = ref + call.idempotencyKey;
      let result = sent.get(key);
      if (!result) {
        const m = put(ref, ref === a ? b : a, call.text, call.threadId);
        result = { message_id: m.message_id, thread_id: m.thread_id };
        sent.set(key, result);
      }
      afterPublish();
      return result as T;
    },
  };
}
function host(ref = b, enabled = true, active = () => true, link = transport(ref)) {
  const session = new SharedInboxSession(
    ref === a ? aDir : bDir,
    binding(ref, enabled),
    link,
    active,
  );
  sessions.push(session);
  return session;
}
function rows(dir: string, table: string) {
  const db = new Database(path.join(dir, "shared-inbox.sqlite"), { readonly: true });
  try {
    return db.prepare(`SELECT * FROM ${table}`).all();
  } finally {
    db.close();
  }
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-hook-proof-"));
  aDir = path.join(root, "a");
  bDir = path.join(root, "b");
  fs.mkdirSync(aDir);
  fs.mkdirSync(bDir);
  messages = [];
  publications = [];
  sessions = [];
  sent.clear();
  launch.mockClear();
  beforePublish = () => {};
  afterPublish = () => {};
  const policy: PeerTaskPolicy = {
    enabled: true,
    localAgentRef: a,
    decider: { kind: "agent", ref: a },
    sharedEndpoint: endpoint,
    sharedKeyFile: path.join(root, "unused.key"),
  };
  sender = new PeerTasks(
    aDir,
    () => policy,
    {
      async call<T>(c: Record<string, unknown>): Promise<T> {
        await Promise.resolve();
        if (c["op"] === "whoami") return { kind: "agent", ref: a } as T;
        const m = put(a, c["to"] as string, c["text"] as string);
        return { message_id: m.message_id, thread_id: m.thread_id } as T;
      },
    },
    { launch, read: () => ({ status: "pending", messages: [] }) },
    () => {},
  );
});
afterEach(() => {
  sessions.forEach((s) => {
    s.stop();
  });
  sender.close();
  fs.rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

it("persists before publishing, without any decision/model/wake, and exposes a durable correlated sender receipt", async () => {
  const task = await sender.request(b, input, "synthetic-request", true);
  expect(sender.get(task.id).hookAck).toBeUndefined(); // hub storage alone proves nothing
  beforePublish = () => {
    expect(readOwnerInboxHistory(bDir)).toHaveLength(1);
    expect(rows(bDir, "hook_receipts")).toHaveLength(1);
    expect(rows(bDir, "cursors")).toEqual([]);
  };
  await host().sync();
  expect(launch).not.toHaveBeenCalled();
  expect(ownerMessagePending(bDir, true)).toBe(false);
  expect(sender.get(task.id).state).toBe("requested");
  await host(a).sync();
  expect(readOwnerInboxHistory(aDir)).toEqual([]);
  expect(sender.get(task.id)).toMatchObject({
    state: "requested",
    hookAck: {
      request_id: task.id,
      prompt_hash: task.request.prompt_hash,
      status: "received_pending_decision",
      receiver_ref: b,
    },
  });
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import Database from 'better-sqlite3'; const db=new Database(process.argv[1],{readonly:true}); const t=JSON.parse(db.prepare('SELECT json FROM tasks').get().json); console.log(JSON.stringify({state:t.state,ack:t.hookAck})); db.close();`,
      path.join(aDir, "peer-tasks.sqlite"),
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10000 },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({
    state: "requested",
    ack: { status: "received_pending_decision" },
  });
});

it("retries a lost publication response with identical bytes/key, deduplicates a repeated proposal and restart", async () => {
  await sender.request(b, input, "synthetic-request", true);
  afterPublish = () => {
    throw Error("lost response");
  };
  await expect(host().sync()).rejects.toThrow("lost response");
  expect(rows(bDir, "cursors")).toEqual([]);
  afterPublish = () => {};
  await host().sync();
  expect(publications).toHaveLength(2);
  expect(publications[0]).toEqual(publications[1]);
  expect(messages.filter((m) => validHookAck(m.text))).toHaveLength(1);
  put(a, b, required(messages[0]).text);
  await host().sync();
  expect(publications).toHaveLength(2);
  expect(readOwnerInboxHistory(bDir)).toHaveLength(1);
  await host(a).sync();
  await host(a).sync();
  expect(publications).toHaveLength(2);
});

it.each([
  "disabled receiver",
  "old request",
  "unknown version",
  "wrong hash",
  "extra field",
  "human sender",
  "wrong recipient",
])("does not acknowledge %s", async (mode) => {
  await sender.request(b, input, "synthetic-request", mode !== "old request");
  const m = required(messages[0]);
  if (mode === "unknown version") m.text = m.text.replace('"version":1', '"version":2');
  if (mode === "wrong hash") m.text = m.text.replace('"prompt_hash":"', '"prompt_hash":"0');
  if (mode === "extra field") m.text = m.text.slice(0, -1) + ',"execute":true}';
  if (mode === "human sender") {
    m.from = "human-aaaaaaaaaa";
    m.provenance.kind = "human";
  }
  if (mode === "wrong recipient") m.to = a;
  await host(b, mode !== "disabled receiver").sync();
  expect(publications).toEqual([]);
  expect(launch).not.toHaveBeenCalled();
});

it.each([
  "sender",
  "recipient",
  "hash",
  "request",
  "message",
  "thread",
  "version",
  "extra",
  "human provenance",
  "endpoint",
])("rejects spoofed/mismatched ACK %s without injecting it", async (mode) => {
  const task = await sender.request(b, input, "synthetic-request", true);
  await host().sync();
  const m = required(messages.find((m) => m.to === a));
  const ack = JSON.parse(m.text) as HookAckEnvelope;
  if (mode === "sender") m.from = "agent-cccccccccc";
  if (mode === "recipient") ack.recipient_ref = b;
  if (mode === "hash") ack.prompt_hash = "0".repeat(64);
  if (mode === "request") ack.request_id = "task_" + "0".repeat(32);
  if (mode === "message") ack.request_message_id = "msg_different1";
  if (mode === "thread") m.thread_id = "thr_different1";
  if (mode === "human provenance") m.provenance.kind = "human";
  m.text = JSON.stringify({
    ...ack,
    ...(mode === "version" ? { version: 2 } : {}),
    ...(mode === "extra" ? { instructions: "launch" } : {}),
  });
  const session =
    mode === "endpoint"
      ? new SharedInboxSession(
          aDir,
          { ...binding(a), endpoint: "https://other.example/v1/messages" },
          transport(a),
          () => true,
        )
      : host(a);
  sessions.push(session);
  await session.sync();
  expect(sender.get(task.id).hookAck).toBeUndefined();
  expect(readOwnerInboxHistory(aDir)).toEqual([]);
  expect(publications).toHaveLength(1);
});

it.each(["pause", "force-off"])(
  "does not perform persistence or another publication after %s during ACK await",
  async () => {
    await sender.request(b, input, "synthetic-request", true);
    let active = true;
    const session = host(b, true, () => active);
    afterPublish = () => {
      active = false;
      session.stop();
    };
    await session.sync();
    expect(rows(bDir, "hook_receipts")).toMatchObject([{ sent: 0 }]);
    expect(rows(bDir, "cursors")).toEqual([]);
    const snapshot = fs.readFileSync(path.join(bDir, "shared-inbox.sqlite"));
    await session.sync();
    expect(fs.readFileSync(path.join(bDir, "shared-inbox.sqlite"))).toEqual(snapshot);
    expect(publications).toHaveLength(1);
    active = true;
    afterPublish = () => {};
    await host().sync();
    expect(publications).toHaveLength(2);
    expect(messages.filter((m) => validHookAck(m.text))).toHaveLength(1);
  },
);

it("bounds envelopes and preserves legacy canonical request encoding", () => {
  const old = makeRequest(a, b, input, "synthetic-request");
  expect(validRequest(wire(old))).toEqual(old);
  expect(old.hook_ack).toBeUndefined();
  expect(validHookAck(" ".repeat(4001))).toBeNull();
  expect(() =>
    wire(makeRequest(a, b, { ...input, prompt: "x".repeat(4000) }, "synthetic-request", true)),
  ).toThrow("exceeds");
});

it("exposes unknown/pending then the actual receipt through the opt-in sender tool, without executing or polling", async () => {
  const registered = new Map<string, (args: { request_id: string }) => Promise<unknown>>();
  const server = {
    registerTool(
      name: string,
      _spec: unknown,
      handler: (args: { request_id: string }) => Promise<unknown>,
    ) {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  const link = {
    async call<T>(): Promise<T> {
      await Promise.resolve();
      throw Error("Read receipt must not poll");
    },
  };
  registerPeerTaskSender(server, {}, link);
  expect(registered.size).toBe(0);
  fs.writeFileSync(
    path.join(aDir, "peer-task-policy.json"),
    JSON.stringify({
      enabled: true,
      localAgentRef: a,
      decider: { kind: "agent", ref: a },
      sharedEndpoint: endpoint,
      sharedKeyFile: path.join(root, "unused.key"),
    }),
  );
  registerPeerTaskSender(
    server,
    { MIND_WAKE_PEER_TASKS: "1", MIND_PEER_TASKS_DATA_DIR: aDir, MIND_SHARED_HUB_URL: endpoint },
    link,
  );
  const read = required(registered.get("get_peer_task_receipt"));
  const task = await sender.request(b, input, "synthetic-request", true);
  const before = (await read({ request_id: task.id })) as { content: { text: string }[] };
  expect(JSON.parse(required(before.content[0]).text)).toMatchObject({
    receipt_status: "unknown_pending",
    hook_ack: null,
    state: "requested",
  });
  await host().sync();
  await host(a).sync();
  const after = (await read({ request_id: task.id })) as { content: { text: string }[] };
  expect(JSON.parse(required(after.content[0]).text)).toMatchObject({
    receipt_status: "received_pending_decision",
    state: "requested",
  });
  expect(launch).not.toHaveBeenCalled();
});

it("leaves the sender cursor retryable when ACK races send persistence", async () => {
  const task = await sender.request(b, input, "synthetic-request", true);
  await host().sync();
  const db = new Database(path.join(aDir, "peer-tasks.sqlite"));
  try {
    const pending = { ...task, state: "outbound_pending", threadId: null, messageId: null };
    db.prepare("UPDATE tasks SET json=? WHERE id=?").run(JSON.stringify(pending), task.id);
    await expect(host(a).sync()).rejects.toThrow("send still pending");
    expect(rows(aDir, "cursors")).toEqual([]);
    db.prepare("UPDATE tasks SET json=? WHERE id=?").run(JSON.stringify(task), task.id);
  } finally {
    db.close();
  }
  await host(a).sync();
  expect(sender.get(task.id).hookAck?.status).toBe("received_pending_decision");
});

it("does not acknowledge a conflicting proposal identity or advance on invalid transport publication proof", async () => {
  await sender.request(b, input, "synthetic-request", true);
  const remote = transport(b);
  const malformed: SharedInboxTransport = {
    async call<T>(call: SharedInboxCall, signal?: AbortSignal): Promise<T> {
      const result = await remote.call<T>(call, signal);
      return call.op === "reply"
        ? ({ message_id: "msg_synthetic2", thread_id: "thr_wrongthread" } as T)
        : result;
    },
  };
  await expect(host(b, true, () => true, malformed).sync()).rejects.toThrow("thread mismatch");
  expect(rows(bDir, "cursors")).toEqual([]);
  expect(rows(bDir, "hook_receipts")).toMatchObject([{ sent: 0 }]);
  await host().sync();
  const other = makeRequest(
    a,
    b,
    { ...input, prompt: "Changed prompt" },
    "synthetic-request",
    true,
  );
  put(a, b, wire(other));
  await host().sync();
  expect(publications).toHaveLength(2);
  expect(readOwnerInboxHistory(bDir)).toHaveLength(1);
  await host(a).sync();
  const receipt = sender.get(other.request_id).hookAck;
  expect(receipt?.prompt_hash).not.toBe(other.prompt_hash);
});

it("uses the existing 5 second poll with a 250 ms timer rather than creating an AI wake", async () => {
  vi.useFakeTimers();
  const session = host();
  session.start(() => {});
  await vi.advanceTimersByTimeAsync(250);
  await sender.request(b, input, "synthetic-request", true);
  await vi.advanceTimersByTimeAsync(4999);
  expect(publications).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(publications).toHaveLength(1);
  expect(launch).not.toHaveBeenCalled();
  expect(ownerMessagePending(bDir, true)).toBe(false);
});

it("suppresses timer error publication after stopping an in-flight transport", async () => {
  vi.useFakeTimers();
  const onError = vi.fn();
  const link: SharedInboxTransport = {
    async call<T>(call: SharedInboxCall, signal?: AbortSignal): Promise<T> {
      if (call.op === "whoami") return { kind: "agent", ref: b } as T;
      return await new Promise<T>((_resolve, reject) =>
        signal?.addEventListener(
          "abort",
          () => {
            reject(Error("cancelled"));
          },
          { once: true },
        ),
      );
    },
  };
  const session = host(b, true, () => true, link);
  session.start(onError);
  await vi.advanceTimersByTimeAsync(250);
  session.stop();
  await vi.advanceTimersByTimeAsync(5000);
  expect(onError).not.toHaveBeenCalled();
  expect(rows(bDir, "cursors")).toEqual([]);
  expect(publications).toEqual([]);
});

it("runs the real receiver in a synthetic child process and resumes its durable cursor without republishing", async () => {
  await sender.request(b, input, "synthetic-request", true);
  const script = `
    import {SharedInboxSession} from './src/communication/shared-inbox.ts';
    const [dir,binding,message]=process.argv.slice(1).map(JSON.parse), publications=[];
    const link={async call(c){
      if(c.op==='whoami')return {kind:'agent',ref:binding.agentRef};
      if(c.op==='read_inbox')return {messages:c.after<message.sequence?[message]:[],next:Math.max(c.after,message.sequence)};
      publications.push(c);return {message_id:'msg_childreply1',thread_id:c.threadId};
    }};
    const session=new SharedInboxSession(dir,binding,link,()=>true);
    await session.sync();session.stop();console.log(JSON.stringify(publications));
  `;
  const run = () =>
    spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "--disable-warning=ExperimentalWarning",
        "--import",
        "./test/fixtures/store-ledger/ts-hooks.ts",
        "--input-type=module",
        "-e",
        script,
        JSON.stringify(bDir),
        JSON.stringify(binding(b)),
        JSON.stringify(messages[0]),
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 },
    );
  const first = run();
  expect(first.status, first.stderr).toBe(0);
  const published = JSON.parse(first.stdout) as { text: string }[];
  expect(published).toHaveLength(1);
  expect(validHookAck(required(published[0]).text)?.status).toBe("received_pending_decision");
  expect(readOwnerInboxHistory(bDir)).toHaveLength(1);
  expect(rows(bDir, "hook_receipts")).toMatchObject([{ sent: 1 }]);
  const resumed = run();
  expect(resumed.status, resumed.stderr).toBe(0);
  expect(JSON.parse(resumed.stdout)).toEqual([]);
});
