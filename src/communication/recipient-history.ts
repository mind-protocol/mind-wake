import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface RecipientEntry {
  id: string;
  at: string;
  text: string;
  direction: "out" | "in";
  route: string;
  threadId: string | null;
  messageId: string | null;
  senderRef: string;
  recipientRef: string;
  state: "local_stored" | "remote_stored" | "received";
  inReplyTo?: string | null;
}
export function recipientDb(dataDir: string, readonly = false): Database.Database | null {
  const file = path.join(dataDir, "recipient-route.sqlite");
  if (!fs.existsSync(file) && readonly) return null;
  if (fs.existsSync(file)) {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1)
      throw new Error("Invalid recipient store");
  }
  const db = new Database(file, { readonly, fileMustExist: readonly });
  db.pragma("busy_timeout = 5000");
  if (!readonly)
    db.exec("CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY, json TEXT NOT NULL)");
  return db;
}
export function recipientEntries(dataDir: string): RecipientEntry[] {
  const db = recipientDb(dataDir, true);
  if (!db) return [];
  try {
    return (db.prepare("SELECT json FROM entries ORDER BY rowid").all() as { json: string }[]).map(
      (r) => JSON.parse(r.json) as RecipientEntry,
    );
  } finally {
    db.close();
  }
}
export function saveRecipientEntry(dataDir: string, entry: RecipientEntry): void {
  const db = recipientDb(dataDir)!;
  try {
    db.prepare(
      "INSERT INTO entries(id,json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
    ).run(entry.id, JSON.stringify(entry));
  } finally {
    db.close();
  }
}
/** Reserve a correlation key before network I/O, across concurrent desktop processes. */
export function reserveRecipientEntry(dataDir: string, entry: RecipientEntry): RecipientEntry {
  const db = recipientDb(dataDir)!;
  try {
    return db
      .transaction(() => {
        db.prepare("INSERT OR IGNORE INTO entries(id,json) VALUES (?,?)").run(
          entry.id,
          JSON.stringify(entry),
        );
        return JSON.parse(
          (db.prepare("SELECT json FROM entries WHERE id=?").get(entry.id) as { json: string })
            .json,
        ) as RecipientEntry;
      })
      .immediate();
  } finally {
    db.close();
  }
}
