/**
 * Policy : groupes de SPEC §4, révisions immuables, consentements, décisions.
 * Une révision n'est jamais modifiée : toute évolution crée une nouvelle révision.
 */

import type { BudgetPeriodDefinition, CurrencyCode } from "./budget.js";
import type {
  AdapterId,
  AgentId,
  ConfinedRelativePath,
  ConsentId,
  DurationMs,
  IanaTimeZone,
  PolicyRevisionId,
  ProfileId,
  SchemaVersion,
  UtcTimestamp,
} from "./common.js";

export const POLICY_SCHEMA_VERSION: SchemaVersion = 1;

export interface IdentityGroup {
  readonly profileId: ProfileId;
  readonly agentId: AgentId;
}

/** Runtime autorisé ; aucune substitution automatique d'adapter, de fournisseur ou de modèle. */
export interface RuntimeGroup {
  readonly adapterId: AdapterId;
  readonly provider: string;
  readonly model: string;
  /** Mode d'authentification officiel retenu par l'adapter ; jamais un secret. */
  readonly authMode: string;
}

/** Fenêtre hebdomadaire évaluée dans le fuseau de la policy. Heures au format `HH:MM`. */
export interface WeeklyWindow {
  readonly day: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  readonly start: string;
  readonly end: string;
}

export interface ScheduleGroup {
  readonly timeZone: IanaTimeZone;
  readonly weeklyWindows: readonly WeeklyWindow[];
  readonly minIntervalBetweenSessionsMs: DurationMs;
  readonly maxSessionDurationMs: DurationMs;
}

export interface HumanPriorityGroup {
  /** Identifiant d'un signal d'activité validé ; aucune capture du contenu des applications. */
  readonly activitySignal: string;
  readonly idleThresholdMs: DurationMs;
  /** Âge maximal du signal : au-delà, la condition est inconnue donc défavorable. */
  readonly maxSignalAgeMs: DurationMs;
  readonly maxInterruptLatencyMs: DurationMs;
  readonly maxTerminationLatencyMs: DurationMs;
}

/** API payante : absente par défaut, sinon fournisseur, devise et plafonds explicites. */
export type PaidApiAllowance =
  | { readonly authorized: false }
  | {
      readonly authorized: true;
      readonly provider: string;
      readonly currency: CurrencyCode;
      readonly perSessionCapMinor: number;
      readonly perPeriodCapMinor: number;
    };

export interface BudgetGroup {
  readonly period: BudgetPeriodDefinition;
  readonly tokensPerSession: number;
  readonly tokensPerPeriod: number;
  readonly sessionsPerPeriod: number;
  /** Tokens laissés à l'humain dans chaque période, jamais réservables par Wake. */
  readonly userReserveTokens: number;
  /** Tokens réservés dans chaque session pour le checkpoint final. */
  readonly checkpointTokens: number;
  readonly paidApi: PaidApiAllowance;
}

export interface FilesAndToolsGroup {
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly allowedExecutables: readonly string[];
  readonly maxProcesses: number;
  readonly maxStorageBytes: number;
}

export interface NetworkDestination {
  readonly host: string;
  readonly ports: readonly number[];
  readonly purpose: string;
}

/** Réseau refusé par défaut ; transport fournisseur distinct du réseau d'exploration. */
export interface NetworkGroup {
  readonly explorationDestinations: readonly NetworkDestination[];
  readonly providerTransportDestinations: readonly NetworkDestination[];
}

export interface DataGroup {
  readonly eventRetentionDays: number;
  readonly localStorageCapBytes: number;
  readonly purge: "manual" | "retention_only";
  /** Chemins d'export choisis par l'humain. */
  readonly exportPaths: readonly string[];
}

export interface PolicyGroups {
  readonly identity: IdentityGroup;
  readonly runtime: RuntimeGroup;
  readonly schedule: ScheduleGroup;
  readonly humanPriority: HumanPriorityGroup;
  readonly budget: BudgetGroup;
  readonly filesAndTools: FilesAndToolsGroup;
  readonly network: NetworkGroup;
  readonly data: DataGroup;
}

/** Chemin `groupe.champ` d'un champ de `PolicyGroups`. */
export type PolicyFieldPath = {
  [G in keyof PolicyGroups]: `${G}.${keyof PolicyGroups[G] & string}`;
}[keyof PolicyGroups];

