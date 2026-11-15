import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export class ReportError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export function validateReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(k => !['id', 'messageId', 'version', 'text', 'reason', 'comment'].includes(k))
    || typeof input.id !== 'string' || !/^report-[a-f0-9-]{36}$/.test(input.id)
    || typeof input.messageId !== 'string' || !input.messageId || input.messageId.length > 256
    || !Number.isInteger(input.version) || input.version < 1
    || typeof input.text !== 'string' || !input.text || input.text.length > 12000
    || !['offensive', 'dangerous', 'privacy', 'other'].includes(input.reason)
    || typeof input.comment !== 'string' || input.comment.length > 1000)
    throw new ReportError('invalid_report');
  // Stable ordering, regardless of JSON field order. Never persist arbitrary fields.
  return { id: input.id, messageId: input.messageId, version: input.version,
    text: input.text, reason: input.reason, comment: input.comment };
}

/** Dedicated local inbox. No model dispatch, mail, tokens, history or identity fields. */
export function createChatReportStore(filename, now = Date.now) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename, { timeout: 5000 });
  fs.chmodSync(filename, 0o600);
  db.exec(`PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS chat_reports (
      id TEXT PRIMARY KEY, payload TEXT NOT NULL, received_at TEXT NOT NULL
    ) STRICT;`);
  function existing(input) {
    const row = db.prepare('SELECT payload, received_at FROM chat_reports WHERE id=?').get(input.id);
    if (!row) return null;
    if (row.payload !== JSON.stringify(input)) throw new ReportError('report_conflict', 409);
    return receipt(input.id, row.received_at, true);
  }
  function receipt(id, at, duplicate) {
    return { schema: 'mind.chat.report.receipt.v1', id, at, duplicate,
      status: 'stored_local', destination: 'paired_wake_local_inbox' };
  }
  return {
    existing,
    record(input) {
      db.exec('BEGIN IMMEDIATE');
      try {
        let result = existing(input);
        if (!result) {
          if (db.prepare('SELECT count(*) AS n FROM chat_reports').get().n >= 1000)
            throw new ReportError('report_limit', 429);
          const at = new Date(now()).toISOString();
          db.prepare('INSERT INTO chat_reports VALUES(?,?,?)').run(input.id, JSON.stringify(input), at);
          result = receipt(input.id, at, false);
        }
        db.exec('COMMIT');
        return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); },
  };
}
