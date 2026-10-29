/**
 * Types de base partagés : identifiants locaux stables, horodatage UTC, JSON.
 * Types seulement ; aucune logique métier.
 */

declare const brand: unique symbol;

/** Type nominal : empêche de confondre deux identifiants de nature différente. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ProfileId = Brand<string, "ProfileId">;
export type AgentId = Brand<string, "AgentId">;
export type PolicyRevisionId = Brand<string, "PolicyRevisionId">;
export type ConsentId = Brand<string, "ConsentId">;
export type ExperimentId = Brand<string, "ExperimentId">;
export type SessionId = Brand<string, "SessionId">;
export type ReservationId = Brand<string, "ReservationId">;
export type BudgetPeriodId = Brand<string, "BudgetPeriodId">;
export type CheckpointId = Brand<string, "CheckpointId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type AdapterId = Brand<string, "AdapterId">;

/** Instant persisté en UTC, format ISO 8601 avec suffixe `Z` (SPEC §5.2). */
export type UtcTimestamp = Brand<string, "UtcTimestamp">;

/** Fuseau IANA, par exemple `Europe/Paris`. */
export type IanaTimeZone = Brand<string, "IanaTimeZone">;

/** Durée en millisecondes, entier positif ou nul. */
export type DurationMs = number;

/** Chemin relatif à une racine confinée ; jamais absolu, jamais `..`. */
export type ConfinedRelativePath = Brand<string, "ConfinedRelativePath">;

/** Empreinte SHA-256 en hexadécimal minuscule. */
export type Sha256Hex = Brand<string, "Sha256Hex">;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/** Version de schéma d'un document exportable ou persisté. */
export type SchemaVersion = number;
