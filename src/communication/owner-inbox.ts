/** Durable delivery queue, separate from the human conversation history. */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { WakeImage } from "../contracts/wake-image.js";
import { freshWakeImage } from "../adapters/wake-image.js";

export interface InboxMessage {
  id: string;
  at: string;
  text: string;
  image?: WakeImage;
  /** Host envelope, never decoded from message text. Copies are context, not orders. */
  origin?: {
    kind: "context_copy" | "peer_message";
    channel: string;
    author: string;
    senderRef: string;
    recipientRef: string;
    threadId: string;
    messageId: string;
    correlationId: string;
  };
}
const FILE = "owner-inbox.sqlite";
/** Read-only conversation projection; attachment bytes and delivery claims stay private. */
export function readOwnerInboxHistory(dataDir: string): InboxMessage[] {
  const file = path.join(dataDir, FILE);
  if (!fs.existsSync(file)) return [];
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("Invalid inbox store");
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT id,at,text FROM inbox ORDER BY rowid").all() as InboxMessage[];
  } finally {
    db.close();
  }
}
/** Hook delivery receipts; delivery does not attest that the model read or understood. */
export function readOwnerReceipts(dataDir: string): Record<string, string> {
  const file = path.join(dataDir, FILE);
  if (!fs.existsSync(file)) return {};
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("Invalid inbox store");
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return Object.fromEntries(
      (
        db
          .prepare(
            "SELECT id, emitted_at FROM inbox WHERE emitted_session IS NOT NULL AND emitted_at IS NOT NULL",
          )
          .all() as { id: string; emitted_at: string }[]
      ).map((r) => [r.id, r.emitted_at]),
    );
  } finally {
    db.close();
  }
}
function open(dataDir: string): Database.Database {
  const file = path.join(dataDir, FILE);
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("Invalid inbox store");
  }
  const db = new Database(file);
  db.pragma("busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS inbox (
    id TEXT PRIMARY KEY, at TEXT NOT NULL, text TEXT NOT NULL,
    emitted_session TEXT, emitted_at TEXT
  )`);
  const columns = new Set(
    (db.prepare("PRAGMA table_info(inbox)").all() as { name: string }[]).map((c) => c.name),
  );
  for (const column of ["claimed_session", "claim_id", "image_json", "origin_json"])
    if (!columns.has(column)) {
      try {
        db.exec(`ALTER TABLE inbox ADD COLUMN ${column} TEXT`);
      } catch (error) {
        if (
          !(db.prepare("PRAGMA table_info(inbox)").all() as { name: string }[]).some(
            (c) => c.name === column,
          )
        )
          throw error;
      }
    }
  return db;
}
export function enqueueOwnerMessage(dataDir: string, message: InboxMessage): void {
  if (
    message.image !== undefined &&
    freshWakeImage(message.image, Date.parse(message.image.capturedAt)) === null
  )
    throw new Error("Invalid owner image attachment");
  const db = open(dataDir);
  try {
    db.prepare(
      "INSERT OR IGNORE INTO inbox(id, at, text, image_json, origin_json) VALUES (?, ?, ?, ?, ?)",
    ).run(
      message.id,
      message.at,
      message.text,
      message.image === undefined ? null : JSON.stringify(message.image),
      message.origin === undefined ? null : JSON.stringify(message.origin),
    );
  } finally {
    db.close();
  }
}
/** Recover an acknowledged-or-queued send after a crash between inbox and history writes. */
export function readOwnerMessage(dataDir: string, id: string): InboxMessage | null {
  if (!fs.existsSync(path.join(dataDir, FILE))) return null;
  const db = open(dataDir);
  try {
    const row = db
      .prepare("SELECT id,at,text,image_json,origin_json FROM inbox WHERE id=?")
      .get(id) as
      (InboxMessage & { image_json: string | null; origin_json: string | null }) | undefined;
    if (row === undefined) return null;
    const { image_json, origin_json, ...message } = row;
    return {
      ...message,
      ...(origin_json === null
        ? {}
        : { origin: JSON.parse(origin_json) as NonNullable<InboxMessage["origin"]> }),
      ...(image_json === null ? {} : { image: JSON.parse(image_json) as WakeImage }),
    };
  } finally {
    db.close();
  }
}
export function ownerMessagePending(dataDir: string): boolean {
  if (!fs.existsSync(path.join(dataDir, FILE))) return false;
  const db = open(dataDir);
  try {
    return (
      db.prepare("SELECT 1 FROM inbox WHERE emitted_session IS NULL LIMIT 1").get() !== undefined
    );
  } finally {
    db.close();
  }
}

/** Reserve a stream delivery; the hook cannot consume it and no receipt is exposed yet. */
export function claimOwnerMessages(
  dataDir: string,
  session: string,
  claim: string,
): InboxMessage[] {
  if (!fs.existsSync(path.join(dataDir, FILE))) return [];
  const db = open(dataDir);
  try {
    return db
      .transaction(() => {
        const messages = db
          .prepare(
            "SELECT id,at,text,image_json,origin_json FROM inbox WHERE emitted_session IS NULL AND claim_id IS NULL ORDER BY rowid LIMIT 16",
          )
          .all() as (InboxMessage & { image_json: string | null; origin_json: string | null })[];
        const mark = db.prepare("UPDATE inbox SET claimed_session=?,claim_id=? WHERE id=?");
        for (const message of messages) mark.run(session, claim, message.id);
        return messages.map(({ image_json, origin_json, ...message }) => ({
          ...message,
          ...(origin_json === null
            ? {}
            : { origin: JSON.parse(origin_json) as NonNullable<InboxMessage["origin"]> }),
          ...(image_json === null ? {} : { image: JSON.parse(image_json) as WakeImage }),
        }));
      })
      .immediate();
  } finally {
    db.close();
  }
}
export function confirmOwnerClaim(dataDir: string, session: string, claim: string): void {
  const db = open(dataDir);
  try {
    db.prepare(
      "UPDATE inbox SET emitted_session=?,emitted_at=?,claimed_session=NULL,claim_id=NULL,image_json=NULL WHERE claimed_session=? AND claim_id=? AND emitted_session IS NULL",
    ).run(session, new Date().toISOString(), session, claim);
  } finally {
    db.close();
  }
}
/** Process death or failed write releases unsent reservations, retaining their original IDs. */
export function releaseOwnerClaims(dataDir: string, session?: string): void {
  if (!fs.existsSync(path.join(dataDir, FILE))) return;
  const db = open(dataDir);
  try {
    if (session === undefined)
      db.prepare(
        "UPDATE inbox SET claimed_session=NULL,claim_id=NULL WHERE emitted_session IS NULL",
      ).run();
    else
      db.prepare(
        "UPDATE inbox SET claimed_session=NULL,claim_id=NULL WHERE emitted_session IS NULL AND claimed_session=?",
      ).run(session);
  } finally {
    db.close();
  }
}
/** One synchronous transaction also serializes simultaneous PostToolUse hooks. */
export function restoreOwnerMessages(
  dataDir: string,
  session: string,
  ids: readonly string[],
): void {
  if (!ids.length) return;
  const db = open(dataDir);
  try {
    db.transaction(() => {
      const restore = db.prepare(
        "UPDATE inbox SET emitted_session=NULL, emitted_at=NULL WHERE id=? AND emitted_session=?",
      );
      for (const id of ids) restore.run(id, session);
    }).immediate();
  } finally {
    db.close();
  }
}

export function takeOwnerMessages(dataDir: string, session: string): InboxMessage[] {
  if (!fs.existsSync(path.join(dataDir, FILE))) return [];
  const db = open(dataDir);
  try {
    return db
      .transaction(() => {
        const rows = db
          .prepare(
            "SELECT id, at, text, origin_json FROM inbox WHERE emitted_session IS NULL AND claim_id IS NULL AND image_json IS NULL ORDER BY rowid",
          )
          .all() as (InboxMessage & { origin_json: string | null })[];
        const mark = db.prepare("UPDATE inbox SET emitted_session=?, emitted_at=? WHERE id=?");
        for (const row of rows) mark.run(session, new Date().toISOString(), row.id);
        return rows.map(({ origin_json, ...message }) => ({
          ...message,
          ...(origin_json === null
            ? {}
            : { origin: JSON.parse(origin_json) as NonNullable<InboxMessage["origin"]> }),
        }));
      })
      .immediate();
  } finally {
    db.close();
  }
}
