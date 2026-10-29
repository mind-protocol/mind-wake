/**
 * Base SQLite du service de séances SIMULÉ. Fichier distinct de la base de contrôle de
 * Wake : ce ledger fictif n'a aucun lien avec le ledger de ressources (tokens, sessions)
 * de `src/ledger`.
 */

import Database from "better-sqlite3";

export type AdviceDatabase = Database.Database;

export const ADVICE_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS controls (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  frozen INTEGER NOT NULL CHECK (frozen IN (0, 1)),
  reason TEXT,
  changed_by TEXT,
  changed_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS pools (
  pool_id TEXT PRIMARY KEY,
  payer_principal_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS mandates (
  mandate_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  digest TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (mandate_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS mandate_usage (
  mandate_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  period_index INTEGER NOT NULL,
  committed TEXT NOT NULL,
  PRIMARY KEY (mandate_id, version, period_index)
) STRICT;

CREATE TABLE IF NOT EXISTS contracts (
  contract_id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  digest TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  guide_principal_id TEXT NOT NULL,
  state TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  close_reason TEXT,
  closed_at TEXT,
  last_activity_at TEXT NOT NULL,
  earned_exchanges INTEGER,
  principal_due TEXT,
  reservation_period INTEGER
) STRICT;

-- Une seule rencontre réservée ou active par agent et par guide (TRANSACTIONS §13).
CREATE UNIQUE INDEX IF NOT EXISTS contracts_one_live_per_agent
  ON contracts (agent_id) WHERE state IN ('reserved', 'active');
CREATE UNIQUE INDEX IF NOT EXISTS contracts_one_live_per_guide
  ON contracts (guide_principal_id) WHERE state IN ('reserved', 'active');

CREATE TABLE IF NOT EXISTS exchanges (
  contract_id TEXT NOT NULL REFERENCES contracts (contract_id),
  exchange_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  state TEXT NOT NULL,
  agent_point_ref TEXT NOT NULL,
  human_message_ref TEXT,
  human_principal_id TEXT,
  agent_reply_ref TEXT,
  checkpoint_ref TEXT,
  opened_at TEXT NOT NULL,
  earned_at TEXT,
  void_reason TEXT,
  PRIMARY KEY (contract_id, exchange_id),
  UNIQUE (contract_id, seq)
) STRICT;

-- Une seule acquisition (unité payable) par échange (TRANSACTIONS §11).
CREATE TABLE IF NOT EXISTS acquisitions (
  contract_id TEXT NOT NULL,
  exchange_id TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (contract_id, exchange_id)
) STRICT;

CREATE TABLE IF NOT EXISTS inbox (
  producer TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  outcome TEXT NOT NULL,
  received_at TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE,
  PRIMARY KEY (producer, event_id)
) STRICT;

CREATE TABLE IF NOT EXISTS reservations (
  contract_id TEXT PRIMARY KEY REFERENCES contracts (contract_id),
  pool_id TEXT NOT NULL,
  amount TEXT NOT NULL,
  released TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- Ledger fictif append-only, en partie double : chaque écriture est équilibrée.
CREATE TABLE IF NOT EXISTS ledger_entries (
  entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
  op_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  contract_id TEXT,
  at TEXT NOT NULL,
  simulated INTEGER NOT NULL CHECK (simulated = 1)
) STRICT;

CREATE TABLE IF NOT EXISTS ledger_lines (
  entry_id INTEGER NOT NULL REFERENCES ledger_entries (entry_id),
  account TEXT NOT NULL,
  amount TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ledger_lines_account ON ledger_lines (account);

CREATE TABLE IF NOT EXISTS settlement_intents (
  settlement_id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts (contract_id),
  settlement_kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  frozen_reason TEXT,
  external_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (contract_id, settlement_kind)
) STRICT;

CREATE TABLE IF NOT EXISTS transfer_attempts (
  attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  settlement_id TEXT NOT NULL REFERENCES settlement_intents (settlement_id),
  fencing_token INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS outbox (
  outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  lease_owner TEXT,
  lease_until INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  done_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS receipts (
  contract_id TEXT PRIMARY KEY REFERENCES contracts (contract_id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  contract_id TEXT,
  kind TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  reason TEXT NOT NULL,
  metadata TEXT NOT NULL,
  simulated INTEGER NOT NULL CHECK (simulated = 1)
) STRICT;

CREATE TRIGGER IF NOT EXISTS journal_append_only BEFORE UPDATE ON journal
BEGIN SELECT RAISE(ABORT, 'journal append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_entries_append_only BEFORE UPDATE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_entries_no_delete BEFORE DELETE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_lines_append_only BEFORE UPDATE ON ledger_lines
BEGIN SELECT RAISE(ABORT, 'ledger append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_lines_no_delete BEFORE DELETE ON ledger_lines
BEGIN SELECT RAISE(ABORT, 'ledger append-only'); END;
`;

export interface OpenAdviceOptions {
  readonly busyTimeoutMs?: number;
}

export function openSqlite(path: string, busyTimeoutMs = 10_000): AdviceDatabase {
  const db = new Database(path, { timeout: busyTimeoutMs });
  db.pragma(`busy_timeout = ${String(busyTimeoutMs)}`);
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function openAdviceDatabase(path: string, options: OpenAdviceOptions = {}): AdviceDatabase {
  const db = openSqlite(path, options.busyTimeoutMs);
  try {
    db.transaction(() => {
      db.exec(SCHEMA);
      db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(
        String(ADVICE_SCHEMA_VERSION),
      );
      db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('simulated', 'true')").run();
      db.prepare("INSERT OR IGNORE INTO controls (id, frozen) VALUES (1, 0)").run();
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** Transaction d'écriture immédiate : le verrou est pris avant toute lecture. */
export function immediate<T>(db: AdviceDatabase, fn: () => T): T {
  return db.transaction(fn).immediate();
}
