/** Opt-in remote agent inbox, alive only inside an already authorised Wake session. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import * as z from "zod";
import { SharedInboxHttps, type SharedInboxCall } from "./shared-inbox-https.js";
const partyRefSchema = z.string().regex(/^(agent|human)-[a-z2-9]{10}$/);
const messageIdSchema = z.string().regex(/^msg_[A-Za-z0-9_-]{8,64}$/);
const threadIdSchema = z.string().regex(/^thr_[A-Za-z0-9_-]{8,64}$/);
const LIMITS = {maxInboxBatch: 50, maxMessageChars: 4000} as const;
import { enqueueOwnerMessage } from "./owner-inbox.js";

const bindingSchema = z.strictObject({
  enabled: z.boolean(), profileId: z.string().min(1), endpoint: z.string(),
  agentRef: partyRefSchema, keyFile: z.string(),
});
export type SharedInboxBinding = z.infer<typeof bindingSchema>;
const pageSchema = z.object({
  next: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  messages: z.array(z.object({
    message_id: messageIdSchema, thread_id: threadIdSchema,
    from: partyRefSchema, to: partyRefSchema, from_self: z.boolean(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    text: z.string().min(1).max(LIMITS.maxMessageChars),
    provenance: z.object({kind: z.enum(["agent", "human", "service"]), channel: z.literal("mind-shared-hub"), received_at: z.string().refine(v => Number.isFinite(Date.parse(v)))}),
  })).max(LIMITS.maxInboxBatch),
});
function regular(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error("Invalid shared inbox file");
}
function textFile(file: string): string {
  regular(file);
  if (fs.statSync(file).size > 32_768) throw Error("Shared inbox configuration too large");
  return fs.readFileSync(file, "utf8");
}
export function loadSharedInboxBinding(dataDir: string, profileId: string): SharedInboxBinding | null {
  const file = path.join(dataDir, "shared-inbox.json");
  if (!fs.existsSync(file)) return null;
  const binding = bindingSchema.parse(JSON.parse(textFile(file)));
  if (!binding.enabled) return null;
  if (binding.profileId !== profileId || !path.isAbsolute(binding.keyFile)) throw Error("Shared inbox profile/key binding mismatch");
  return binding;
}
export interface SharedInboxTransport { call<T>(request: SharedInboxCall, signal?: AbortSignal): Promise<T> }
/** Cursor commits only after durable, idempotent queue writes. A crash replays safely. */
export class SharedInboxSession {
  #busy = false;
  #stopped = false;
  #verified = false;
  #nextRead = 0;
  #timer: NodeJS.Timeout | undefined;
  readonly #abort = new AbortController();
  readonly #route: string;
  constructor(
    private readonly dataDir: string,
    private readonly binding: SharedInboxBinding,
    private readonly transport: SharedInboxTransport,
    private readonly isActive: () => boolean,
  ) {
    this.#route = createHash("sha256").update(JSON.stringify(["global-inbox", binding.endpoint, binding.agentRef])).digest("hex");
  }
  #active(): boolean { return !this.#stopped && !this.#abort.signal.aborted && this.isActive(); }
  #store(): Database.Database {
    const file = path.join(this.dataDir, "shared-inbox.sqlite");
    if (fs.existsSync(file)) regular(file);
    const db = new Database(file);
    db.pragma("busy_timeout = 5000");
    db.exec("CREATE TABLE IF NOT EXISTS cursors(route TEXT PRIMARY KEY, sequence INTEGER NOT NULL)");
    return db;
  }
  async sync(): Promise<void> {
    if (this.#busy || !this.#active()) return;
    this.#busy = true;
    this.#nextRead = Date.now() + 5_000;
    try {
      if (!this.#verified) {
        const identity = await this.transport.call<{ref: string; kind: string}>({op: "whoami"}, this.#abort.signal);
        if (!this.#active()) return;
        if (identity.ref !== this.binding.agentRef || identity.kind !== "agent") { this.stop(); throw Error("Shared inbox requires the bound agent identity"); }
        this.#verified = true;
      }
      if (!this.#active()) return;
      let db = this.#store();
      let after: number;
      try { after = (db.prepare("SELECT sequence FROM cursors WHERE route=?").get(this.#route) as {sequence:number}|undefined)?.sequence ?? 0; }
      finally { db.close(); }
      if (!this.#active()) return;
      const result = pageSchema.parse(await this.transport.call<unknown>({op: "read_inbox", after, limit: LIMITS.maxInboxBatch}, this.#abort.signal));
      if (!this.#active()) return;
      let previous = after;
      for (const message of result.messages) {
        if (message.sequence <= previous) throw Error("Shared inbox sequence regression");
        previous = message.sequence;
      }
      if (result.next !== previous) throw Error("Invalid shared inbox cursor");
      for (const message of result.messages) {
        if (!this.#active()) return;
        if (message.from_self || message.to !== this.binding.agentRef || message.from === this.binding.agentRef) continue;
        const id = `shared-inbox:${this.#route}:${message.message_id}`;
        enqueueOwnerMessage(this.dataDir, {
          id, at: message.provenance.received_at, text: message.text,
          origin: {kind: "peer_message", channel: "mind-shared-hub", author: message.from,
            senderRef: message.from, recipientRef: message.to, threadId: message.thread_id,
            messageId: message.message_id, correlationId: id},
        });
      }
      if (!this.#active()) return;
      db = this.#store();
      try { db.prepare("INSERT INTO cursors(route,sequence) VALUES (?,?) ON CONFLICT(route) DO UPDATE SET sequence=MAX(sequence,excluded.sequence)").run(this.#route, result.next); }
      finally { db.close(); }
    } finally { this.#busy = false; }
  }
  /** No scheduler subscription: this timer is owned and closed by one existing session. */
  start(onError: () => void): void {
    if (this.#timer || !this.#active()) return;
    this.#timer = setInterval(() => {
      if (!this.#active()) { this.stop(); return; }
      if (Date.now() < this.#nextRead || this.#busy) return;
      this.#nextRead = Date.now() + 5_000;
      void this.sync().catch(onError);
    }, 250);
  }
  stop(): void {
    this.#stopped = true; this.#abort.abort();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
export function openSharedInboxSession(dataDir: string, profileId: string, isActive: () => boolean): SharedInboxSession | null {
  if (!isActive()) return null;
  const binding = loadSharedInboxBinding(dataDir, profileId);
  if (!binding || !isActive()) return null;
  const link = new SharedInboxHttps(binding.endpoint, textFile(binding.keyFile).trim());
  return new SharedInboxSession(dataDir, binding, link, isActive);
}
