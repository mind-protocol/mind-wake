import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import * as z from "zod";
import { enqueueOwnerMessage, readOwnerMessage } from "../../src/communication/owner-inbox.js";
import { openStoreReadOnly } from "../../src/store/index.js";
import { controlDbPath } from "../../src/daemon/paths.js";
import { resolvePolicy } from "../../src/policy/index.js";
import { DEFAULT_PROFILE_ID } from "../../src/cli/context.js";
import { RedditError } from "./client.js";

type Item = Record<string, unknown>;
type Page = { posts: Item[]; after: string | null };
export interface InboxRedditClient {
  me(): Promise<Item>;
  feed(input: { subreddit: string; sort: "new"; limit: number; after?: string }): Promise<Page>;
  incoming(kind: "comments" | "selfreply", after?: string): Promise<Page>;
}
interface Cursor {
  head: string | null;
  target: string | null;
  after_id: string | null;
}
const fullName = z.string().regex(/^t[13]_[a-z0-9]+$/);
const pageSchema = z.object({
  after: z
    .string()
    .regex(/^t[134]_[a-z0-9]+$/)
    .nullable(),
  posts: z.array(z.record(z.string(), z.unknown())).max(100),
});

export function redditSyncAllowed(dataDir: string): boolean {
  if (fs.existsSync(path.join(dataDir, "emergency-stop.flag"))) return false;
  try {
    const store = openStoreReadOnly(controlDbPath(dataDir));
    try {
      const profile = store.uow.profiles.get(DEFAULT_PROFILE_ID);
      return (
        profile !== null &&
        !profile.emergencyStopLocked &&
        !["paused", "checkpointing", "stopped", "disabled"].includes(profile.state) &&
        resolvePolicy(store.uow.policies, DEFAULT_PROFILE_ID).status === "active"
      );
    } finally {
      store.close();
    }
  } catch {
    return false;
  }
}

/** Metadata/cursors only. Text enters the existing attributed inbox, never the human log. */
export class RedditInbox {
  private busy = false;
  private stopped = false;
  private next = 0;
  private timer: NodeJS.Timeout | undefined;
  private account: string | undefined;
  private readonly owner = randomUUID();
  constructor(
    private readonly dataDir: string,
    private readonly client: InboxRedditClient,
    private readonly subscriptions: readonly string[],
    private readonly replies: boolean,
    private readonly active: () => boolean = () => redditSyncAllowed(dataDir),
  ) {}

