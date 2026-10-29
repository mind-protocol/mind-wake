/**
 * Interfaces de persistance consommées par les modules métier. S3 les implémente sur
 * SQLite ; S4, S5 et les vagues suivantes les utilisent sans dépendre du stockage.
 *
 * Les méthodes sont synchrones : le pilote retenu (better-sqlite3, ADR-001) est
 * synchrone, ce qui permet de composer plusieurs opérations dans une seule transaction.
 */

import type {
  BudgetAvailability,
  BudgetPeriod,
  BudgetPeriodDefinition,
  BudgetQuantity,
  BudgetUnit,
  PeriodLimit,
  Reservation,
  UsageRecord,
} from "./budget.js";
import type { Checkpoint } from "./checkpoint.js";
import type {
  BudgetPeriodId,
  CheckpointId,
  ExperimentId,
  PolicyRevisionId,
  ProfileId,
  ReservationId,
  SessionId,
  UtcTimestamp,
} from "./common.js";
import type { JournalEvent, JournalEventInput } from "./journal.js";
import type { ProfileTransition } from "./lifecycle.js";
import type { PermissionRevocation, PolicyConsent, PolicyRevision } from "./policy.js";
import type { ExperimentRecord, ProfileRecord, SessionRecord } from "./records.js";

export interface ProfileRepository {
  get(id: ProfileId): ProfileRecord | null;
  create(record: ProfileRecord): void;
  /** Applique une transition autorisée ; refuse toute transition hors table. */
  transition(id: ProfileId, transition: ProfileTransition): ProfileRecord;
  setNextWake(id: ProfileId, at: UtcTimestamp | null): void;
}

export interface PolicyRepository {
  /** Ajoute une révision ; une révision existante n'est jamais modifiée. */
  appendRevision(revision: PolicyRevision): void;
  getRevision(id: PolicyRevisionId): PolicyRevision | null;
  listRevisions(profileId: ProfileId): readonly PolicyRevision[];
  recordConsent(consent: PolicyConsent): void;
  getConsent(revisionId: PolicyRevisionId): PolicyConsent | null;
  recordRevocation(revocation: PermissionRevocation): void;
  listRevocations(revisionId: PolicyRevisionId): readonly PermissionRevocation[];
}

export interface ExperimentRepository {
  get(id: ExperimentId): ExperimentRecord | null;
  getActive(profileId: ProfileId): ExperimentRecord | null;
  upsert(record: ExperimentRecord): void;
}

export interface SessionRepository {
  get(id: SessionId): SessionRecord | null;
  /** Sessions sans résultat terminal : candidates à la réconciliation d'orphelines. */
  listOpen(profileId: ProfileId): readonly SessionRecord[];
  create(record: SessionRecord): void;
  close(
    id: SessionId,
    outcome: NonNullable<SessionRecord["outcome"]>,
    reason: string,
    endedAt: UtcTimestamp,
  ): void;
}

export interface ReservationRequest {
  readonly id: ReservationId;
  readonly sessionId: SessionId;
  readonly profileId: ProfileId;
  readonly periodIds: readonly BudgetPeriodId[];
  readonly maxima: readonly BudgetQuantity[];
  readonly at: UtcTimestamp;
}

export type ReservationResult =
  | { readonly status: "reserved"; readonly reservation: Reservation }
  | {
      readonly status: "denied";
      readonly reason: "budget_exhausted" | "budget_unknown" | "session_already_active";
      readonly detail: string;
    };

export interface LedgerRepository {
  /**
   * Crée ou retrouve la période couvrant `at` ; jamais remise à zéro par un redémarrage
   * ni par un recul d'horloge. `limits` remplace les plafonds persistés de la période :
   * une réduction bloque aussitôt les nouvelles réservations, sans annuler l'usage engagé.
   */
  ensurePeriod(
    profileId: ProfileId,
    definition: BudgetPeriodDefinition,
    at: UtcTimestamp,
    limits: readonly PeriodLimit[],
  ): BudgetPeriod;
  /** Réservation atomique ; idempotente sur `request.id`. */
  reserve(request: ReservationRequest): ReservationResult;
  recordUsage(usage: UsageRecord): void;
  /** Convertit la réservation en consommation et la clôt atomiquement ; idempotent. */
  reconcile(id: ReservationId, usage: readonly UsageRecord[], at: UtcTimestamp): Reservation;
  /** Conserve la borne maximale jusqu'à rapprochement fiable. */
  markUncertain(id: ReservationId, at: UtcTimestamp): Reservation;
  getReservation(id: ReservationId): Reservation | null;
  /** `windowKey` est obligatoire pour `provider_quota_bp`, ignoré sinon. */
  availability(periodId: BudgetPeriodId, unit: BudgetUnit, windowKey?: string): BudgetAvailability;
}

export interface JournalRepository {
  append(event: JournalEventInput): JournalEvent;
  list(
    profileId: ProfileId,
    options?: { readonly afterSequence?: number; readonly limit?: number },
  ): readonly JournalEvent[];
}

export interface CheckpointRepository {
  /** Enregistre un checkpoint déjà validé, après écriture atomique des artefacts. */
  publish(checkpoint: Checkpoint): void;
  get(id: CheckpointId): Checkpoint | null;
  latest(experimentId: ExperimentId): Checkpoint | null;
}

/** Point d'entrée transactionnel : tout ce qui est fait dans `fn` est atomique. */
export interface UnitOfWork {
  readonly profiles: ProfileRepository;
  readonly policies: PolicyRepository;
  readonly experiments: ExperimentRepository;
  readonly sessions: SessionRepository;
  readonly ledger: LedgerRepository;
  readonly journal: JournalRepository;
  readonly checkpoints: CheckpointRepository;
  transaction<T>(fn: (uow: UnitOfWork) => T): T;
}
