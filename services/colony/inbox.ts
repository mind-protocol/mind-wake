import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import * as z from "zod";
import { enqueueOwnerMessage, readOwnerMessage } from "../../src/communication/owner-inbox.js";
import { externalInboxSyncAllowed } from "../../src/communication/external-inbox-policy.js";
import { ColonyRateLimit } from "./client.js";

export interface InboxColonyClient {
  me(): Promise<unknown>;
  notifications(offset: number): Promise<unknown>;
}
const id = z.uuid();
const notification = z.object({
  id,
  notification_type: z.string(),
  message: z.string().max(40000),
  actor: z
    .object({
      id,
      username: z.string().max(200),
      display_name: z.string().max(500).nullable().optional(),
    })
    .nullable()
    .optional(),
  post_id: id.nullable().optional(),
  comment_id: id.nullable().optional(),
  created_at: z.string().refine((s) => Number.isFinite(Date.parse(s))),
  is_read: z.boolean(),
  comment_preview: z
    .object({ excerpt: z.string().max(40000), truncated: z.boolean() })
    .nullable()
    .optional(),
});
const accepted = new Set(["comment_on_post", "reply_to_comment", "mention"]);

/** One collector per profile across all native MCP processes; durable local dedup. */
export class ColonyInbox {
  private busy = false;
  private stopped = false;
  private next = 0;
  private timer: NodeJS.Timeout | undefined;
  private account: string | undefined;
  private readonly owner = randomUUID();
  constructor(
    private readonly dataDir: string,
    private readonly client: InboxColonyClient,
    private readonly active: () => boolean = () => externalInboxSyncAllowed(dataDir),
  ) {}

  start() {
    if (this.timer) return;
    const tick = () => {
      void this.sync().catch(() => {
        process.stderr.write("MIND Colony: synchronisation indisponible ; reprise ultérieure.\n");
      });
    };
    this.timer = setInterval(tick, 60_000);
    this.timer.unref();
    tick();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }
  private allowed() {
    return !this.stopped && this.active();
  }
  private store() {
    const file = path.join(this.dataDir, "colony-inbox.sqlite");
    if (fs.existsSync(file)) {
      const s = fs.lstatSync(file);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw Error("Invalid Colony inbox");
    }
    const db = new Database(file);
    db.pragma("busy_timeout = 5000");
    db.exec(
      "CREATE TABLE IF NOT EXISTS seen(account TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(account,id)); CREATE TABLE IF NOT EXISTS cursors(account TEXT PRIMARY KEY,head TEXT,target TEXT,offset INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY,owner TEXT,until_ms INTEGER)",
    );
    return db;
  }
  async sync() {
    if (this.busy || !this.allowed() || Date.now() < this.next)
      return { imported: 0, inactive: true };
    this.busy = true;
    let db: Database.Database | undefined;
    let acquired = false;
    let imported = 0;
    try {
      db = this.store();
      const now = Date.now();
      acquired =
        db
          .prepare(
            "INSERT INTO lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,until_ms=excluded.until_ms WHERE lease.until_ms<?",
          )
          .run(this.owner, now + 300_000, now).changes === 1;
      if (!acquired) return { imported: 0, inactive: true };
      // Shared throttling survives restart and multiple MCP clients.
      db.exec(
        "CREATE TABLE IF NOT EXISTS throttle(id INTEGER PRIMARY KEY,next_ms INTEGER NOT NULL)",
      );
      const wait = db.prepare("SELECT next_ms FROM throttle WHERE id=1").get() as
        { next_ms: number } | undefined;
      if (wait && now < wait.next_ms) return { imported: 0, inactive: true };
      this.next = now + 60_000;
      db.prepare("INSERT OR REPLACE INTO throttle VALUES(1,?)").run(this.next);
      if (!this.account) this.account = z.object({ id }).parse(await this.client.me()).id;
      if (!this.allowed()) return { imported: 0, inactive: true };
      const account = this.account;
      type Cursor = { head: string | null; target: string | null; offset: number };
      let cursor = db
        .prepare("SELECT head,target,offset FROM cursors WHERE account=?")
        .get(account) as Cursor | undefined;
      const initial = !cursor || (cursor.head === null && cursor.target !== null);
      cursor ??= { head: null, target: null, offset: 0 };
      for (let page = 0; page < 3 && this.allowed(); page++) {
        const raw = await this.client.notifications(cursor.offset);
        // REST currently returns a bare array; also accept a notifications wrapper.
        const rows = z
          .array(notification)
          .max(100)
          .parse(
            Array.isArray(raw)
              ? raw
              : z.object({ notifications: z.array(notification) }).parse(raw).notifications,
          );
        if (!this.allowed()) break;
        const target: string | null = cursor.target ?? rows[0]?.id ?? null;
        let reached = false;
        for (const n of rows) {
          if (n.id === cursor.head) {
            reached = true;
            break;
          }
          if (!this.allowed()) break;
          const seen = db.prepare("SELECT 1 FROM seen WHERE account=? AND id=?").get(account, n.id);
          if (!seen && accepted.has(n.notification_type) && (!initial || !n.is_read)) {
            const messageId = n.comment_id ?? n.id;
            const inboxId = `shared-inbox:colony:${account}:${messageId}`;
            const actor = n.actor?.username ?? n.actor?.display_name ?? "auteur non précisé";
            const link = n.post_id
              ? `https://thecolony.ai/post/${n.post_id}${n.comment_id ? `?focus_comment=${n.comment_id}` : ""}`
              : "https://thecolony.ai/";
            if (!readOwnerMessage(this.dataDir, inboxId)) {
              enqueueOwnerMessage(this.dataDir, {
                id: inboxId,
                at: new Date(n.created_at).toISOString(),
                text: `The Colony · ${actor}\n\n${n.message}${n.comment_preview ? `\n\n${n.comment_preview.excerpt}${n.comment_preview.truncated ? "\n\n(Extrait ; réponse complète sur Colony.)" : ""}` : ""}\n\n[Voir sur The Colony](${link})`,
                origin: {
                  kind: "peer_message",
                  channel: "thecolony",
                  author: `The Colony · ${actor}`,
                  senderRef: `thecolony:${n.actor?.id ?? actor}`,
                  recipientRef: `thecolony:${account}`,
                  threadId: n.post_id ?? n.id,
                  messageId,
                  correlationId: inboxId,
                },
              });
              imported++;
            }
          }
          db.prepare("INSERT OR IGNORE INTO seen VALUES(?,?)").run(account, n.id);
        }
        if (!this.allowed()) break;
        const more = !reached && rows.length === 100;
        cursor = {
          head: more ? cursor.head : (target ?? cursor.head),
          target: more ? target : null,
          offset: more ? cursor.offset + rows.length : 0,
        };
        db.prepare("INSERT OR REPLACE INTO cursors VALUES(?,?,?,?)").run(
          account,
          cursor.head,
          cursor.target,
          cursor.offset,
        );
        if (!more) break;
      }
      return { imported, backlog: cursor.offset > 0 };
    } catch (error) {
      if (error instanceof ColonyRateLimit) {
        this.next = Date.now() + error.retryAfterSeconds * 1000;
        db?.prepare("INSERT OR REPLACE INTO throttle VALUES(1,?)").run(this.next);
      }
      throw error;
    } finally {
      if (acquired) db?.prepare("DELETE FROM lease WHERE id=1 AND owner=?").run(this.owner);
      db?.close();
      this.busy = false;
    }
  }
}
