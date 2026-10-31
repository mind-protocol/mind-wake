import { expect, it, vi } from "vitest";
import type { SessionId } from "../contracts/index.js";
import type { CodexCommand, CodexLauncher, CodexProcess } from "../adapters/codex/launch.js";
import { SharedCodexServerPool } from "./shared-codex-server.js";
type Row = Record<string, unknown>;
class Server implements CodexProcess {
  queue: string[] = [];
  readers: ((line: string | null) => void)[] = [];
  sent: Row[] = [];
  hasExited = false;
  exited: Promise<unknown>;
  end!: () => void;
  constructor() {
    this.exited = new Promise((resolve) => {
      this.end = () => {
        this.hasExited = true;
        for (const reader of this.readers.splice(0)) reader(null);
        resolve({ exit: 0 });
      };
    });
  }
  started() {
    return Promise.resolve(42);
  }
  readLine(): Promise<string | null> {
    const line = this.queue.shift();
    return line !== undefined
      ? Promise.resolve(line)
      : this.hasExited
        ? Promise.resolve(null)
        : new Promise((resolve) => this.readers.push(resolve));
  }
  send(line: string) {
    this.sent.push(JSON.parse(line) as Row);
  }
  emit(message: Row) {
    const line = JSON.stringify(message),
      reader = this.readers.shift();
    if (reader) reader(line);
    else this.queue.push(line);
  }
  terminateTree = vi.fn(() => {
    this.end();
    return Promise.resolve({ confirmed: true, elapsedMs: 0 });
  });
}
const command: CodexCommand = {
  executable: "codex",
  args: ["app-server"],
  env: { PATH: "native" },
  cwd: "workspace",
};
function fixture() {
  const server = new Server();
  const launch = vi.fn(() => server);
  const base: CodexLauncher = {
    launch,
    isolation: () => ({ confined: false, selfTestPassed: false, detail: "host" }),
  };
  const pool = new SharedCodexServerPool(base);
  const a = pool.launch("a" as SessionId, command),
    b = pool.launch("b" as SessionId, {
      ...command,
      env: { ...command.env, MIND_WAKE_SESSION: "b" },
      unattended: true,
    });
  return { server, pool, a, b, launch };
}
async function read(client: CodexProcess): Promise<Row> {
  const line = await client.readLine();
  if (line === null) throw Error("Unexpected closed channel");
  return JSON.parse(line) as Row;
}
async function initialize(f: ReturnType<typeof fixture>) {
  f.a.send(
    JSON.stringify({ id: 0, method: "initialize", params: { clientInfo: { name: "Wake" } } }),
  );
  f.b.send(
    JSON.stringify({ id: 0, method: "initialize", params: { clientInfo: { name: "Wake" } } }),
  );
  const request = f.server.sent[0];
  if (!request) throw Error("No initialize");
  f.server.emit({ id: request["id"], result: { userAgent: "codex" } });
  expect((await read(f.a))["id"]).toBe(0);
  expect((await read(f.b))["id"]).toBe(0);
  f.a.send(JSON.stringify({ method: "initialized" }));
  f.b.send(JSON.stringify({ method: "initialized" }));
}
async function threads(f: ReturnType<typeof fixture>) {
  await initialize(f);
  for (const c of [f.a, f.b])
    c.send(JSON.stringify({ id: 1, method: "thread/start", params: { ephemeral: true } }));
  const requests = f.server.sent.filter((m) => m["method"] === "thread/start");
  for (const [index, request] of requests.entries())
    f.server.emit({ id: request["id"], result: { thread: { id: `thread-${String(index)}` } } });
  await Promise.all([read(f.a), read(f.b)]);
}
it("shares one launch and handshake but maps independent RPC IDs and fresh thread starts", async () => {
  const f = fixture();
  try {
    await threads(f);
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.server.sent.filter((m) => m["method"] === "initialize")).toHaveLength(1);
    expect(f.server.sent.filter((m) => m["method"] === "initialized")).toHaveLength(1);
    const starts = f.server.sent.filter((m) => m["method"] === "thread/start");
    expect(starts).toHaveLength(2);
    expect(starts[0]?.["id"]).not.toBe(starts[1]?.["id"]);
    expect(await f.a.started()).toBe(42);
  } finally {
    await f.pool.dispose();
  }
});
it("routes concurrent thread notifications exclusively and broadcasts only quota updates", async () => {
  const f = fixture();
  try {
    await threads(f);
    f.server.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: "B" },
    });
    f.server.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-0", delta: "A" },
    });
    expect((await read(f.a))["params"]).toEqual({ threadId: "thread-0", delta: "A" });
    expect((await read(f.b))["params"]).toEqual({ threadId: "thread-1", delta: "B" });
    f.server.emit({ method: "account/rateLimits/updated", params: { quota: 3 } });
    expect((await read(f.a))["method"]).toBe("account/rateLimits/updated");
    expect((await read(f.b))["method"]).toBe("account/rateLimits/updated");
  } finally {
    await f.pool.dispose();
  }
});
it("releasing one client preserves the other and the server until worker disposal", async () => {
  const f = fixture();
  await threads(f);
  await f.a.terminateTree();
  expect(f.a.hasExited).toBe(true);
  expect(f.b.hasExited).toBe(false);
  expect(f.server.terminateTree).not.toHaveBeenCalled();
  f.b.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "thread-1" } }));
  const request = f.server.sent.at(-1);
  f.server.emit({ id: request?.["id"], result: { turn: { id: "turn-b" } } });
  expect((await read(f.b))["id"]).toBe(2);
  await f.pool.dispose();
  await f.pool.dispose();
  expect(f.server.terminateTree).toHaveBeenCalledTimes(1);
  expect(await f.b.readLine()).toBeNull();
  expect(() => f.pool.launch("new" as SessionId, command)).toThrow("closed");
});
it("rejects cross-role requests, continuation and unattributable server approvals", async () => {
  const f = fixture();
  try {
    await threads(f);
    f.a.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "thread-1" } }));
    expect((await read(f.a))["error"]).toBeDefined();
    f.a.send(JSON.stringify({ id: 3, method: "thread/resume", params: { threadId: "thread-0" } }));
    expect((await read(f.a))["error"]).toBeDefined();
    f.server.emit({ id: 77, method: "approval/request", params: {} });
    f.server.emit({ id: 78, method: "approval/request", params: { threadId: "thread-1" } });
    const approval = await read(f.b);
    expect(f.server.sent.find((m) => m["id"] === 77)?.["error"]).toBeDefined();
    f.b.send(JSON.stringify({ id: approval["id"], error: { code: -32601, message: "Denied" } }));
    expect(f.server.sent.at(-1)?.["id"]).toBe(78);
  } finally {
    await f.pool.dispose();
  }
});
it("buffers thread-start notifications until their owning response arrives", async () => {
  const f = fixture();
  try {
    await initialize(f);
    f.a.send(JSON.stringify({ id: 1, method: "thread/start", params: { ephemeral: true } }));
    const request = f.server.sent.at(-1);
    f.server.emit({ method: "thread/started", params: { thread: { id: "new-thread" } } });
    f.server.emit({ id: request?.["id"], result: { thread: { id: "new-thread" } } });
    expect((await read(f.a))["id"]).toBe(1);
    expect((await read(f.a))["method"]).toBe("thread/started");
  } finally {
    await f.pool.dispose();
  }
});
it("refuses incompatible launch environments and never silently starts a second server", async () => {
  const f = fixture();
  try {
    expect(() =>
      f.pool.launch("bad" as SessionId, { ...command, env: { PATH: "another-account" } }),
    ).toThrow("Incompatible");
    expect(f.launch).toHaveBeenCalledTimes(1);
  } finally {
    await f.pool.dispose();
  }
});
it("closes virtual clients when the underlying process fails and never restarts itself", async () => {
  const f = fixture();
  f.server.end();
  await f.server.exited;
  await Promise.resolve();
  expect(await f.a.readLine()).toBeNull();
  expect(await f.b.readLine()).toBeNull();
  expect(() => f.pool.launch("new" as SessionId, command)).toThrow("closed");
  expect(f.launch).toHaveBeenCalledTimes(1);
  await f.pool.dispose();
});

