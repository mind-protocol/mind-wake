/**
 * Implémentations SQLite des dépôts de `src/contracts/repositories.ts`, hors ledger
 * (voir `src/ledger/sqlite-ledger.ts`). Chaque opération composée s'exécute en
 * `BEGIN IMMEDIATE`, ou en savepoint dans une transaction déjà ouverte.
 */

import type {
  AgentId,
  ArtifactRef,
  Checkpoint,
  CheckpointId,
  CheckpointRepository,
  ConsentId,
  ExperimentId,
  ExperimentRecord,
  ExperimentRepository,
  JournalEvent,
  JournalEventInput,
  JournalRepository,
  JsonObject,
  PermissionRevocation,
  PolicyConsent,
  PolicyGroups,
  PolicyRepository,
  PolicyRevision,
  PolicyRevisionId,
  ProfileId,
  ProfileRecord,
  ProfileRepository,
  ProfileState,
  ProfileTransition,
  SessionId,
  SessionOutcome,
  SessionRecord,
  SessionRepository,
  UtcTimestamp,
} from "../contracts/index.js";
import {
  JOURNAL_EVENT_TYPES,
  JOURNAL_SCHEMA_VERSION,
  isProfileTransitionAllowed,
} from "../contracts/index.js";
import { normalizeUtcTimestamp } from "../ledger/time.js";
import type { SqliteDatabase } from "./database.js";
import { StoreError } from "./errors.js";
import { immediate, optional } from "./sql.js";

// ── Profils ────────────────────────────────────────────────────────────────────

interface ProfileRow {
  readonly id: string;
  readonly agent_id: string;
  readonly state: ProfileState;
  readonly active_policy_revision_id: string | null;
  readonly next_wake_at: string | null;
  readonly emergency_stop_locked: number;
  readonly state_reason: string;
  readonly updated_at: string;
}

function toProfile(row: ProfileRow): ProfileRecord {
  return {
    id: row.id as ProfileId,
    agentId: row.agent_id as AgentId,
    state: row.state,
    activePolicyRevisionId: row.active_policy_revision_id as PolicyRevisionId | null,
    nextWakeAt: row.next_wake_at as UtcTimestamp | null,
    emergencyStopLocked: row.emergency_stop_locked === 1,
    stateReason: row.state_reason,
    updatedAt: row.updated_at as UtcTimestamp,
  };
}

export class SqliteProfileRepository implements ProfileRepository {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  get(id: ProfileId): ProfileRecord | null {
    const row = this.#db
      .prepare<[string], ProfileRow>("SELECT * FROM profiles WHERE id = ?")
      .get(id);
    return row === undefined ? null : toProfile(row);
  }

