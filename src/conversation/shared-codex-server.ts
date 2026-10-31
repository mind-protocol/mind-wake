/** One app-server transport, independent ephemeral role threads. No model continuation. */
import type { SessionId } from "../contracts/index.js";
import type { CodexCommand, CodexLauncher, CodexProcess } from "../adapters/codex/launch.js";

type Row = Record<string, unknown>;
const row = (v: unknown): Row | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Row) : undefined;
function threadId(message: Row): string | undefined {
  const p = row(message["params"]);
  const id = p?.["threadId"] ?? p?.["thread_id"] ?? row(p?.["thread"])?.["id"];
  return typeof id === "string" ? id : undefined;
}
function signature(command: CodexCommand): string {
  const env = { ...command.env };
  delete env["MIND_WAKE_SESSION"];
  return JSON.stringify([
    command.executable,
    command.args,
    command.cwd,
    Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
    command.broker ?? null,
  ]);
}
class Client implements CodexProcess {
  readonly queue: string[] = [];
  readonly readers: ((line: string | null) => void)[] = [];
  readonly exited: Promise<unknown>;
  private finish!: (value: unknown) => void;
  hasExited = false;
  constructor(readonly pool: SharedCodexServerPool) {
    this.exited = new Promise((resolve) => {
      this.finish = resolve;
    });
  }
  started(): Promise<number> {
    return this.pool.started();
  }
  readLine(): Promise<string | null> {
    const line = this.queue.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.hasExited) return Promise.resolve(null);
    return new Promise((resolve) => this.readers.push(resolve));
  }
  push(message: Row): void {
    if (this.hasExited) return;
    const line = JSON.stringify(message),
      reader = this.readers.shift();
    if (reader) reader(line);
    else this.queue.push(line);
  }
  send(line: string): void {
    if (!this.hasExited) this.pool.send(this, line);
  }
  terminateTree(timeoutMs = 1000): Promise<{ confirmed: boolean; elapsedMs: number }> {
    return this.pool.terminate(this, timeoutMs);
  }
  close(): void {
    if (this.hasExited) return;
    this.hasExited = true;
    this.queue.length = 0;
    for (const reader of this.readers.splice(0)) reader(null);
    this.finish({ reason: "virtual_client_closed" });
  }
}
interface Pending {
  client: Client;
  localId: unknown;
  method: string;
  thread?: string;
}
export class SharedCodexServerPool implements CodexLauncher {
  readonly launcher: CodexLauncher = this;
  private process: CodexProcess | undefined;
  private commandKey: string | undefined;
  private disposed = false;
  private nextId = 1;
  private clients = new Set<Client>();
  private pending = new Map<number, Pending>();
  private threads = new Map<string, Client>();
  private seenThreads = new Set<string>();
  private turns = new Map<string, string>();
  private completedTurns = new Set<string>();
  private cancellations = new Map<Client, () => void>();
  private early = new Map<string, Row[]>();
  private serverRequests = new Map<string, { client: Client; id: unknown }>();
  private initialization: Row | undefined;
  private initializationId: number | undefined;
  private initializationWaiters: { client: Client; id: unknown }[] = [];
  private initialized = false;
  private closing: Promise<void> | undefined;
  constructor(private readonly base: CodexLauncher) {}
  get closed(): boolean {
    return this.disposed || this.process?.hasExited === true;
  }
  isolation(sessionId: SessionId): ReturnType<CodexLauncher["isolation"]> {
    return this.base.isolation(sessionId);
  }
  launch(sessionId: SessionId, command: CodexCommand): CodexProcess {
    if (this.disposed || this.process?.hasExited) throw Error("Shared Codex server is closed");
    const key = signature(command);
    if (this.commandKey !== undefined && key !== this.commandKey)
      throw Error("Incompatible shared Codex command");
    if (!this.process) {
      this.process = this.base.launch(sessionId, command);
      this.commandKey = key;
      void this.pump().catch(() => {
        this.closeClients();
        void this.process?.terminateTree(1000).catch(() => undefined);
      });
      void this.process.exited.then(
        () => {
          this.closeClients();
        },
        () => {
          this.closeClients();
        },
      );
    }
    const client = new Client(this);
    this.clients.add(client);
    return client;
  }
  started(): Promise<number> {
    return this.process ? this.process.started() : Promise.reject(Error("Server not started"));
  }
  private write(message: Row): void {
    if (!this.disposed) this.process?.send(JSON.stringify(message));
  }
  private error(client: Client, id: unknown, message: string): void {
    client.push({ id, error: { code: -32601, message } });
  }
  send(client: Client, line: string): void {
    let message: Row | undefined;
    try {
      message = row(JSON.parse(line));
    } catch {
      throw Error("Malformed virtual Codex RPC");
    }
    if (!message) throw Error("Malformed virtual Codex RPC");
    const method = message["method"],
      id = message["id"];
    if (typeof method !== "string") {
      const token = typeof id === "string" ? this.serverRequests.get(id) : undefined;
      if (!token || token.client !== client) throw Error("Unattributed server RPC response");
      this.serverRequests.delete(String(id));
      this.write({ ...message, id: token.id });
      return;
    }
    if (method === "initialize") {
      if (id === undefined) throw Error("Initialize requires a request ID");
      if (this.initialization) {
        client.push({ ...this.initialization, id });
        return;
      }
      this.initializationWaiters.push({ client, id });
      if (this.initializationId === undefined) {
        this.initializationId = this.nextId++;
        this.write({ ...message, id: this.initializationId });
      }
      return;
    }
    if (method === "initialized") {
      if (!this.initialization || this.initialization["error"])
        throw Error("Server is not initialized");
      if (!this.initialized) {
        this.initialized = true;
        this.write(message);
      }
      return;
    }
    if (method === "thread/resume" || method === "thread/fork") {
      this.error(client, id, "Fresh thread/start required");
      return;
    }
    const thread = threadId(message);
    if (thread && this.threads.get(thread) !== client) {
      this.error(client, id, "Thread does not belong to this role");
      return;
    }
    if (id === undefined) {
      this.write(message);
      return;
    }
    const globalId = this.nextId++;
    this.pending.set(globalId, { client, localId: id, method, ...(thread ? { thread } : {}) });
    this.write({ ...message, id: globalId });
  }
  release(client: Client): void {
    this.clients.delete(client);
    client.close();
    this.initializationWaiters = this.initializationWaiters.filter((w) => w.client !== client);
    for (const [id, p] of this.pending)
      if (p.client === client && p.method !== "turn/start" && p.method !== "thread/start")
        this.pending.delete(id);
    for (const [id, owner] of this.threads)
      if (owner === client) {
        const turn = this.turns.get(id);
        if (turn) this.interrupt(id, turn);
        this.early.delete(id);
      }
    for (const [token, request] of this.serverRequests)
      if (request.client === client) {
        this.write({ id: request.id, error: { code: -32601, message: "Role closed" } });
        this.serverRequests.delete(token);
      }
  }
  terminate(client: Client, timeoutMs: number): Promise<{ confirmed: boolean; elapsedMs: number }> {
    const began = performance.now();
    this.release(client);
    if (!this.outstanding(client))
      return Promise.resolve({ confirmed: true, elapsedMs: performance.now() - began });
    return new Promise((resolve) => {
      let finished = false;
      const done = (confirmed: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.cancellations.delete(client);
        resolve({ confirmed, elapsedMs: performance.now() - began });
      };
      const timer = setTimeout(
        () => {
          void this.dispose().then(
            () => {
              done(this.process?.hasExited === true);
            },
            () => {
              done(false);
            },
          );
        },
        Math.max(1, timeoutMs),
      );
      this.cancellations.set(client, () => {
        if (!this.outstanding(client)) done(true);
      });
    });
  }
  private outstanding(client: Client): boolean {
    return (
      [...this.pending.values()].some((p) => p.client === client && p.method === "turn/start") ||
      [...this.threads].some(([thread, owner]) => owner === client && this.turns.has(thread))
    );
  }
  private closeClients(): void {
    this.disposed = true;
    for (const client of [...this.clients]) this.release(client);
    this.pending.clear();
    this.early.clear();
    if (this.process?.hasExited) {
      this.turns.clear();
      for (const done of [...this.cancellations.values()]) done();
    }
  }
  private async pump(): Promise<void> {
    if (!this.process) return;
    for (;;) {
      const line = await this.process.readLine();
      if (line === null) break;
      let m: Row | undefined;
      try {
        m = row(JSON.parse(line));
      } catch {
        continue;
      }
      if (!m) continue;
      const id = m["id"],
        method = m["method"];
      if (typeof method !== "string") {
        if (typeof id !== "number") continue;
        if (id === this.initializationId) {
          this.initialization = m;
          for (const w of this.initializationWaiters.splice(0)) w.client.push({ ...m, id: w.id });
          continue;
        }
        const p = this.pending.get(id);
        if (!p) continue;
        this.pending.delete(id);
        if (p.method === "thread/start" && !m["error"]) {
          const result = row(m["result"]),
            thread = row(result?.["thread"])?.["id"] ?? result?.["threadId"];
          if (typeof thread === "string") {
            if (this.seenThreads.has(thread)) {
              this.error(p.client, p.localId, "Server reused an existing thread");
              continue;
            }
            this.threads.set(thread, p.client);
            this.seenThreads.add(thread);
            p.client.push({ ...m, id: p.localId });
            for (const early of this.early.get(thread) ?? [])
              this.dispatchNotification(p.client, early);
            this.early.delete(thread);
            continue;
          }
        }
        if (p.method === "turn/start" && p.thread && !m["error"]) {
          const turn = row(row(m["result"])?.["turn"])?.["id"];
          if (typeof turn === "string") {
            if (!this.completedTurns.has(JSON.stringify([p.thread, turn])))
              this.turns.set(p.thread, turn);
            if (p.client.hasExited) this.interrupt(p.thread, turn);
          }
        }
        p.client.push({ ...m, id: p.localId });
        this.cancellations.get(p.client)?.();
        continue;
      }
      const thread = threadId(m),
        owner = thread ? this.threads.get(thread) : undefined;
      if (id !== undefined) {
        if (!owner || owner.hasExited) {
          this.write({ id, error: { code: -32601, message: "Unattributed server request" } });
          continue;
        }
        const token = `server:${String(this.nextId++)}`;
        this.serverRequests.set(token, { client: owner, id });
        owner.push({ ...m, id: token });
        continue;
      }
      if (owner) this.dispatchNotification(owner, m);
      else if (method === "account/rateLimits/updated")
        for (const client of this.clients) client.push(m);
      else if (thread && [...this.pending.values()].some((p) => p.method === "thread/start")) {
        const buffered = this.early.get(thread) ?? [];
        if (buffered.length >= 256 || this.early.size >= 256)
          throw Error("Unattributed Codex notification overflow");
        buffered.push(m);
        this.early.set(thread, buffered);
      }
    }
    this.closeClients();
  }
  private dispatchNotification(client: Client, message: Row): void {
    const thread = threadId(message),
      params = row(message["params"]);
    const turn = row(params?.["turn"])?.["id"] ?? params?.["turnId"];
    if (thread && message["method"] === "turn/started" && typeof turn === "string") {
      if (!this.completedTurns.has(JSON.stringify([thread, turn]))) this.turns.set(thread, turn);
      if (client.hasExited) this.interrupt(thread, turn);
    }
    if (thread && message["method"] === "turn/completed") {
      this.turns.delete(thread);
      if (typeof turn === "string") this.completedTurns.add(JSON.stringify([thread, turn]));
    }
    client.push(message);
    this.cancellations.get(client)?.();
  }
  private interrupt(threadId: string, turnId: string): void {
    this.write({ id: this.nextId++, method: "turn/interrupt", params: { threadId, turnId } });
  }
  dispose(): Promise<void> {
    if (!this.closing) {
      this.closeClients();
      this.closing = (async () => {
        await this.process?.terminateTree(1000);
      })();
    }
    return this.closing;
  }
}

export { SharedCodexServerPool as SharedCodexServer };
