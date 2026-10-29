/**
 * Entités logiques persistées (SPEC §8.2) : profil, expérience, session.
 */

import type {
  AdapterId,
  AgentId,
  CheckpointId,
  ExperimentId,
  PolicyRevisionId,
  ProfileId,
  ReservationId,
  SessionId,
  UtcTimestamp,
} from "./common.js";
import type { ProfileState, SessionOutcome } from "./lifecycle.js";

export interface ProfileRecord {
  readonly id: ProfileId;
  readonly agentId: AgentId;
  readonly state: ProfileState;
  readonly activePolicyRevisionId: PolicyRevisionId | null;
  readonly nextWakeAt: UtcTimestamp | null;
  /** Arrêt d'urgence verrouillé : seule une réactivation humaine explicite le lève. */
  readonly emergencyStopLocked: boolean;
  readonly stateReason: string;
  readonly updatedAt: UtcTimestamp;
}

export type ExperimentStatus = "active" | "concluded" | "abandoned" | "archived";

export interface ExperimentRecord {
  readonly id: ExperimentId;
  readonly profileId: ProfileId;
  readonly title: string;
  readonly question: string;
  readonly status: ExperimentStatus;
  readonly statusReason: string;
  readonly currentCheckpointId: CheckpointId | null;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

export interface SessionRecord {
  readonly id: SessionId;
  readonly profileId: ProfileId;
  readonly experimentId: ExperimentId | null;
  readonly adapterId: AdapterId;
  /** Révision de policy en vigueur au lancement. */
  readonly policyRevisionId: PolicyRevisionId;
  readonly reservationId: ReservationId;
  readonly startedAt: UtcTimestamp;
  readonly endedAt: UtcTimestamp | null;
  /** `null` tant que la session n'a pas de résultat terminal. */
  readonly outcome: SessionOutcome | null;
  readonly outcomeReason: string | null;
}
