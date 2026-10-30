/** Local agent→owner messages. Human replies remain in their separate, immutable log. */
import { saveFilAfterSubmit } from "./fil-continuity.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

export const OWNER_MESSAGES_DB = "owner-messages.sqlite";
export interface OwnerMessage {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}
interface Row {
  id: string;
  text: string;
  created_at: string;
  updated_at: string;
  version: number;
  deleted: number;
  agent_id: string;
}
export class OwnerMessageError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "permission_denied",
    message: string,
  ) {
    super(message);
  }
}
const project = (r: Row): OwnerMessage => ({
  id: r.id,
  text: r.text,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
});
function filename(dataDir: string): string {
  const file = path.join(dataDir, OWNER_MESSAGES_DB);
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new OwnerMessageError("permission_denied", "Invalid local message store.");
  }
  return file;
}
export function readOwnerMessages(dataDir: string): OwnerMessage[] | null {
  const file = filename(dataDir);
  if (!fs.existsSync(file)) return null; // null = legacy note channel, [] = deliberately empty managed channel
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (!db.prepare("SELECT 1 FROM channel_state WHERE active=1").get()) return null;
    return (
      db.prepare("SELECT * FROM messages WHERE deleted=0 ORDER BY created_at, rowid").all() as Row[]
    ).map(project);
  } finally {
    db.close();
  }
}
export class OwnerMessages {
  readonly #db: Database.Database;
  constructor(
    readonly dataDir: string,
    readonly agentId: string,
  ) {
    this.#db = new Database(filename(dataDir));
    this.#db.pragma("busy_timeout = 5000");
    this.#db.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, text TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0, request_key TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS channel_state (active INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS edits (
      message_id TEXT NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL,
      at TEXT NOT NULL, deleted INTEGER NOT NULL, PRIMARY KEY(message_id,version)
    );`);
  }
  close(): void {
    this.#db.close();
  }
  adoptLegacy(text: string, version: number, at: string): void {
    this.#db
      .prepare(
        `INSERT INTO messages VALUES('legacy-note',?,?,?,?,?,0,'legacy-note')
        ON CONFLICT(id) DO UPDATE SET agent_id=excluded.agent_id,text=excluded.text,created_at=excluded.created_at,updated_at=excluded.updated_at,version=excluded.version
        WHERE NOT EXISTS (SELECT 1 FROM channel_state WHERE active=1)`,
      )
      .run(this.agentId, text, at, at, version);
    this.#db
      .prepare("INSERT OR IGNORE INTO edits VALUES(?,?,?,?,0)")
      .run("legacy-note", version, text, at);
  }
  list(): OwnerMessage[] {
    return (
      this.#db
        .prepare("SELECT * FROM messages WHERE agent_id=? AND deleted=0 ORDER BY created_at,rowid")
        .all(this.agentId) as Row[]
    ).map(project);
  }
  publish(text: string, requestKey: string, createdAt?: string): OwnerMessage {
    const result = this.#db
      .transaction(() => {
        const existing = this.#db
          .prepare("SELECT * FROM messages WHERE request_key=?")
          .get(requestKey) as Row | undefined;
        if (existing !== undefined) {
          if (existing.agent_id !== this.agentId || existing.text !== text || existing.deleted)
            throw new OwnerMessageError("conflict", "This request key was already used.");
          return project(existing);
        }
        const at =
            createdAt === undefined ? new Date().toISOString() : new Date(createdAt).toISOString(),
          id = `own_${randomUUID()}`;
        this.#db
          .prepare(
            "INSERT INTO messages(id,agent_id,text,created_at,updated_at,version,request_key) VALUES(?,?,?,?,?,1,?)",
          )
          .run(id, this.agentId, text, at, at, requestKey);
        this.#db.prepare("INSERT INTO edits VALUES(?,1,?,?,0)").run(id, text, at);
        this.#db.prepare("INSERT OR IGNORE INTO channel_state VALUES(1)").run();
        return { id, text, createdAt: at, updatedAt: at, version: 1 };
      })
      .immediate();
    saveFilAfterSubmit(this.dataDir);
    return result;
  }
  change(
    id: string,
    expectedVersion: number,
    text: string | null,
  ): OwnerMessage & { deleted: boolean } {
    const result = this.#db
      .transaction(() => {
        const row = this.#db
          .prepare("SELECT * FROM messages WHERE id=? AND agent_id=?")
          .get(id, this.agentId) as Row | undefined;
        if (!row)
          throw new OwnerMessageError("not_found", "No message owned by this agent has that ID.");
        if (row.deleted && text === null) return { ...project(row), deleted: true };
        if (row.deleted) throw new OwnerMessageError("not_found", "This message was deleted.");
        if (row.version !== expectedVersion)
          throw new OwnerMessageError(
            "conflict",
            "Message changed: list messages and retry with the current version.",
          );
        const at = new Date().toISOString(),
          version = row.version + 1;
        this.#db
          .prepare("UPDATE messages SET text=?,updated_at=?,version=?,deleted=? WHERE id=?")
          .run(text ?? row.text, at, version, text === null ? 1 : 0, id);
        this.#db
          .prepare("INSERT INTO edits VALUES(?,?,?,?,?)")
          .run(id, version, text ?? row.text, at, text === null ? 1 : 0);
        this.#db.prepare("INSERT OR IGNORE INTO channel_state VALUES(1)").run();
        return {
          id,
          text: text ?? row.text,
          createdAt: row.created_at,
          updatedAt: at,
          version,
          deleted: text === null,
        };
      })
      .immediate();
    saveFilAfterSubmit(this.dataDir);
    return result;
  }
}
