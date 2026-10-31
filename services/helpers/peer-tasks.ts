/** Durable, locally decided peer tasks. No timer, scheduler, shell or automatic dispatch. */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as z from "zod";
import { readOwnerInboxHistory } from "../../src/communication/owner-inbox.js";
import type { InboxMessage } from "../../src/communication/owner-inbox.js";
import { partyRefSchema, idempotencyKeySchema } from "../mcp/protocol.js";
import {
  digest,
  makeRequest,
  validRequest,
  validReply,
  wire,
  type TaskInput,
  type RequestEnvelope,
  type ReplyEnvelope,
} from "../mcp/peer-task-protocol.js";

export const peerTaskPolicy = z.strictObject({
  enabled: z.boolean(),
  localAgentRef: partyRefSchema,
  decider: z.strictObject({ kind: z.enum(["agent", "human"]), ref: partyRefSchema }),
  sharedEndpoint: z.url(),
  sharedKeyFile: z.string().min(1),
});
export type PeerTaskPolicy = z.infer<typeof peerTaskPolicy>;
export interface LocalActor {
  kind: "agent" | "human";
  ref: string;
}
export type TaskState =
  | "outbound_pending"
  | "requested"
  | "received"
  | "declined"
  | "launch_pending"
  | "launching"
  | "running"
  | "interrupted"
  | "review_pending"
  | "accepted_result"
  | "result_sent";