it("interrupts a late turn-start reply without killing another active role", async () => {
  const f = fixture();
  try {
    await threads(f);
    f.a.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "thread-0" } }));
    const id = f.server.sent.at(-1)?.["id"];
    const cancellation = f.a.terminateTree(1000);
    f.server.emit({ id, result: { turn: { id: "late-turn" } } });
    f.server.emit({ method: "account/rateLimits/updated", params: { quota: 4 } });
    await read(f.b);
    expect(
      f.server.sent.some(
        (m) => m["method"] === "turn/interrupt" && (m["params"] as Row)["turnId"] === "late-turn",
      ),
    ).toBe(true);
    f.server.emit({
      method: "turn/completed",
      params: { threadId: "thread-0", turn: { id: "late-turn" } },
    });
    expect((await cancellation).confirmed).toBe(true);
    expect(f.server.terminateTree).not.toHaveBeenCalled();
    expect(f.b.hasExited).toBe(false);
  } finally {
    await f.pool.dispose();
  }
});

it("unsubscribes a finished role thread exactly once and keeps other roles available", async () => {
  const f = fixture();
  try {
    await threads(f);
    await f.a.terminateTree();
    await f.a.terminateTree();
    const requests = f.server.sent.filter((m) => m["method"] === "thread/unsubscribe");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.["params"]).toEqual({ threadId: "thread-0" });
    f.server.emit({ id: requests[0]?.["id"], result: { status: "unsubscribed" } });
    f.server.emit({ method: "account/rateLimits/updated", params: { quota: 2 } });
    await read(f.b);
    expect(f.pool.closed).toBe(false);
    expect(f.b.hasExited).toBe(false);
    expect(f.server.terminateTree).not.toHaveBeenCalled();
  } finally {
    await f.pool.dispose();
  }
});
it("waits for a late cancelled turn to finish before releasing its thread resources", async () => {
  const f = fixture();
  try {
    await threads(f);
    f.a.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "thread-0" } }));
    const id = f.server.sent.at(-1)?.["id"];
    const stopped = f.a.terminateTree(1000);
    expect(f.server.sent.filter((m) => m["method"] === "thread/unsubscribe")).toHaveLength(0);
    f.server.emit({ id, result: { turn: { id: "late" } } });
    f.server.emit({
      method: "turn/completed",
      params: { threadId: "thread-0", turn: { id: "late" } },
    });
    await stopped;
    expect(f.server.sent.filter((m) => m["method"] === "thread/unsubscribe")).toHaveLength(1);
  } finally {
    await f.pool.dispose();
  }
});
