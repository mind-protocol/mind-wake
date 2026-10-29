/**
 * Événements du journal (AGENTS §5, SPEC §8.2). Les métadonnées sont expurgées avant
 * écriture : aucun secret, aucun raisonnement interne privé.
 */

import type {
  ExperimentId,
  JsonObject,
  PolicyRevisionId,
  ProfileId,
  SchemaVersion,
  SessionId,
  UtcTimestamp,
} from "./common.js";

export const JOURNAL_SCHEMA_VERSION: SchemaVersion = 1;

export const JOURNAL_EVENT_TYPES = [
  "profile_state_changed",
  "policy_revision_created",
  "consent_granted",
  "permission_revoked",
  "experiment_chosen",
  "experiment_status_changed",
  "session_started",
  "session_ended",
  "action_allowed",
  "action_denied",
  "budget_reserved",
  "budget_reconciled",
  "budget_marked_uncertain",
  "usage_recorded",
  "checkpoint_published",
  "checkpoint_rejected",
  "artifact_recorded",
  "rate_limited",
  "user_priority_triggered",
  "pause_requested",
  "kill_switch_triggered",
  "orphan_reconciled",
  "data_exported",
  "data_purged",
  "error",
] as const;

export type JournalEventType = (typeof JOURNAL_EVENT_TYPES)[number];

/** Événement à écrire ; la séquence est attribuée par le dépôt. */
export interface JournalEventInput {
  readonly type: JournalEventType;
  readonly at: UtcTimestamp;
  readonly profileId: ProfileId;
  readonly sessionId?: SessionId;
  readonly experimentId?: ExperimentId;
  readonly policyRevisionId?: PolicyRevisionId;
  /** Motif lisible par l'humain. */
  readonly reason: string;
  /** Métadonnées déjà expurgées. */
  readonly metadata: JsonObject;
}

export interface JournalEvent extends JournalEventInput {
  readonly schemaVersion: SchemaVersion;
  /** Séquence strictement croissante par profil. */
  readonly sequence: number;
}