  create(record: ProfileRecord): void {
    this.#db
      .prepare(
        `INSERT INTO profiles (id, agent_id, state, active_policy_revision_id, next_wake_at,
           emergency_stop_locked, state_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.agentId,
        record.state,
        record.activePolicyRevisionId,
        record.nextWakeAt === null ? null : normalizeUtcTimestamp(record.nextWakeAt),
        record.emergencyStopLocked ? 1 : 0,
        record.stateReason,
        normalizeUtcTimestamp(record.updatedAt),
      );
  }

  transition(id: ProfileId, transition: ProfileTransition): ProfileRecord {
    const at = normalizeUtcTimestamp(transition.at);
    return immediate(this.#db, () => {
      const current = this.get(id);
      if (current === null) {
        throw new StoreError("not_found", `profil ${id} inconnu`);
      }
      if (current.state !== transition.from) {
        throw new StoreError(
          "invalid_transition",
          `profil ${id} en état ${current.state}, pas ${transition.from}`,
        );
      }
      if (!isProfileTransitionAllowed(transition.from, transition.to)) {
        throw new StoreError(
          "invalid_transition",
          `transition ${transition.from} → ${transition.to} interdite`,
        );
      }
      this.#db
        .prepare("UPDATE profiles SET state = ?, state_reason = ?, updated_at = ? WHERE id = ?")
        .run(transition.to, transition.reason, at, id);
      return { ...current, state: transition.to, stateReason: transition.reason, updatedAt: at };
    });
  }

  setNextWake(id: ProfileId, at: UtcTimestamp | null): void {
    const result = this.#db
      .prepare("UPDATE profiles SET next_wake_at = ? WHERE id = ?")
      .run(at === null ? null : normalizeUtcTimestamp(at), id);
    if (result.changes !== 1) {
      throw new StoreError("not_found", `profil ${id} inconnu`);
    }
  }

  setEmergencyStopLocked(id: ProfileId, locked: boolean, at: UtcTimestamp): ProfileRecord {
    const updatedAt = normalizeUtcTimestamp(at);
    return immediate(this.#db, () => {
      const result = this.#db
        .prepare("UPDATE profiles SET emergency_stop_locked = ?, updated_at = ? WHERE id = ?")
        .run(locked ? 1 : 0, updatedAt, id);
      const current = result.changes === 1 ? this.get(id) : null;
      if (current === null) throw new StoreError("not_found", `profil ${id} inconnu`);
      return current;
    });
  }
}

// ── Policies ───────────────────────────────────────────────────────────────────

interface RevisionRow {
  readonly id: string;
  readonly profile_id: string;
  readonly previous_revision_id: string | null;
  readonly schema_version: number;
  readonly created_at: string;
  readonly groups_json: string;
}

interface ConsentRow {
  readonly id: string;
  readonly revision_id: string;
  readonly granted_at: string;
  readonly channel: "local_cli";
  readonly proof: string;
}

function toRevision(row: RevisionRow): PolicyRevision {
  return {
    schemaVersion: row.schema_version,
    id: row.id as PolicyRevisionId,
    profileId: row.profile_id as ProfileId,
    previousRevisionId: row.previous_revision_id as PolicyRevisionId | null,
    createdAt: row.created_at as UtcTimestamp,
    groups: JSON.parse(row.groups_json) as PolicyGroups,
  };
}

function toConsent(row: ConsentRow): PolicyConsent {
  return {
    id: row.id as ConsentId,
    revisionId: row.revision_id as PolicyRevisionId,
    grantedAt: row.granted_at as UtcTimestamp,
    channel: row.channel,
    proof: row.proof,
  };
}

export class SqlitePolicyRepository implements PolicyRepository {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  /**
   * Ajoute une révision en fin de chaîne. Refuse un identifiant déjà utilisé, une
   * révision dont le profil ne correspond pas à son groupe d'identité, et toute
   * bifurcation (la précédente doit être la dernière révision du profil).
   */
  appendRevision(revision: PolicyRevision): void {
    if (revision.groups.identity.profileId !== revision.profileId) {
      throw new StoreError("invalid_input", "le groupe d'identité ne correspond pas au profil");
    }
    const createdAt = normalizeUtcTimestamp(revision.createdAt);
    immediate(this.#db, () => {
      if (this.getRevision(revision.id) !== null) {
        throw new StoreError("immutable", `révision ${revision.id} déjà enregistrée`);
      }
      const latest = this.#latest(revision.profileId);
      if ((latest?.id ?? null) !== revision.previousRevisionId) {
        throw new StoreError(
          "conflict",
          `la révision précédente doit être ${latest?.id ?? "absente"}, pas ${String(revision.previousRevisionId)}`,
        );
      }
      this.#db
        .prepare(
          `INSERT INTO policy_revisions (id, profile_id, previous_revision_id, schema_version,
             created_at, groups_json) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revision.id,
          revision.profileId,
          revision.previousRevisionId,
          revision.schemaVersion,
          createdAt,
          JSON.stringify(revision.groups),
        );
    });
  }

  getRevision(id: PolicyRevisionId): PolicyRevision | null {
    const row = this.#db
      .prepare<[string], RevisionRow>("SELECT * FROM policy_revisions WHERE id = ?")
      .get(id);
    return row === undefined ? null : toRevision(row);
  }

  /** Révisions dans l'ordre de la chaîne, de la première à la plus récente. */
  listRevisions(profileId: ProfileId): readonly PolicyRevision[] {
    return this.#db
      .prepare<[string], RevisionRow>(
        "SELECT * FROM policy_revisions WHERE profile_id = ? ORDER BY rowid",
      )
      .all(profileId)
      .map(toRevision);
  }

  recordConsent(consent: PolicyConsent): void {
    const grantedAt = normalizeUtcTimestamp(consent.grantedAt);
    immediate(this.#db, () => {
      const existing = this.#db
        .prepare<[string], ConsentRow>("SELECT * FROM policy_consents WHERE id = ?")
        .get(consent.id);
      if (existing !== undefined) {
        const same =
          existing.revision_id === consent.revisionId &&
          existing.granted_at === grantedAt &&
          existing.proof === consent.proof;
        if (same) return;
        throw new StoreError("immutable", `consentement ${consent.id} déjà enregistré`);
      }
      this.#db
        .prepare(
          "INSERT INTO policy_consents (id, revision_id, granted_at, channel, proof) VALUES (?, ?, ?, ?, ?)",
        )
        .run(consent.id, consent.revisionId, grantedAt, consent.channel, consent.proof);
    });
  }

  getConsent(revisionId: PolicyRevisionId): PolicyConsent | null {
    const row = this.#db
      .prepare<[string], ConsentRow>("SELECT * FROM policy_consents WHERE revision_id = ?")
      .get(revisionId);
    return row === undefined ? null : toConsent(row);
  }

  recordRevocation(revocation: PermissionRevocation): void {
    this.#db
      .prepare(
        "INSERT INTO permission_revocations (revision_id, revoked_at, reason) VALUES (?, ?, ?)",
      )
      .run(revocation.revisionId, normalizeUtcTimestamp(revocation.revokedAt), revocation.reason);
  }

  listRevocations(revisionId: PolicyRevisionId): readonly PermissionRevocation[] {
    return this.#db
      .prepare<[string], { revision_id: string; revoked_at: string; reason: string }>(
        "SELECT revision_id, revoked_at, reason FROM permission_revocations WHERE revision_id = ? ORDER BY seq",
      )
      .all(revisionId)
      .map((row) => ({
        revisionId: row.revision_id as PolicyRevisionId,
        revokedAt: row.revoked_at as UtcTimestamp,
        reason: row.reason,
      }));
  }

  #latest(profileId: ProfileId): RevisionRow | undefined {
    return this.#db
      .prepare<[string], RevisionRow>(
        `SELECT * FROM policy_revisions r WHERE r.profile_id = ?
           AND NOT EXISTS (SELECT 1 FROM policy_revisions n WHERE n.previous_revision_id = r.id)`,
      )
      .get(profileId);
  }
}

