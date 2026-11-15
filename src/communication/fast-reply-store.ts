/**
 * État de la réponse rapide, sans dépendance aux runtimes : interrupteur, réservation d'un
 * message et attente de livraison. Partagé par la boîte du principal et les workers des fils.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const FAST_REPLY_CONFIG = "fast-reply.json";
export const FAST_REPLY_DB = "fast-reply.sqlite";
/** Le message humain attend sa réponse rapide au plus ce délai avant d'être livré seul. */
export const FAST_REPLY_HOLD_MS = 45_000;

/** Fil d'une réponse rapide : principal, second fil Claude ou fork Codex 2 à 8. */
export type FastReplyThread = "principal" | "second" | `fork:${number}`;

export function fastReplyEnabled(dataDir: string): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, FAST_REPLY_CONFIG), "utf8")) as {
      enabled?: unknown;
    };
    return data.enabled === true;
  } catch {
    return false;
  }
}

export function saveFastReplyEnabled(dataDir: string, enabled: boolean): void {
  const file = path.join(dataDir, FAST_REPLY_CONFIG),
    tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ version: 1, enabled, updatedAt: new Date().toISOString() }) + "\n",
  );
  fs.renameSync(tmp, file);
}

export function forkThread(id: number): `fork:${number}` {
  return `fork:${String(id)}` as `fork:${number}`;
}

/** Identifiant d'un message de fil à boîte locale : `second:<entrée>` ou `fork:<n>:<entrée>`. */
export function storeThreadMessageId(
  thread: Exclude<FastReplyThread, "principal">,
  entryId: number,
) {
  return `${thread}:${String(entryId)}`;
}

/** Fil d'un message ; tout identifiant qui n'est pas d'un fil local est principal. */
export function fastReplyThreadOf(messageId: string): {
  thread: FastReplyThread;
  entryId: number | null;
} {
  const match = /^(second|fork:[2-8]):([1-9][0-9]{0,15})$/.exec(messageId);
  if (match === null) return { thread: "principal", entryId: null };
  return { thread: match[1] as FastReplyThread, entryId: Number(match[2]) };
}

/** Les sondes de latence et les bumps ciblés mesurent ou dirigent le fil principal. */
export function fastReplyApplies(messageId: string): boolean {
  return !/^(latency-|ui-bumpe-|steps:)/.test(messageId);
}

export interface FastReplyRecord {
  readonly messageId: string;
  readonly thread: FastReplyThread;
  readonly state: "pending" | "replied" | "silent" | "failed";
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly text: string | null;
  readonly ownerMessageId: string | null;
  readonly detail: string | null;
}
interface Row {
  message_id: string;
  thread: FastReplyThread;
  state: FastReplyRecord["state"];
  started_at: string;
  ended_at: string | null;
  text: string | null;
  owner_message_id: string | null;
  detail: string | null;
}
const record = (r: Row): FastReplyRecord => ({
  messageId: r.message_id,
  thread: r.thread,
  state: r.state,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  text: r.text,
  ownerMessageId: r.owner_message_id,
  detail: r.detail,
});