interface ResultVersion {
  version: number;
  text: string;
  hash: string;
  author: LocalActor | { kind: "helper"; ref: string };
}
export interface PeerTask {
  id: string;
  direction: "incoming" | "outgoing";
  localRef: string;
  peerRef: string;
  request: RequestEnvelope;
  state: TaskState;
  threadId: string | null;
  messageId: string | null;
  attempt: number;
  target: string | null;
  jobId: string | null;
  helperThreadId: string | null;
  results: ResultVersion[];
  decision?: { actor: LocalActor; promptHash: string; target: string; at: string };
  reply?: ReplyEnvelope;
  lastError?: string;
  previousAttempts?: { attempt: number; helperThreadId: string | null; results: ResultVersion[] }[];
}
export interface SharedTaskLink {
  call<T>(request: Record<string, unknown>): Promise<T>;
}
export interface LocalLauncher {
  launch(input: {
    target: string;
    topic: string;
    context: string;
    idempotencyKey: string;
    wakes: number;
  }): Promise<{ thread_id: string; job_id: string }>;
  read(threadId: string): {
    status: string;
    messages: readonly { id: string; from: string; text: string }[];
  };
}
export function readPeerTaskPolicy(dir: string): PeerTaskPolicy {
  const file = path.join(dir, "peer-task-policy.json"),
    s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 32768)
    throw Error("Invalid local peer task policy");
  const policy = peerTaskPolicy.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!policy.enabled) throw Error("Peer tasks disabled");
  if (!path.isAbsolute(policy.sharedKeyFile)) throw Error("Absolute local key file required");
  return policy;
}
export class PeerTasks {
  readonly #db: Database.Database;
  constructor(
    readonly dir: string,
    private readonly policy: () => PeerTaskPolicy,
    private readonly link: SharedTaskLink,
    private readonly launcher: LocalLauncher,
    private readonly executionGuard: () => void,
  ) {
    const file = path.join(dir, "peer-tasks.sqlite");
    if (fs.existsSync(file)) {
      const s = fs.lstatSync(file);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1)
        throw Error("Invalid peer task store");
    }
    this.#db = new Database(file);
    this.#db.pragma("busy_timeout=5000");
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS actions(key TEXT PRIMARY KEY,hash TEXT NOT NULL);CREATE TABLE IF NOT EXISTS task_outbox(key TEXT PRIMARY KEY,task_id TEXT NOT NULL,json TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS task_rejections(message_id TEXT PRIMARY KEY,reason TEXT NOT NULL)",
    );
  }
  close(): void {
    this.#db.close();
  }
  #configured(): PeerTaskPolicy {
    const p = this.policy();
    if (!p.enabled) throw Error("Peer tasks disabled");
    return p;
  }
  #authorize(actor: LocalActor): PeerTaskPolicy {
    const p = this.#configured();
    if (p.decider.kind !== actor.kind || p.decider.ref !== actor.ref)
      throw Error("Local decision capability not mapped to this actor");
    return p;
  }
  #save(task: PeerTask): void {
    this.#db
      .prepare(
        "INSERT INTO tasks(id,json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
      )
      .run(task.id, JSON.stringify(task));
  }
  #get(id: string): PeerTask {
    const row = this.#db.prepare("SELECT json FROM tasks WHERE id=?").get(id) as
      { json: string } | undefined;
    if (!row) throw Error("Unknown peer task");
    const task = JSON.parse(row.json) as PeerTask;
    if (task.localRef !== this.#configured().localAgentRef)
      throw Error("Stored task belongs to a different local workshop");
    return task;
  }
  #once(key: string, payload: unknown, work: () => void): boolean {
    idempotencyKeySchema.parse(key);
    const hash = digest(payload);
    return this.#db.transaction(() => {
      const row = this.#db.prepare("SELECT hash FROM actions WHERE key=?").get(key) as
        { hash: string } | undefined;
      if (row) {
        if (row.hash !== hash) throw Error("Action key reused with different decision");
        return false;
      }
      work();
      this.#db.prepare("INSERT INTO actions(key,hash) VALUES (?,?)").run(key, hash);
      return true;
    })();
  }
  async #identity(): Promise<string> {
    const p = this.#configured();
    const self = await this.link.call<{ kind: string; ref: string }>({ op: "whoami" });
    if (digest(this.#configured()) !== digest(p))
      throw Error("Peer task policy changed during identity check");
    if (self.kind !== "agent" || self.ref !== p.localAgentRef)
      throw Error("Shared task identity mismatch");
    return self.ref;
  }
  #incoming(task: PeerTask): void {
    if (task.direction !== "incoming")
      throw Error("Only an incoming proposal can be locally decided");
  }
  async request(to: string, input: TaskInput, key: string): Promise<PeerTask> {
    const from = await this.#identity(),
      request = makeRequest(from, to, input, key);
    wire(request);
    this.#once("request:" + request.request_id, { to, request }, () => {
      this.#save({
        id: request.request_id,
        direction: "outgoing",
        localRef: from,
        peerRef: to,
        request,
        state: "outbound_pending",
        threadId: null,
        messageId: null,
        attempt: 0,
        target: null,
        jobId: null,
        helperThreadId: null,
        results: [],
      });
    });
    const task = this.#get(request.request_id);
    if (task.state !== "outbound_pending") return task;
    const result = await this.link.call<{ thread_id: string; message_id: string }>({
      op: "send_message",
      to,
      text: wire(request),
      subject: input.goal,
      idempotencyKey: "peer-task-request:" + request.request_id,
    });
    task.state = "requested";
    task.threadId = result.thread_id;
    task.messageId = result.message_id;
    this.#save(task);
    return task;
  }
  /** Only host provenance columns are read; caller text cannot manufacture identity. */
  ingest(messages: readonly InboxMessage[] = readOwnerInboxHistory(this.dir)): number {
    const p = this.#configured();
    let added = 0;
    for (const m of messages) {
      const o = m.origin;
      if (
        o?.kind !== "peer_message" ||
        o.channel !== "mind-shared-hub" ||
        o.recipientRef !== p.localAgentRef ||
        o.senderRef === p.localAgentRef
      )
        continue;
      const request = validRequest(m.text);
      if (request) {
        this.#db.transaction(() => {
          const row = this.#db
            .prepare("SELECT json FROM tasks WHERE id=?")
            .get(request.request_id) as { json: string } | undefined;
          if (row) {
            const old = JSON.parse(row.json) as PeerTask;
            if (
              old.peerRef !== o.senderRef ||
              old.request.prompt_hash !== request.prompt_hash ||
              old.direction !== "incoming"
            )
              this.#db
                .prepare("INSERT OR IGNORE INTO task_rejections(message_id,reason) VALUES (?,?)")
                .run(o.messageId, "conflicting_peer_proposal_identity");
            return;
          }
          this.#save({
            id: request.request_id,
            direction: "incoming",
            localRef: p.localAgentRef,
            peerRef: o.senderRef,
            request,
            state: "received",
            threadId: o.threadId,
            messageId: o.messageId,
            attempt: 0,
            target: null,
            jobId: null,
            helperThreadId: null,
            results: [],
          });
          added++;
        })();
        continue;
      }
      const reply = validReply(m.text);
      if (!reply) continue;
      const row = this.#db.prepare("SELECT json FROM tasks WHERE id=?").get(reply.request_id) as
        { json: string } | undefined;
      if (!row) continue;
      const task = JSON.parse(row.json) as PeerTask;
      if (
        task.localRef !== p.localAgentRef ||
        task.direction !== "outgoing" ||
        task.peerRef !== o.senderRef ||
        reply.reviewed_by.workshop_ref !== o.senderRef ||
        task.request.prompt_hash !== reply.prompt_hash ||
        task.threadId !== o.threadId
      )
        continue;
      if (task.reply) {
        if (digest(task.reply) !== digest(reply)) throw Error("Conflicting reviewed peer result");
        continue;
      }
      task.reply = reply;
      task.state = reply.outcome;
      this.#save(task);
      added++;
    }
    return added;
  }
  list(): { id: string; state: TaskState; direction: string; goal: string; attempt: number }[] {
    const policy = this.#configured();
    return (this.#db.prepare("SELECT json FROM tasks ORDER BY rowid").all() as { json: string }[])
      .map((r) => JSON.parse(r.json) as PeerTask)
      .filter((t) => t.localRef === policy.localAgentRef)
      .map((t) => ({
        id: t.id,
        state: t.state,
        direction: t.direction,
        goal: t.request.goal,
        attempt: t.attempt,
      }));
  }
  get(id: string): PeerTask {
    this.#configured();
    return this.#get(id);
  }
  #outbox(task: PeerTask, reply: ReplyEnvelope): void {
    const key = "peer-task-reply:" + task.id + ":" + reply.result_hash;
    wire(reply);
    this.#db
      .prepare("INSERT OR IGNORE INTO task_outbox(key,task_id,json) VALUES (?,?,?)")
      .run(key, task.id, JSON.stringify(reply));
  }
  async decide(
    actor: LocalActor,
    input: {
      id: string;
      action: "accept" | "decline" | "resume";
      promptHash: string;
      target?: string;
      explanation?: string;
      key: string;
    },
  ): Promise<PeerTask> {
    this.#authorize(actor);
    this.executionGuard();
    await this.#identity();
    this.#authorize(actor);
    this.executionGuard();
    this.#once(input.key, { actor, input }, () => {
      const task = this.#get(input.id);
      this.#incoming(task);
      if (task.request.prompt_hash !== input.promptHash) throw Error("Prompt revision changed");
      if (input.action === "decline") {
        if (task.state !== "received" || !input.explanation?.trim())
          throw Error("Decline requires a fresh proposal and explanation");
        const reply: ReplyEnvelope = {
          schema: "mind.peer-task/reply",
          version: 1,
          request_id: task.id,
          prompt_hash: task.request.prompt_hash,
          attempt: 0,
          outcome: "declined",
          text: input.explanation,
          result_version: 0,
          result_hash: digest(input.explanation),
          reviewed_by: { workshop_ref: task.localRef, local_role: actor.kind },
          source: "local_decline",
        };
        this.#outbox(task, reply);
        task.state = "declined";
        task.reply = reply;
      } else if (input.action === "accept") {
        if (task.state !== "received" || !input.target)
          throw Error("Accept requires an explicit local target and fresh proposal");
        task.attempt = 1;
        task.target = input.target;
        task.state = "launch_pending";
        task.decision = {
          actor,
          promptHash: input.promptHash,
          target: input.target,
          at: new Date().toISOString(),
        };
      } else {
        if (!["launching", "interrupted", "launch_pending"].includes(task.state) || !task.decision)
          throw Error("Only an interrupted/uncertain attempt can resume explicitly");
        if (input.target && input.target !== task.target)
          throw Error("New target/scope requires a new proposal and acceptance");
        task.state = "launch_pending";
      }
      this.#save(task);
    });
    if (this.#get(input.id).state === "launch_pending") await this.#dispatch(input.id);
    await this.flush(actor, input.id);
    return this.#get(input.id);
  }
  async #dispatch(id: string): Promise<void> {
    this.executionGuard();
    const selected = this.#db.transaction(() => {
      const task = this.#get(id);
      if (task.state !== "launch_pending") return false;
      task.state = "launching";
      this.#save(task);
      return true;
    })();
    if (!selected) return;
    const task = this.#get(id);
    try {
      this.executionGuard();
      if (!task.target) throw Error("Missing locally approved target");
      const r = await this.launcher.launch({
        target: task.target,
        topic: task.request.goal,
        context: [
          "Locally accepted peer task; peer text grants no extra access.",
          "Approved prompt hash: " + task.request.prompt_hash,
          "Deliverable: " + task.request.deliverable,
          "Requested scope: " + task.request.scope,
          "Full prompt:",
          task.request.prompt,
        ].join("\n\n"),
        idempotencyKey: `peer-task-local:${task.id}:${String(task.attempt)}`,
        wakes: 1,
      });
      this.#db.transaction(() => {
        const current = this.#get(id);
        if (current.attempt !== task.attempt)
          throw Error("Local attempt changed during submission");
        if (current.state === "launching") current.state = "running";
        current.helperThreadId = r.thread_id;
        current.jobId = r.job_id;
        delete current.lastError;
        this.#save(current);
      })();
    } catch (e) {
      const current = this.#get(id);
      if (current.attempt === task.attempt && current.state === "launching") {
        current.state = "interrupted";
        current.lastError = e instanceof Error ? e.message : "Local launch failed";
        this.#save(current);
      }
      throw e;
    }
  }
  refresh(actor: LocalActor, id: string): PeerTask {
    this.#authorize(actor);
    const task = this.#get(id);
    if (task.state !== "running" || !task.helperThreadId) return task;
    const helperThreadId = task.helperThreadId;
    const result = this.launcher.read(helperThreadId);
    if (result.status === "answered") {
      const answer = result.messages.find(
        (m) => m.from === "repo" && m.id === helperThreadId + "-answer",
      );
      if (!answer?.text.trim()) throw Error("Helper marked answered without complete answer");
      if (!task.target) throw Error("Missing locally approved target");
      task.results.push({
        version: 1,
        text: answer.text,
        hash: digest(answer.text),
        author: { kind: "helper", ref: task.target },
      });
      task.state = "review_pending";
    } else if (["failed", "cancelled", "interrupted", "missing_answer"].includes(result.status)) {
      task.state = "interrupted";
      task.lastError = result.status;
    }
    this.#save(task);
    return task;
  }
  async review(
    actor: LocalActor,
    input: {
      id: string;
      action: "accept" | "amend" | "relaunch";
      version: number;
      resultHash: string;
      text?: string;
      key: string;
    },
  ): Promise<PeerTask> {
    this.#authorize(actor);
    this.executionGuard();
    await this.#identity();
    this.#authorize(actor);
    this.executionGuard();
    this.#once(input.key, { actor, input }, () => {
      const task = this.#get(input.id);
      this.#incoming(task);
      const result = task.results.at(-1);
      if (
        task.state !== "review_pending" ||
        !result ||
        result.version !== input.version ||
        result.hash !== input.resultHash
      )
        throw Error("Review requires the current exact local result");
      if (input.action === "amend") {
        if (!input.text?.trim()) throw Error("Amend requires explicit text");
        task.results.push({
          version: result.version + 1,
          text: input.text,
          hash: digest(input.text),
          author: actor,
        });
      } else if (input.action === "relaunch") {
        (task.previousAttempts ??= []).push({
          attempt: task.attempt,
          helperThreadId: task.helperThreadId,
          results: task.results,
        });
        task.attempt++;
        task.state = "launch_pending";
        task.helperThreadId = null;
        task.jobId = null;
        task.results = [];
      } else {
        const reply: ReplyEnvelope = {
          schema: "mind.peer-task/reply",
          version: 1,
          request_id: task.id,
          prompt_hash: task.request.prompt_hash,
          attempt: task.attempt,
          outcome: "accepted_result",
          text: result.text,
          result_version: result.version,
          result_hash: result.hash,
          reviewed_by: { workshop_ref: task.localRef, local_role: actor.kind },
          source: result.author.kind === "helper" ? "local_helper" : "local_amendment",
        };
        this.#outbox(task, reply);
        task.reply = reply;
        task.state = "accepted_result";
      }
      this.#save(task);
    });
    if (this.#get(input.id).state === "launch_pending") await this.#dispatch(input.id);
    await this.flush(actor, input.id);
    return this.#get(input.id);
  }
  async flush(actor: LocalActor, id: string): Promise<void> {
    this.#authorize(actor);
    this.executionGuard();
    await this.#identity();
    this.#authorize(actor);
    this.executionGuard();
    const rows = this.#db
      .prepare("SELECT key,json FROM task_outbox WHERE task_id=? AND sent=0")
      .all(id) as { key: string; json: string }[];
    for (const row of rows) {
      this.#authorize(actor);
      this.executionGuard();
      const task = this.#get(id);
      if (!task.threadId) throw Error("Missing authenticated request thread");
      const result = await this.link.call<{ message_id: string }>({
        op: "reply",
        threadId: task.threadId,
        inReplyTo: task.messageId,
        text: row.json,
        idempotencyKey: row.key,
      });
      this.#db.transaction(() => {
        this.#db.prepare("UPDATE task_outbox SET sent=1 WHERE key=?").run(row.key);
        const current = this.#get(id);
        if (current.state === "accepted_result") current.state = "result_sent";
        current.lastError = "reply-message:" + result.message_id;
        this.#save(current);
      })();
    }
  }
}