/**
 * Champs de limite obligatoires : l'absence de l'un d'eux dans un brouillon interdit
 * l'activation (SPEC §4). Chemins en notation pointée sur `PolicyGroups`.
 */
export const REQUIRED_LIMIT_FIELDS = [
  "runtime.adapterId",
  "runtime.provider",
  "runtime.model",
  "runtime.authMode",
  "schedule.timeZone",
  "schedule.weeklyWindows",
  "schedule.minIntervalBetweenSessionsMs",
  "schedule.maxSessionDurationMs",
  "humanPriority.activitySignal",
  "humanPriority.idleThresholdMs",
  "humanPriority.maxSignalAgeMs",
  "humanPriority.maxInterruptLatencyMs",
  "humanPriority.maxTerminationLatencyMs",
  "budget.period",
  "budget.tokensPerSession",
  "budget.tokensPerPeriod",
  "budget.sessionsPerPeriod",
  "budget.userReserveTokens",
  "budget.checkpointTokens",
  "budget.paidApi",
  "filesAndTools.maxProcesses",
  "filesAndTools.maxStorageBytes",
  "data.eventRetentionDays",
  "data.localStorageCapBytes",
] as const satisfies readonly PolicyFieldPath[];

export type RequiredLimitField = (typeof REQUIRED_LIMIT_FIELDS)[number];

type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly U[]
  : T extends object
    ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Brouillon préparé par `policy configure` ou par la skill ; jamais applicable tel quel. */
export type PolicyDraft = DeepPartial<PolicyGroups>;

/** Révision immuable, complète, reliée à la révision qu'elle remplace. */
export interface PolicyRevision {
  readonly schemaVersion: SchemaVersion;
  readonly id: PolicyRevisionId;
  readonly profileId: ProfileId;
  readonly previousRevisionId: PolicyRevisionId | null;
  readonly createdAt: UtcTimestamp;
  readonly groups: PolicyGroups;
}

/**
 * Nature d'une révision par rapport à la précédente : une restriction s'applique
 * immédiatement, un élargissement exige une nouvelle autorisation humaine.
 */
export type PolicyChangeKind = "initial" | "restriction" | "widening" | "mixed";

/**
 * Consentement humain local. Seul le canal utilisateur de confiance peut le créer ;
 * une auto-déclaration du modèle n'en est pas un.
 */
export interface PolicyConsent {
  readonly id: ConsentId;
  readonly revisionId: PolicyRevisionId;
  readonly grantedAt: UtcTimestamp;
  readonly channel: "local_cli";
  /** Référence de preuve locale (par exemple saisie de confirmation journalisée). */
  readonly proof: string;
}

export interface PermissionRevocation {
  readonly revisionId: PolicyRevisionId;
  readonly revokedAt: UtcTimestamp;
  readonly reason: string;
}

/** Action soumise au policy engine avant le lancement ou pendant une session. */
export type ControlledAction =
  | { readonly kind: "launch_session" }
  | { readonly kind: "file_read"; readonly path: ConfinedRelativePath }
  | { readonly kind: "file_write"; readonly path: ConfinedRelativePath }
  | { readonly kind: "exec_tool"; readonly executable: string }
  | { readonly kind: "network"; readonly host: string; readonly port: number }
  | { readonly kind: "publish_checkpoint" }
  | {
      readonly kind: "spend";
      readonly provider: string;
      readonly amountMinor: number;
      readonly currency: CurrencyCode;
    };

export const DENY_REASONS = [
  "missing_limit",
  "not_consented",
  "revoked",
  "permission_not_granted",
  "outside_window",
  "user_priority",
  "paused",
  "stopped",
  "budget_exhausted",
  "budget_unknown",
  "bound_not_enforceable",
  "adapter_incompatible",
  "sandbox_unavailable",
  "backoff_active",
  "session_already_active",
  "unknown_condition",
] as const;

export type DenyReason = (typeof DENY_REASONS)[number];

/** Décision du policy engine : accord ou refus, toujours avec motif. */
export type PolicyDecision =
  | {
      readonly verdict: "allow";
      readonly revisionId: PolicyRevisionId;
      readonly reason: string;
    }
  | {
      readonly verdict: "deny";
      readonly revisionId: PolicyRevisionId | null;
      readonly reason: DenyReason;
      readonly detail: string;
    };