// ── Expériences ────────────────────────────────────────────────────────────────

interface ExperimentRow {
  readonly id: string;
  readonly profile_id: string;
  readonly title: string;
  readonly question: string;
  readonly status: ExperimentRecord["status"];
  readonly status_reason: string;
  readonly current_checkpoint_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function toExperiment(row: ExperimentRow): ExperimentRecord {
  return {
    id: row.id as ExperimentId,
    profileId: row.profile_id as ProfileId,
    title: row.title,
    question: row.question,
    status: row.status,
    statusReason: row.status_reason,
    currentCheckpointId: row.current_checkpoint_id as CheckpointId | null,
    createdAt: row.created_at as UtcTimestamp,
    updatedAt: row.updated_at as UtcTimestamp,
  };
}

export class SqliteExperimentRepository implements ExperimentRepository {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  get(id: ExperimentId): ExperimentRecord | null {
    const row = this.#db
      .prepare<[string], ExperimentRow>("SELECT * FROM experiments WHERE id = ?")
      .get(id);
    return row === undefined ? null : toExperiment(row);
  }

  getActive(profileId: ProfileId): ExperimentRecord | null {
    const row = this.#db
      .prepare<[string], ExperimentRow>(
        "SELECT * FROM experiments WHERE profile_id = ? AND status = 'active'",
      )
      .get(profileId);
    return row === undefined ? null : toExperiment(row);
  }

