/** Private runtime notices, separate from human messages and conversation history. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { latestOwnerPublication } from "./owner-messages.js";

const FILE = "owner-progress-reminder.sqlite";
export const PROGRESS_REMINDER = "MIND runtime reminder (not a message from your human): your human is potentially following the MIND app and has received no news for at least 60 seconds. Send a brief message through the authorized owner channel: what you are exploring, a finding, or what is taking time. Do not invent progress. Publishing a real message resets this reminder; terminal output and tool activity do not.";
interface State {
  publication_at: number | null;
  silence_since: number;
  notice_id: string | null;
  state: "pending" | "claimed" | "delivered" | null;
  claim: string | null;
  session: string | null;
  eligible_until: number;
}
export interface ProgressReminderStatus { readonly state: "pending" | "delivered"; }

/** UI projection only: never creates a store, reserves a notice or exposes its contents. */
export function readProgressReminderStatus(dataDir: string, now = Date.now()): ProgressReminderStatus | null {
  const file = path.join(dataDir, FILE);
  let db: Database.Database | undefined;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null;
    db = new Database(file, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT * FROM reminder WHERE id=1").get() as State | undefined;
    if (!row?.state || row.eligible_until < now || latestOwnerPublication(dataDir) !== row.publication_at) return null;
    return { state: row.state === "delivered" ? "delivered" : "pending" };
  } catch { return null; }
  finally { db?.close(); }
}
function open(dataDir: string, create = false): Database.Database | null {
  const file = path.join(dataDir, FILE);
  if (!fs.existsSync(file) && !create) return null;
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error("Invalid reminder store");
  }
  const db = new Database(file);
  db.pragma("busy_timeout = 1000");
  if (create) db.exec(`CREATE TABLE IF NOT EXISTS reminder (
    id INTEGER PRIMARY KEY CHECK(id=1), publication_at REAL, silence_since REAL NOT NULL,
    notice_id TEXT, state TEXT, claim TEXT, session TEXT, eligible_until REAL NOT NULL
  )`);
  return db;
}

export class OwnerProgressReminder {
  readonly #db: Database.Database;
  #timer: NodeJS.Timeout | undefined;
  constructor(private readonly dataDir: string, private readonly eligible: () => boolean,
    private readonly now: () => number = Date.now) {
    this.#db = open(dataDir, true)!;
    // Reservations belong to the previous runtime, not to a newly started daemon.
    this.#db.prepare("UPDATE reminder SET state='pending',claim=NULL,session=NULL,eligible_until=0 WHERE state='claimed'").run();
  }
  start(): void {
    this.tick();
    this.#timer = setInterval(() => this.tick(), 1000);
    this.#timer.unref();
  }
  tick(): void {
    try {
      const now = this.now();
      const eligible = this.eligible();
      const publication = latestOwnerPublication(this.dataDir);
      this.#db.transaction(() => {
        let row = this.#db.prepare("SELECT * FROM reminder WHERE id=1").get() as State | undefined;
        if (publication === undefined || !eligible) {
          this.#db.prepare("UPDATE reminder SET eligible_until=0").run();
          return;
        }
        if (!row || row.publication_at !== publication) {
          this.#db.prepare(`INSERT OR REPLACE INTO reminder VALUES(1,?,?,NULL,NULL,NULL,NULL,0)`)
            .run(publication, publication ?? now);
          row = this.#db.prepare("SELECT * FROM reminder WHERE id=1").get() as State;
        }
        if (now - row.silence_since < 60_000) return;
        if (row.state === null) {
          this.#db.prepare("UPDATE reminder SET notice_id=?,state='pending' WHERE id=1").run(randomUUID());
        }
        this.#db.prepare("UPDATE reminder SET eligible_until=? WHERE id=1").run(now + 2000);
      }).immediate();
    } catch {
      // A failed observation/store read must never invent attention or stop the daemon.
      try { this.#db.prepare("UPDATE reminder SET eligible_until=0").run(); } catch { /* Retry next tick. */ }
    }
  }
  close(): void {
    clearInterval(this.#timer);
    try { this.#db.prepare("UPDATE reminder SET eligible_until=0").run(); }
    finally { this.#db.close(); }
  }
}

export function claimProgressReminder(dataDir: string, session: string, claim: string, now = Date.now()): string | null {
  const db = open(dataDir);
  if (!db) return null;
  try {
    return db.transaction(() => {
      const row = db.prepare("SELECT * FROM reminder WHERE id=1 AND state='pending' AND eligible_until>=?").get(now) as State | undefined;
      // A publication may have arrived since the monitor's last tick.
      if (!row || latestOwnerPublication(dataDir) !== row.publication_at) return null;
      db.prepare("UPDATE reminder SET state='claimed',session=?,claim=? WHERE id=1").run(session, claim);
      return PROGRESS_REMINDER;
    }).immediate();
  } finally { db.close(); }
}
export function finishProgressReminder(dataDir: string, session: string, claim: string, accepted: boolean): void {
  const db = open(dataDir);
  if (!db) return;
  try {
    db.prepare("UPDATE reminder SET state=?,session=NULL,claim=NULL WHERE session=? AND claim=? AND state='claimed'")
      .run(accepted ? "delivered" : "pending", session, claim);
  } finally { db.close(); }
}
