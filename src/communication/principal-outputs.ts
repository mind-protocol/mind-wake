/** Final replies for pattern holders, separate from tool traces and owner notifications. */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const FILE = "principal-outputs.sqlite";
export interface PrincipalOutput { id: string; at: string; text: string }

export function recordPrincipalOutput(dataDir: string, output: PrincipalOutput): void {
  if (!output.text.trim()) return;
  const db = new Database(path.join(dataDir, FILE));
  try {
    db.pragma("busy_timeout = 5000");
    db.exec("CREATE TABLE IF NOT EXISTS outputs(id TEXT PRIMARY KEY, at TEXT NOT NULL, text TEXT NOT NULL)");
    db.prepare("INSERT OR IGNORE INTO outputs(id, at, text) VALUES (?, ?, ?)").run(output.id, output.at, output.text);
  } finally { db.close(); }
}

export function readPrincipalOutputs(dataDir: string, limit: number): PrincipalOutput[] {
  const file = path.join(dataDir, FILE);
  if (!fs.existsSync(file)) return [];
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT id, at, text FROM outputs ORDER BY at DESC, id DESC LIMIT ?").all(limit) as PrincipalOutput[];
  } finally { db.close(); }
}