  /** Le profil et la date de création d'une expérience existante ne changent jamais. */
  upsert(record: ExperimentRecord): void {
    const result = this.#db
      .prepare(
        `INSERT INTO experiments (id, profile_id, title, question, status, status_reason,
           current_checkpoint_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET title = excluded.title, question = excluded.question,
           status = excluded.status, status_reason = excluded.status_reason,
           current_checkpoint_id = excluded.current_checkpoint_id, updated_at = excluded.updated_at
         WHERE experiments.profile_id = excluded.profile_id`,
      )
      .run(
        record.id,
        record.profileId,
        record.title,
        record.question,
        record.status,
        record.statusReason,
        record.currentCheckpointId,
        normalizeUtcTimestamp(record.createdAt),
        normalizeUtcTimestamp(record.updatedAt),
      );
    if (result.changes !== 1) {
      throw new StoreError("conflict", `expérience ${record.id} appartient à un autre profil`);
    }
  }
}

// ── Sessions ───────────────────────────────────────────────────────────────────

interface SessionRow {
  readonly id: string;
  readonly profile_id: string;
  readonly experiment_id: string | null;
  readonly adapter_id: string;
  readonly policy_revision_id: string;
  readonly reservation_id: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly outcome: SessionOutcome | null;
  readonly outcome_reason: string | null;
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id as SessionId,
    profileId: row.profile_id as ProfileId,
    experimentId: row.experiment_id as ExperimentId | null,
    adapterId: row.adapter_id as SessionRecord["adapterId"],
    policyRevisionId: row.policy_revision_id as PolicyRevisionId,
    reservationId: row.reservation_id as SessionRecord["reservationId"],
    startedAt: row.started_at as UtcTimestamp,
    endedAt: row.ended_at as UtcTimestamp | null,
    outcome: row.outcome,
    outcomeReason: row.outcome_reason,
  };
}

export class SqliteSessionRepository implements SessionRepository {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  get(id: SessionId): SessionRecord | null {
    const row = this.#db
      .prepare<[string], SessionRow>("SELECT * FROM sessions WHERE id = ?")
      .get(id);
    return row === undefined ? null : toSession(row);
  }

  listOpen(profileId: ProfileId): readonly SessionRecord[] {
    return this.#db
      .prepare<[string], SessionRow>(
        "SELECT * FROM sessions WHERE profile_id = ? AND outcome IS NULL ORDER BY started_at",
      )
      .all(profileId)
      .map(toSession);
  }

