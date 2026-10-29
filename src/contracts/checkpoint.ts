/**
 * Contrat versionné d'un checkpoint (SPEC §7). Un checkpoint est une mémoire, pas une
 * autorité : il ne contient ni secret ni instruction autorisant une action future.
 */

import type {
  ArtifactId,
  CheckpointId,
  ConfinedRelativePath,
  ExperimentId,
  SchemaVersion,
  SessionId,
  Sha256Hex,
  UtcTimestamp,
} from "./common.js";

export const CHECKPOINT_SCHEMA_VERSION: SchemaVersion = 1;

/** Statut de confiance d'une observation : fait observé ou interprétation. */
export type ObservationConfidence = "observed" | "inferred" | "hypothesis";

export interface Observation {
  readonly text: string;
  readonly confidence: ObservationConfidence;
}

/** Référence confinée à l'espace d'exploration, avec intégrité du fichier. */
export interface ArtifactRef {
  readonly id: ArtifactId;
  readonly path: ConfinedRelativePath;
  readonly sha256: Sha256Hex;
  readonly bytes: number;
}

/** Contenu proposé par l'agent ; non fiable tant que le daemon ne l'a pas validé. */
export interface CheckpointCandidate {
  readonly schemaVersion: SchemaVersion;
  readonly experimentId: ExperimentId;
  readonly sessionId: SessionId;
  readonly summary: string;
  readonly observations: readonly Observation[];
  readonly failures: readonly string[];
  readonly artifacts: readonly ArtifactRef[];
  readonly incompleteWork: readonly string[];
  readonly nextAction: string;
  readonly hibernationReason: string;
}

/** Checkpoint validé et durable, publié comme courant par le daemon. */
export interface Checkpoint extends CheckpointCandidate {
  readonly id: CheckpointId;
  /** Séquence strictement croissante par expérience. */
  readonly sequence: number;
  readonly createdAt: UtcTimestamp;
}

export const CHECKPOINT_REJECTION_REASONS = [
  "unsupported_schema_version",
  "too_large",
  "malformed",
  "path_escape",
  "missing_artifact",
  "integrity_mismatch",
  "contains_secret",
] as const;

export type CheckpointRejectionReason = (typeof CHECKPOINT_REJECTION_REASONS)[number];

export type CheckpointValidation =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reasons: readonly CheckpointRejectionReason[];
      readonly detail: string;
    };
