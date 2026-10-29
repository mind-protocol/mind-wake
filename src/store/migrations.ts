/**
 * Migrations versionnées. Une migration appliquée n'est jamais modifiée : toute
 * évolution du schéma ajoute une nouvelle entrée. Le SQL est figé ici plutôt que
 * dérivé des constantes de `src/contracts/`, pour qu'un changement de contrat ne
 * réécrive pas silencieusement une migration déjà appliquée.
 *
 * Aucune colonne ne reçoit de secret (AGENTS §5) : la policy ne contient qu'un mode
 * d'authentification, jamais un identifiant.
 */

import type { SqliteDatabase } from "./database.js";
import { StoreError } from "./errors.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const INITIAL_SCHEMA = `
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('disabled', 'ready', 'running', 'checkpointing', 'hibernating', 'paused', 'blocked', 'stopped')),
  active_policy_revision_id TEXT REFERENCES policy_revisions (id),
  next_wake_at TEXT,
  emergency_stop_locked INTEGER NOT NULL CHECK (emergency_stop_locked IN (0, 1)),
  state_reason TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- Révisions de policy : ajout seul, chaîne linéaire par profil.
CREATE TABLE policy_revisions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles (id),
  previous_revision_id TEXT UNIQUE REFERENCES policy_revisions (id),
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  groups_json TEXT NOT NULL CHECK (json_valid(groups_json))
) STRICT;
CREATE UNIQUE INDEX policy_revisions_one_root ON policy_revisions (profile_id)
  WHERE previous_revision_id IS NULL;
CREATE TRIGGER policy_revisions_no_update BEFORE UPDATE ON policy_revisions
BEGIN SELECT RAISE(ABORT, 'policy_revisions est en ajout seul'); END;
CREATE TRIGGER policy_revisions_no_delete BEFORE DELETE ON policy_revisions
BEGIN SELECT RAISE(ABORT, 'policy_revisions est en ajout seul'); END;

CREATE TABLE policy_consents (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL UNIQUE REFERENCES policy_revisions (id),
  granted_at TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'local_cli'),
  proof TEXT NOT NULL
) STRICT;
CREATE TRIGGER policy_consents_no_update BEFORE UPDATE ON policy_consents
BEGIN SELECT RAISE(ABORT, 'policy_consents est en ajout seul'); END;
CREATE TRIGGER policy_consents_no_delete BEFORE DELETE ON policy_consents
BEGIN SELECT RAISE(ABORT, 'policy_consents est en ajout seul'); END;

CREATE TABLE permission_revocations (
  seq INTEGER PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES policy_revisions (id),
  revoked_at TEXT NOT NULL,
  reason TEXT NOT NULL
) STRICT;
CREATE INDEX permission_revocations_by_revision ON permission_revocations (revision_id);
CREATE TRIGGER permission_revocations_no_update BEFORE UPDATE ON permission_revocations
BEGIN SELECT RAISE(ABORT, 'permission_revocations est en ajout seul'); END;
CREATE TRIGGER permission_revocations_no_delete BEFORE DELETE ON permission_revocations
BEGIN SELECT RAISE(ABORT, 'permission_revocations est en ajout seul'); END;

CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles (id),
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'concluded', 'abandoned', 'archived')),
  status_reason TEXT NOT NULL,
  current_checkpoint_id TEXT REFERENCES checkpoints (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX experiments_one_active ON experiments (profile_id) WHERE status = 'active';

-- Colonne \`qualifier\` des tables du ledger : devise pour \`money\`, clé de fenêtre pour
-- \`provider_quota_bp\`, vide sinon. Deux qualifiants différents ne s'additionnent jamais.

-- Périodes de budget : bornes calculées dans le fuseau, persistées en UTC.
CREATE TABLE budget_periods (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles (id),
  kind TEXT NOT NULL CHECK (kind IN ('day', 'week', 'month')),
  time_zone TEXT NOT NULL,
  week_starts_on INTEGER NOT NULL CHECK (
    (kind = 'week' AND week_starts_on BETWEEN 0 AND 6) OR (kind <> 'week' AND week_starts_on = -1)),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL CHECK (ends_at > starts_at),
  UNIQUE (profile_id, kind, time_zone, week_starts_on, starts_at)
) STRICT;

CREATE TABLE period_limits (
  period_id TEXT NOT NULL REFERENCES budget_periods (id),
  unit TEXT NOT NULL CHECK (unit IN ('tokens', 'sessions', 'duration_ms', 'money', 'provider_quota_bp')),
  qualifier TEXT NOT NULL CHECK ((unit IN ('money', 'provider_quota_bp')) = (qualifier <> '')),
  cap INTEGER NOT NULL CHECK (cap >= 0),
  user_reserve INTEGER NOT NULL CHECK (user_reserve >= 0),
  PRIMARY KEY (period_id, unit, qualifier)
) STRICT, WITHOUT ROWID;

-- Instant le plus récent observé par profil : un recul d'horloge ne ramène jamais le
-- ledger vers une période antérieure.
CREATE TABLE ledger_clocks (
  profile_id TEXT PRIMARY KEY REFERENCES profiles (id),
  high_water_at TEXT NOT NULL
) STRICT;

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles (id),
  session_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('open', 'reconciled', 'uncertain')),
  created_at TEXT NOT NULL,
  closed_at TEXT,
  CHECK ((status = 'reconciled') = (closed_at IS NOT NULL))
) STRICT;
CREATE INDEX reservations_by_profile_status ON reservations (profile_id, status);

CREATE TABLE reservation_periods (
  reservation_id TEXT NOT NULL REFERENCES reservations (id),
  period_id TEXT NOT NULL REFERENCES budget_periods (id),
  PRIMARY KEY (reservation_id, period_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX reservation_periods_by_period ON reservation_periods (period_id);

CREATE TABLE reservation_maxima (
  reservation_id TEXT NOT NULL REFERENCES reservations (id),
  unit TEXT NOT NULL CHECK (unit IN ('tokens', 'sessions', 'duration_ms', 'money', 'provider_quota_bp')),
  qualifier TEXT NOT NULL CHECK ((unit IN ('money', 'provider_quota_bp')) = (qualifier <> '')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (reservation_id, unit, qualifier)
) STRICT, WITHOUT ROWID;

-- Usage rapporté, avec sa provenance. Un enregistrement rejoué à l'identique est ignoré.
CREATE TABLE usage_records (
  seq INTEGER PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations (id),
  unit TEXT NOT NULL CHECK (unit IN ('tokens', 'sessions', 'duration_ms', 'money', 'provider_quota_bp')),
  qualifier TEXT NOT NULL CHECK ((unit IN ('money', 'provider_quota_bp')) = (qualifier <> '')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  provenance TEXT NOT NULL CHECK (provenance IN ('measured', 'estimated', 'simulated', 'unknown')),
  token_breakdown_json TEXT CHECK (token_breakdown_json IS NULL OR json_valid(token_breakdown_json)),
  recorded_at TEXT NOT NULL,
  UNIQUE (reservation_id, unit, qualifier, provenance, recorded_at, amount)
) STRICT;

-- Consommation imputée au rapprochement : écrite dans la même transaction que la
-- clôture de la réservation, une ligne par unité.
CREATE TABLE reservation_charges (
  reservation_id TEXT NOT NULL REFERENCES reservations (id),
  unit TEXT NOT NULL CHECK (unit IN ('tokens', 'sessions', 'duration_ms', 'money', 'provider_quota_bp')),
  qualifier TEXT NOT NULL CHECK ((unit IN ('money', 'provider_quota_bp')) = (qualifier <> '')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  provenance TEXT NOT NULL CHECK (provenance IN ('measured', 'estimated', 'simulated', 'unknown')),
  PRIMARY KEY (reservation_id, unit, qualifier)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER reservation_charges_no_update BEFORE UPDATE ON reservation_charges
BEGIN SELECT RAISE(ABORT, 'reservation_charges est en ajout seul'); END;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles (id),
  experiment_id TEXT REFERENCES experiments (id),
  adapter_id TEXT NOT NULL,
  policy_revision_id TEXT NOT NULL REFERENCES policy_revisions (id),
  reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations (id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT CHECK (outcome IN ('completed', 'interrupted', 'failed', 'orphaned')),
  outcome_reason TEXT,
  CHECK ((outcome IS NULL) = (ended_at IS NULL)),
  CHECK ((outcome IS NULL) = (outcome_reason IS NULL))
) STRICT;
-- Au plus une session sans résultat terminal par profil : pas de double lancement.
CREATE UNIQUE INDEX sessions_one_open ON sessions (profile_id) WHERE outcome IS NULL;

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments (id),
  session_id TEXT NOT NULL REFERENCES sessions (id),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  UNIQUE (experiment_id, sequence)
) STRICT;
CREATE TRIGGER checkpoints_no_update BEFORE UPDATE ON checkpoints
BEGIN SELECT RAISE(ABORT, 'checkpoints est en ajout seul'); END;

CREATE TABLE checkpoint_artifacts (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints (id),
  ordinal INTEGER NOT NULL,
  artifact_id TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  PRIMARY KEY (checkpoint_id, ordinal),
  UNIQUE (checkpoint_id, artifact_id)
) STRICT, WITHOUT ROWID;

-- Journal séquencé par profil. Pas de modification ; la purge par rétention reste
-- possible (suppression), conformément à AGENTS §5.
CREATE TABLE journal_events (
  profile_id TEXT NOT NULL REFERENCES profiles (id),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  schema_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  session_id TEXT,
  experiment_id TEXT,
  policy_revision_id TEXT,
  reason TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  PRIMARY KEY (profile_id, sequence)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER journal_events_no_update BEFORE UPDATE ON journal_events
BEGIN SELECT RAISE(ABORT, 'journal_events est en ajout seul'); END;

-- Dernière séquence attribuée par profil : une purge ne fait jamais réutiliser une séquence.
CREATE TABLE journal_sequences (
  profile_id TEXT PRIMARY KEY REFERENCES profiles (id),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
) STRICT;
`;

// Session S6 : état propre au scheduler, une ligne par profil. Les échéances sont en UTC ;
// `last_denial` sert seulement à ne pas journaliser deux fois le même refus.
const SCHEDULER_STATE = `
CREATE TABLE scheduler_state (
  profile_id TEXT PRIMARY KEY REFERENCES profiles (id),
  consecutive_failures INTEGER NOT NULL CHECK (consecutive_failures >= 0),
  backoff_until TEXT,
  last_session_ended_at TEXT,
  last_denial TEXT,
  updated_at TEXT NOT NULL
) STRICT;
`;

// Session S-D : exécutions du daemon au premier plan. Une ligne par démarrage ; une ligne
// sans fin dont le processus a disparu signale un arrêt brutal. `mode` affiche sans
// ambiguïté une exécution simulée (adapter factice) dans `status`.
const DAEMON_RUNS = `
CREATE TABLE daemon_runs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles (id),
  pid INTEGER NOT NULL CHECK (pid > 0),
  mode TEXT NOT NULL CHECK (mode IN ('simulated', 'real')),
  adapter_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
) STRICT;
CREATE INDEX daemon_runs_profile ON daemon_runs (profile_id, started_at);
`;

/**
 * Autotests de refus de l'isolation exécutés par le daemon avant un lancement réel
 * (S10 → runner). Une session réelle n'est lancée que si le dernier autotest a réussi
 * pour l'empreinte du lanceur en service ; `status` en affiche le résultat.
 */
const ISOLATION_SELF_TESTS = `
CREATE TABLE isolation_self_tests (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles (id),
  ran_at TEXT NOT NULL,
  source_digest TEXT,
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  checks INTEGER NOT NULL CHECK (checks >= 0),
  failed TEXT NOT NULL,
  cleanup_verified INTEGER NOT NULL CHECK (cleanup_verified IN (0, 1)),
  termination_ms REAL,
  duration_ms REAL NOT NULL
) STRICT;
CREATE INDEX isolation_self_tests_profile ON isolation_self_tests (profile_id, ran_at);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial_schema", sql: INITIAL_SCHEMA },
  { version: 2, name: "scheduler_state", sql: SCHEDULER_STATE },
  { version: 3, name: "daemon_runs", sql: DAEMON_RUNS },
  { version: 4, name: "isolation_self_tests", sql: ISOLATION_SELF_TESTS },
];

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;
`;

interface AppliedRow {
  readonly version: number;
  readonly name: string;
}

/**
 * Applique les migrations manquantes, chacune dans sa propre transaction
 * `BEGIN IMMEDIATE` : deux processus qui ouvrent la base en même temps ne peuvent pas
 * appliquer deux fois la même migration. Refuse une base plus récente que ce binaire.
 * Retourne les versions appliquées par cet appel.
 */
export function migrate(
  db: SqliteDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => string = () => new Date().toISOString(),
): readonly number[] {
  const applied: number[] = [];
  const step = db.transaction((): boolean => {
    db.exec(MIGRATIONS_TABLE);
    const rows = db
      .prepare<[], AppliedRow>("SELECT version, name FROM schema_migrations ORDER BY version")
      .all();
    rows.forEach((row, index) => {
      const known = migrations[index];
      if (known?.version !== row.version || known.name !== row.name) {
        throw new StoreError(
          "schema_mismatch",
          `migration ${String(row.version)} (${row.name}) inconnue de ce binaire : base plus récente ou divergente`,
        );
      }
    });
    const next = migrations[rows.length];
    if (next === undefined) return false;
    db.exec(next.sql);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
      next.version,
      next.name,
      now(),
    );
    applied.push(next.version);
    return true;
  });
  while (step.immediate()) {
    // Une migration par transaction, jusqu'à la dernière connue.
  }
  return applied;
}

/**
 * Vérifie, sans rien écrire, que la base porte exactement les migrations connues.
 * Utilisé par l'ouverture en lecture seule, qui ne peut pas migrer.
 */
export function assertSchemaCurrent(
  db: SqliteDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  const table = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  const rows =
    table === undefined
      ? []
      : db
          .prepare<[], AppliedRow>("SELECT version, name FROM schema_migrations ORDER BY version")
          .all();
  const current =
    rows.length === migrations.length &&
    rows.every(
      (row, i) => migrations[i]?.version === row.version && migrations[i].name === row.name,
    );
  if (!current) {
    throw new StoreError(
      "schema_mismatch",
      `schéma de la base (${String(rows.length)} migration(s)) différent de ce binaire (${String(migrations.length)}) : ouvrir en écriture pour migrer`,
    );
  }
}
