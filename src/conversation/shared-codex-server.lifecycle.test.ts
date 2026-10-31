import { expect, it, vi } from "vitest";
import type { SessionId } from "../contracts/index.js";
import type { CodexCommand, CodexProcess } from "../adapters/codex/launch.js";
import { SharedCodexServerPool } from "./shared-codex-server.js";

class Transport implements CodexProcess {
  hasExited = false;
  sent: Record<string, unknown>[] = [];
  queue: string[] = [];
  readers: ((line: string | null) => void)[] = [];
  private done!: (value: unknown) => void;
  exited = new Promise<unknown>((resolve) => {
    this.done = resolve;
  });
  started() {
    return Promise.resolve(42);
  }
  send(line: string) {
    this.sent.push(JSON.parse(line) as Record<string, unknown>);
  }
  readLine() {
    const line = this.queue.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.hasExited) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => this.readers.push(resolve));
  }
  push(value: Record<string, unknown>) {
    const line = JSON.stringify(value),
      next = this.readers.shift();
    if (next) next(line);
    else this.queue.push(line);
  }
  terminateTree = vi.fn(() => {
    this.hasExited = true;
    for (const resolve of this.readers.splice(0)) resolve(null);
    this.done({});
    return Promise.resolve({ confirmed: true, elapsedMs: 0 });
  });
}
const command: CodexCommand = {
  executable: "codex.exe",
  args: ["app-server"],
  env: { CODEX_HOME: "profile" },
  cwd: "workspace",
};
function setup() {
  const server = new Transport();
  const pool = new SharedCodexServerPool({
    isolation: () => ({ confined: false, selfTestPassed: false, detail: "fixture" }),
    launch: () => server,
  });
  return { server, pool };
}
async function reply(
  server: Transport,
  client: CodexProcess,
  method: string,
  result: unknown,
  params = {},
) {
  client.send(JSON.stringify({ id: 1, method, params }));
  const id = server.sent.at(-1)?.["id"];
  server.push({ id, result });
  return JSON.parse((await client.readLine()) ?? "{}") as Record<string, unknown>;
}
it("does not confirm cancellation while an unacknowledged model turn remains alive", async () => {
  const { server, pool } = setup();
  try {
    const client = pool.launch("role-a" as SessionId, command);
    await reply(server, client, "initialize", { userAgent: "fixture" });
    client.send(JSON.stringify({ method: "initialized", params: {} }));
    await reply(server, client, "thread/start", { thread: { id: "thread-a" } });
    client.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "thread-a" } }));
    // No reply/interrupt acknowledgement ever comes back from the provider.
    const cancellation = await client.terminateTree(25);
    expect(cancellation.confirmed && !server.hasExited).toBe(false);
  } finally {
    await pool.dispose();
  }
});
it("ends all virtual streams when the shared native server disappears", async () => {
  const { server, pool } = setup();
  try {
    const first = pool.launch("role-a" as SessionId, command);
    const second = pool.launch("role-b" as SessionId, command);
    const reads = [first.readLine(), second.readLine()];
    await server.terminateTree();
    expect(await Promise.all(reads)).toEqual([null, null]);
    expect(first.hasExited).toBe(true);
    expect(second.hasExited).toBe(true);
  } finally {
    await pool.dispose();
  }
});
it("keeps role notifications separate and rejects another role's thread", async () => {
  const { server, pool } = setup();
  try {
    const first = pool.launch("role-a" as SessionId, command);
    const second = pool.launch("role-b" as SessionId, command);
    await reply(server, first, "initialize", { userAgent: "fixture" });
    first.send(JSON.stringify({ method: "initialized", params: {} }));
    second.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await second.readLine();
    await reply(server, first, "thread/start", { thread: { id: "thread-a" } });
    await reply(server, second, "thread/start", { thread: { id: "thread-b" } });
    server.push({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-a", delta: "A only" },
    });
    server.push({ method: "account/rateLimits/updated", params: { rateLimits: {} } });
    expect(JSON.parse((await first.readLine()) ?? "{}")).toMatchObject({
      params: { delta: "A only" },
    });
    expect(JSON.parse((await second.readLine()) ?? "{}")).toMatchObject({
      method: "account/rateLimits/updated",
    });
    const before = server.sent.length;
    second.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "thread-a" } }));
    expect(JSON.parse((await second.readLine()) ?? "{}")).toMatchObject({
      error: { code: -32601 },
    });
    expect(server.sent.length).toBe(before);
  } finally {
    await pool.dispose();
  }
});
