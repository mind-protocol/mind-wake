import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { atomicLocalJson, readLocalJson } from "../daemon/workspace-config.js";
export const DUO_REMINDER =
  "MIND runtime / Mode Duo (not a human message): the agent's visual content has not changed for at least 30 seconds. Continue the visual conversation now: show useful content on screen, react to the player's current situation and teach a small reusable method when relevant. Do not invent observations or take game controls. A terminal/chat reply does not count as changed visual content.";
export function duoEnabled(dataDir: string): boolean {
  try {
    return (
      (readLocalJson(path.join(dataDir, "duo.json")) as { enabled?: unknown })?.enabled === true
    );
  } catch {
    return false;
  }
}
export function configureDuo(dataDir: string, enabled: boolean): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const changed = duoEnabled(dataDir) !== enabled;
  atomicLocalJson(path.join(dataDir, "duo.json"), { version: 1, enabled });
  if (changed) {
    const db = open(dataDir);
    try {
      db?.prepare("DELETE FROM duo").run();
    } finally {
      db?.close();
    }
  }
}
interface State {
  fingerprint: string;
  since: number;
  last_sent: number;
  eligible_until: number;
  claim: string | null;
  claimed_at: number | null;
  reminded: number;
}
function open(dataDir: string, create = false): Database.Database | null {
  const file = path.join(dataDir, "duo-runtime.sqlite");
  if (!create && !fs.existsSync(file)) return null;
  const db = new Database(file);
  db.pragma("busy_timeout = 1000");
  if (create)
    db.exec(
      "CREATE TABLE IF NOT EXISTS duo (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL, since REAL NOT NULL, last_sent REAL NOT NULL, eligible_until REAL NOT NULL, claim TEXT, claimed_at REAL)",
    );
  // Older live profiles predate the one-reminder-per-stall acknowledgement.
  const columns = db.prepare("PRAGMA table_info(duo)").all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === "reminded"))
    db.exec("ALTER TABLE duo ADD COLUMN reminded INTEGER NOT NULL DEFAULT 0");
  return db;
}
/** Daemon-owned monitor; no screenshots, no model sessions, no historical human messages. */
export class DuoMonitor {
  private timer: NodeJS.Timeout | undefined;
  private readonly db: Database.Database;
  constructor(
    private readonly dataDir: string,
    private readonly contentFile: string,
    private readonly allowed: () => boolean,
    private readonly now = Date.now,
  ) {
    this.db = open(dataDir, true)!;
    this.db.prepare("UPDATE duo SET eligible_until=0,claim=NULL,claimed_at=NULL").run();
  }
  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }
  tick(): void {
    const now = this.now();
    try {
      if (!duoEnabled(this.dataDir) || !this.allowed()) {
        this.db.prepare("DELETE FROM duo").run();
        return;
      }
      // Host-published marker records displayed semantic text/marks, not a file rewrite or desktop pixels.
      let fingerprint: string | null = null;
      try {
        const c = readLocalJson(this.contentFile) as { fingerprint?: unknown };
        if (typeof c.fingerprint === "string" && /^[a-f0-9]{64}$/i.test(c.fingerprint))
          fingerprint = c.fingerprint;
      } catch {
        /* No visual publication yet. */
      }
      this.db
        .transaction(() => {
          const row = this.db.prepare("SELECT * FROM duo WHERE id=1").get() as State | undefined;
          fingerprint ??= row?.fingerprint ?? "none";
          if (!row || row.fingerprint !== fingerprint)
            this.db
              .prepare("INSERT OR REPLACE INTO duo (id,fingerprint,since,last_sent,eligible_until,claim,claimed_at,reminded) VALUES(1,?,?,?, ?,NULL,NULL,0)")
              .run(fingerprint, now, now, now + 2000);
          else this.db.prepare("UPDATE duo SET eligible_until=? WHERE id=1").run(now + 2000);
        })
        .immediate();
    } catch {
      try {
        this.db.prepare("UPDATE duo SET eligible_until=0").run();
      } catch {}
    }
  }
  close(): void {
    clearInterval(this.timer);
    this.db.prepare("UPDATE duo SET eligible_until=0").run();
    this.db.close();
  }
}
export function claimDuoReminder(dataDir: string, claim: string, now = Date.now()): string | null {
  if (!duoEnabled(dataDir)) return null;
  const db = open(dataDir);
  if (!db) return null;
  try {
    return db
      .transaction(() => {
        const row = db.prepare("SELECT * FROM duo WHERE id=1").get() as State | undefined;
        if (
          !row ||
          row.reminded === 1 ||
          row.eligible_until < now ||
          now - row.since < 30_000 ||
          now - row.last_sent < 30_000 ||
          (row.claim !== null && now - (row.claimed_at ?? now) < 30_000)
        )
          return null;
        // Throttle attempts too: an ambiguous/failed RPC must not cause a burst from another consumer.
        db.prepare("UPDATE duo SET claim=?,claimed_at=?,last_sent=? WHERE id=1").run(claim, now, now);
        return DUO_REMINDER;
      })
      .immediate();
  } finally {
    db.close();
  }
}
export function finishDuoReminder(
  dataDir: string,
  claim: string,
  accepted: boolean,
  now = Date.now(),
): void {
  const db = open(dataDir);
  if (!db) return;
  try {
    db.prepare(
      "UPDATE duo SET last_sent=CASE WHEN ? THEN ? ELSE last_sent END,reminded=CASE WHEN ? THEN 1 ELSE reminded END,claim=NULL,claimed_at=NULL WHERE claim=?",
    ).run(accepted ? 1 : 0, now, accepted ? 1 : 0, claim);
  } finally {
    db.close();
  }
}