function open(dataDir: string, create: boolean): Database.Database | null {
  const file = path.join(dataDir, FAST_REPLY_DB);
  if (!create && !fs.existsSync(file)) return null;
  if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()))
    throw Error("Unsafe fast reply database");
  const db = new Database(file);
  db.pragma("busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS replies(message_id TEXT PRIMARY KEY, state TEXT NOT NULL,
    started_at TEXT NOT NULL, ended_at TEXT, text TEXT, owner_message_id TEXT, detail TEXT,
    injected INTEGER NOT NULL DEFAULT 0)`);
  const columns = db.prepare("PRAGMA table_info(replies)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "thread"))
    db.exec("ALTER TABLE replies ADD COLUMN thread TEXT NOT NULL DEFAULT 'principal'");
  return db;
}

function created(dataDir: string): Database.Database {
  const db = open(dataDir, true);
  if (db === null) throw Error("Fast reply database unavailable");
  return db;
}

/** Réserve le message une seule fois ; `false` si une réponse rapide existe déjà. */
export function beginFastReply(
  dataDir: string,
  messageId: string,
  now = new Date(),
  thread: FastReplyThread = fastReplyThreadOf(messageId).thread,
): boolean {
  const db = created(dataDir);
  try {
    return (
      db
        .prepare(
          "INSERT OR IGNORE INTO replies(message_id,thread,state,started_at) VALUES(?,?,'pending',?)",
        )
        .run(messageId, thread, now.toISOString()).changes === 1
    );
  } finally {
    db.close();
  }
}

export function finishFastReply(
  dataDir: string,
  messageId: string,
  result: {
    state: "replied" | "silent" | "failed";
    text?: string;
    ownerMessageId?: string;
    detail?: string;
  },
  now = new Date(),
): void {
  const db = created(dataDir);
  try {
    db.prepare(
      "UPDATE replies SET state=?, ended_at=?, text=?, owner_message_id=?, detail=?, injected=1 WHERE message_id=?",
    ).run(
      result.state,
      now.toISOString(),
      result.text ?? null,
      result.ownerMessageId ?? null,
      result.detail ?? null,
      messageId,
    );
  } finally {
    db.close();
  }
}

export function readFastReplies(dataDir: string, limit = 20): FastReplyRecord[] {
  const db = open(dataDir, false);
  if (db === null) return [];
  try {
    return (
      db.prepare("SELECT * FROM replies ORDER BY started_at DESC LIMIT ?").all(limit) as Row[]
    ).map(record);
  } finally {
    db.close();
  }
}

/** Battement du serveur permanent (`fast-reply-server.json`), lu sans dépendre de lui. */
function serverBeating(dataDir: string, now: number): boolean {
  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(dataDir, "fast-reply-server.json"), "utf8"),
    ) as { heartbeatAt?: unknown };
    return typeof state.heartbeatAt === "string" && now - Date.parse(state.heartbeatAt) <= 8_000;
  } catch {
    return false;
  }
}

/**
 * Règle commune à toutes les boîtes (principal Claude ou Codex, second fil, forks) : un
 * message humain récent dont la réponse rapide n'est pas terminée est retenu, au plus
 * `FAST_REPLY_HOLD_MS`, pour partir avec elle. Sans serveur vivant, rien n'est retenu
 * hors réponse déjà en cours.
 */
export function fastReplyHolds(
  dataDir: string,
  messages: readonly { readonly id: string; readonly at: string }[],
  now = Date.now(),
): boolean {
  if (!fastReplyEnabled(dataDir)) return false;
  const recent = messages.filter((m) => {
    const at = Date.parse(m.at);
    return fastReplyApplies(m.id) && now - at <= FAST_REPLY_HOLD_MS && at - now <= 5_000;
  });
  if (recent.length === 0) return false;
  const db = open(dataDir, false);
  const beating = serverBeating(dataDir, now);
  try {
    const state = db?.prepare("SELECT state FROM replies WHERE message_id=?");
    return recent.some((m) => {
      const row = state?.get(m.id) as { state: string } | undefined;
      return row === undefined ? beating : row.state === "pending";
    });
  } finally {
    db?.close();
  }
}

/**
 * Une réponse rapide encore en cours et récente sur ce fil : sa boîte retient alors la
 * livraison du message humain pour livrer les deux ensemble.
 */
export function fastReplyPending(
  dataDir: string,
  thread: FastReplyThread = "principal",
  now = Date.now(),
): boolean {
  const db = open(dataDir, false);
  if (db === null) return false;
  try {
    const since = new Date(now - FAST_REPLY_HOLD_MS).toISOString();
    return (
      db
        .prepare(
          "SELECT 1 FROM replies WHERE state='pending' AND thread=? AND started_at>=? LIMIT 1",
        )
        .get(thread, since) !== undefined
    );
  } finally {
    db.close();
  }
}