  /**
   * Crée une session sur une réservation existante émise pour elle. L'index
   * `sessions_one_open` refuse une seconde session ouverte pour le même profil.
   */
  create(record: SessionRecord): void {
    immediate(this.#db, () => {
      const reservation = this.#db
        .prepare<[string], { session_id: string; profile_id: string }>(
          "SELECT session_id, profile_id FROM reservations WHERE id = ?",
        )
        .get(record.reservationId);
      if (reservation === undefined) {
        throw new StoreError("not_found", `réservation ${record.reservationId} inconnue`);
      }
      if (reservation.session_id !== record.id || reservation.profile_id !== record.profileId) {
        throw new StoreError(
          "conflict",
          `réservation ${record.reservationId} émise pour une autre session`,
        );
      }
      this.#db
        .prepare(
          `INSERT INTO sessions (id, profile_id, experiment_id, adapter_id, policy_revision_id,
             reservation_id, started_at, ended_at, outcome, outcome_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.profileId,
          record.experimentId,
          record.adapterId,
          record.policyRevisionId,
          record.reservationId,
          normalizeUtcTimestamp(record.startedAt),
          record.endedAt === null ? null : normalizeUtcTimestamp(record.endedAt),
          record.outcome,
          record.outcomeReason,
        );
    });
  }

  /** Idempotent pour un même résultat ; un résultat différent est refusé. */
  close(
    id: SessionId,
    outcome: NonNullable<SessionRecord["outcome"]>,
    reason: string,
    endedAt: UtcTimestamp,
  ): void {
    const at = normalizeUtcTimestamp(endedAt);
    immediate(this.#db, () => {
      const current = this.get(id);
      if (current === null) {
        throw new StoreError("not_found", `session ${id} inconnue`);
      }
      if (current.outcome !== null) {
        if (current.outcome === outcome) return;
        throw new StoreError(
          "closed",
          `session ${id} déjà close (${current.outcome}), résultat ${outcome} refusé`,
        );
      }
      this.#db
        .prepare(
          "UPDATE sessions SET outcome = ?, outcome_reason = ?, ended_at = ? WHERE id = ? AND outcome IS NULL",
        )
        .run(outcome, reason, at, id);
    });
  }
}

// ── Journal ────────────────────────────────────────────────────────────────────

interface JournalRow {
  readonly profile_id: string;
  readonly sequence: number;
  readonly schema_version: number;
  readonly type: JournalEvent["type"];
  readonly at: string;
  readonly session_id: string | null;
  readonly experiment_id: string | null;
  readonly policy_revision_id: string | null;
  readonly reason: string;
  readonly metadata_json: string;
}

function toEvent(row: JournalRow): JournalEvent {
  return {
    schemaVersion: row.schema_version,
    sequence: row.sequence,
    type: row.type,
    at: row.at as UtcTimestamp,
    profileId: row.profile_id as ProfileId,
    ...optional("sessionId", row.session_id as SessionId | null),
    ...optional("experimentId", row.experiment_id as ExperimentId | null),
    ...optional("policyRevisionId", row.policy_revision_id as PolicyRevisionId | null),
    reason: row.reason,
    metadata: JSON.parse(row.metadata_json) as JsonObject,
  };
}

/**
 * Journal séquencé. L'expurgation des métadonnées relève de `src/journal/` (S5) et
 * précède l'appel ; ce dépôt attribue la séquence et refuse toute modification.
 */
export class SqliteJournalRepository implements JournalRepository {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  append(event: JournalEventInput): JournalEvent {
    if (!(JOURNAL_EVENT_TYPES as readonly string[]).includes(event.type)) {
      throw new StoreError("invalid_input", `type d'événement inconnu : ${event.type}`);
    }
    const at = normalizeUtcTimestamp(event.at);
    const metadata = JSON.stringify(event.metadata);
    return immediate(this.#db, () => {
      const row = this.#db
        .prepare<[string], { last_sequence: number }>(
          `INSERT INTO journal_sequences (profile_id, last_sequence) VALUES (?, 1)
           ON CONFLICT (profile_id) DO UPDATE SET last_sequence = last_sequence + 1
           RETURNING last_sequence`,
        )
        .get(event.profileId);
      if (row === undefined) {
        throw new StoreError("not_found", "séquence de journal non attribuée");
      }
      this.#db
        .prepare(
          `INSERT INTO journal_events (profile_id, sequence, schema_version, type, at, session_id,
             experiment_id, policy_revision_id, reason, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.profileId,
          row.last_sequence,
          JOURNAL_SCHEMA_VERSION,
          event.type,
          at,
          event.sessionId ?? null,
          event.experimentId ?? null,
          event.policyRevisionId ?? null,
          event.reason,
          metadata,
        );
      return {
        ...event,
        at,
        metadata: JSON.parse(metadata) as JsonObject,
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        sequence: row.last_sequence,
      };
    });
  }

  list(
    profileId: ProfileId,
    options: { readonly afterSequence?: number; readonly limit?: number } = {},
  ): readonly JournalEvent[] {
    return this.#db
      .prepare<[string, number, number], JournalRow>(
        "SELECT * FROM journal_events WHERE profile_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
      )
      .all(profileId, options.afterSequence ?? 0, options.limit ?? -1)
      .map(toEvent);
  }
}

// ── Checkpoints ────────────────────────────────────────────────────────────────

interface CheckpointRow {
  readonly id: string;
  readonly experiment_id: string;
  readonly session_id: string;
  readonly sequence: number;
  readonly schema_version: number;
  readonly created_at: string;
  readonly body_json: string;
}

type CheckpointBody = Pick<
  Checkpoint,
  "summary" | "observations" | "failures" | "incompleteWork" | "nextAction" | "hibernationReason"
>;

export class SqliteCheckpointRepository implements CheckpointRepository {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  /**
   * Enregistre un checkpoint déjà validé et le désigne comme courant pour son
   * expérience, atomiquement. La séquence doit dépasser celle du dernier checkpoint.
   */
  publish(checkpoint: Checkpoint): void {
    const createdAt = normalizeUtcTimestamp(checkpoint.createdAt);
    const body: CheckpointBody = {
      summary: checkpoint.summary,
      observations: checkpoint.observations,
      failures: checkpoint.failures,
      incompleteWork: checkpoint.incompleteWork,
      nextAction: checkpoint.nextAction,
      hibernationReason: checkpoint.hibernationReason,
    };
    immediate(this.#db, () => {
      const last = this.latest(checkpoint.experimentId);
      if (last !== null && checkpoint.sequence <= last.sequence) {
        throw new StoreError(
          "conflict",
          `séquence ${String(checkpoint.sequence)} non croissante (dernière : ${String(last.sequence)})`,
        );
      }
      this.#db
        .prepare(
          `INSERT INTO checkpoints (id, experiment_id, session_id, sequence, schema_version,
             created_at, body_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          checkpoint.id,
          checkpoint.experimentId,
          checkpoint.sessionId,
          checkpoint.sequence,
          checkpoint.schemaVersion,
          createdAt,
          JSON.stringify(body),
        );
      const addArtifact = this.#db.prepare(
        `INSERT INTO checkpoint_artifacts (checkpoint_id, ordinal, artifact_id, path, sha256, bytes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      checkpoint.artifacts.forEach((artifact, ordinal) => {
        addArtifact.run(
          checkpoint.id,
          ordinal,
          artifact.id,
          artifact.path,
          artifact.sha256,
          artifact.bytes,
        );
      });
      const updated = this.#db
        .prepare("UPDATE experiments SET current_checkpoint_id = ?, updated_at = ? WHERE id = ?")
        .run(checkpoint.id, createdAt, checkpoint.experimentId);
      if (updated.changes !== 1) {
        throw new StoreError("not_found", `expérience ${checkpoint.experimentId} inconnue`);
      }
    });
  }

  get(id: CheckpointId): Checkpoint | null {
    const row = this.#db
      .prepare<[string], CheckpointRow>("SELECT * FROM checkpoints WHERE id = ?")
      .get(id);
    return row === undefined ? null : this.#toCheckpoint(row);
  }

  latest(experimentId: ExperimentId): Checkpoint | null {
    const row = this.#db
      .prepare<[string], CheckpointRow>(
        "SELECT * FROM checkpoints WHERE experiment_id = ? ORDER BY sequence DESC LIMIT 1",
      )
      .get(experimentId);
    return row === undefined ? null : this.#toCheckpoint(row);
  }

  #toCheckpoint(row: CheckpointRow): Checkpoint {
    const body = JSON.parse(row.body_json) as CheckpointBody;
    const artifacts = this.#db
      .prepare<[string], { artifact_id: string; path: string; sha256: string; bytes: number }>(
        "SELECT artifact_id, path, sha256, bytes FROM checkpoint_artifacts WHERE checkpoint_id = ? ORDER BY ordinal",
      )
      .all(row.id)
      .map((artifact): ArtifactRef => ({
        id: artifact.artifact_id as ArtifactRef["id"],
        path: artifact.path as ArtifactRef["path"],
        sha256: artifact.sha256 as ArtifactRef["sha256"],
        bytes: artifact.bytes,
      }));
    return {
      ...body,
      schemaVersion: row.schema_version,
      id: row.id as CheckpointId,
      experimentId: row.experiment_id as ExperimentId,
      sessionId: row.session_id as SessionId,
      sequence: row.sequence,
      createdAt: row.created_at as UtcTimestamp,
      artifacts,
    };
  }
}