  private store() {
    const file = path.join(this.dataDir, "reddit-inbox.sqlite");
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw Error("Invalid Reddit inbox store");
    }
    const db = new Database(file);
    db.pragma("busy_timeout = 5000");
    db.exec(
      "CREATE TABLE IF NOT EXISTS cursors(source TEXT PRIMARY KEY,head TEXT,target TEXT,after_id TEXT); CREATE TABLE IF NOT EXISTS imported(account TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(account,id)); CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY,owner TEXT,until_ms INTEGER)",
    );
    return db;
  }
  private allowed() {
    return !this.stopped && this.active();
  }
  start() {
    if (this.timer) return;
    const tick = () => {
      void this.sync().catch(() => {
        process.stderr.write(
          "MIND Reddit: synchronisation indisponible ; prochain essai selon la limite fournisseur.\n",
        );
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
  async sync() {
    if (this.busy || !this.allowed() || Date.now() < this.next)
      return { imported: 0, inactive: true };
    this.busy = true;
    this.next = Date.now() + 60_000;
    let db: Database.Database | undefined;
    let acquired = false;
    let imported = 0;
    try {
      db = this.store();
      acquired =
        db
          .prepare(
            "INSERT INTO lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,until_ms=excluded.until_ms WHERE lease.until_ms<?",
          )
          .run(this.owner, Date.now() + 300_000, Date.now()).changes === 1;
      if (!acquired) return { imported: 0, inactive: true };
      if (!this.account)
        this.account = z
          .string()
          .min(1)
          .parse((await this.client.me())["name"])
          .toLowerCase();
      const sources = [
        ...new Set(this.subscriptions.map((s) => `r:${s.toLowerCase()}`)),
        ...(this.replies ? ["comments", "selfreply"] : []),
      ];
      const errors: string[] = [];
      for (const source of sources) {
        if (!this.allowed()) break;
        const key = `${this.account}:${source}`;
        let cursor = db
          .prepare("SELECT head,target,after_id FROM cursors WHERE source=?")
          .get(key) as Cursor | undefined;
        try {
          // Three pages per source per pass; unfinished pagination is durably resumed.
          for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
            if (!this.allowed()) break;
            if (
              db
                .prepare("UPDATE lease SET until_ms=? WHERE id=1 AND owner=?")
                .run(Date.now() + 300_000, this.owner).changes !== 1
            )
              break;
            const after = cursor?.after_id ?? undefined;
            const page = pageSchema.parse(
              source.startsWith("r:")
                ? await this.client.feed({
                    subreddit: source.slice(2),
                    sort: "new",
                    limit: 100,
                    ...(after ? { after } : {}),
                  })
                : await this.client.incoming(
                    source === "comments" ? "comments" : "selfreply",
                    after,
                  ),
            );
            if (!this.allowed()) break;
            const first = page.posts[0]?.["name"];
            const newest = first === undefined ? null : fullName.parse(first);
            if (!cursor) {
              // Start now, without flooding the thread with historical posts/replies.
              db.prepare("INSERT INTO cursors VALUES(?,?,NULL,NULL)").run(key, newest);
              break;
            }
            const target: string | null = cursor.target ?? newest;
            let reached = false;
            for (const item of page.posts) {
              const id = fullName.parse(item["name"]);
              if (id === cursor.head) {
                reached = true;
                break;
              }
              if (!this.allowed()) break;
              const exists = db
                .prepare("SELECT 1 FROM imported WHERE account=? AND id=?")
                .get(this.account, id);
              if (!exists) {
                const author = typeof item["author"] === "string" ? item["author"] : "[deleted]";
                const sub = z
                  .string()
                  .regex(/^[A-Za-z0-9_]{2,21}$/)
                  .parse(item["subreddit"]);
                const rawLink = item["permalink"] ?? item["context"];
                const link = new URL(z.string().parse(rawLink), "https://www.reddit.com");
                if (link.origin !== "https://www.reddit.com" || !link.pathname.startsWith("/r/"))
                  throw Error("Invalid Reddit permalink");
                link.search = "";
                link.hash = "";
                const body = z
                  .string()
                  .max(40000)
                  .parse(item[id.startsWith("t3_") ? "selftext" : "body"] ?? "");
                const title =
                  typeof item["title"] === "string" ? item["title"] : "Réponse à votre publication";
                const created = z.number().positive().parse(item["created_utc"]);
                const inboxId = `shared-inbox:reddit:${this.account}:${id}`;
                if (
                  author !== "[deleted]" &&
                  body !== "[deleted]" &&
                  body !== "[removed]" &&
                  !readOwnerMessage(this.dataDir, inboxId)
                ) {
                  enqueueOwnerMessage(this.dataDir, {
                    id: inboxId,
                    at: new Date(created * 1000).toISOString(),
                    text: `Reddit · r/${sub} · u/${author}\n\n${title}\n\n${body}\n\n[Voir sur Reddit](${link.href})`,
                    origin: {
                      kind: "peer_message",
                      channel: "reddit",
                      author: `Reddit · u/${author}`,
                      senderRef: `reddit:u/${author}`,
                      recipientRef: `reddit:u/${this.account}`,
                      threadId: typeof item["link_id"] === "string" ? item["link_id"] : id,
                      messageId: id,
                      correlationId: inboxId,
                    },
                  });
                  imported++;
                }
                db.prepare("INSERT OR IGNORE INTO imported VALUES(?,?)").run(this.account, id);
              }
            }
            if (!this.allowed()) break;
            const more = !reached && page.after !== null;
            const updated: Cursor = {
              head: more ? cursor.head : (target ?? cursor.head),
              target: more ? target : null,
              after_id: more ? page.after : null,
            };
            if (more && updated.after_id === cursor.after_id)
              throw Error("Reddit cursor did not advance");
            db.prepare("UPDATE cursors SET head=?,target=?,after_id=? WHERE source=?").run(
              updated.head,
              updated.target,
              updated.after_id,
              key,
            );
            cursor = updated;
            if (!more) break;
          }
        } catch (error) {
          if (error instanceof RedditError && error.code === "rate_limited") throw error;
          errors.push(source);
        }
      }
      return { imported, errors };
    } catch (error) {
      if (error instanceof RedditError && error.retryAfterSeconds)
        this.next = Date.now() + Math.max(60, error.retryAfterSeconds) * 1000;
      throw error;
    } finally {
      if (acquired) db?.prepare("DELETE FROM lease WHERE id=1 AND owner=?").run(this.owner);
      db?.close();
      this.busy = false;
    }
  }
}
