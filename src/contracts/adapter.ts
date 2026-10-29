/**
 * Contrat d'adapter runtime (SPEC §8.1), indépendant d'une API fournisseur particulière.
 * Le handle de session ne donne aucun moyen de modifier la policy.
 */

import type { BudgetQuantity, TokenCategory, UsageProvenance } from "./budget.js";
import type { CheckpointCandidate } from "./checkpoint.js";
import type {
  AdapterId,
  ConfinedRelativePath,
  DurationMs,
  ReservationId,
  SessionId,
  UtcTimestamp,
} from "./common.js";
import type { PolicyRevision } from "./policy.js";

export interface ProbeResult {
  readonly adapterId: AdapterId;
  readonly version: string;
  /** Mécanisme d'exécution officiellement autorisé, tel que vérifié (SPEC §12). */
  readonly executionMechanism: string;
  readonly available: boolean;
  /** `true` pour un adapter factice : ses mesures sont toujours `simulated`. */
  readonly simulated: boolean;
  readonly unavailableReason?: string;
}

export interface AdapterCapabilities {
  readonly tokenCounting: "exact" | "estimated" | "none";
  readonly countedCategories: readonly TokenCategory[];
  /**
   * Plafond de tokens imposable sur toute la session. `none` interdit l'exécution
   * autonome (AGENTS §5) ; un timeout seul ne compte pas comme borne.
   */
  readonly tokenCapEnforcement: "native" | "conservative_bound" | "none";
  readonly cancellation: "graceful" | "forced_only" | "none";
  /** Borne de consommation résiduelle après annulation, à inclure dans la réservation. */
  readonly residualUsageBound: BudgetQuantity | null;
  readonly isolationCompatible: boolean;
  readonly userPrioritySignal: boolean;
  readonly resumeModes: readonly ("fresh_process_from_memory" | "native_resume")[];
}

/** Contexte borné transmis au lancement ; aucun credential en clair. */
export interface StartRequest {
  readonly sessionId: SessionId;
  readonly reservationId: ReservationId;
  readonly policy: PolicyRevision;
  readonly context: string;
  readonly maxInputTokens: number;
  readonly deadline: UtcTimestamp;
}

/** Handle opaque côté agent ; seul le runner peut l'utiliser. */
export interface SessionHandle {
  readonly adapterId: AdapterId;
  readonly sessionId: SessionId;
  readonly startedAt: UtcTimestamp;
}

interface AdapterEventBase {
  readonly sessionId: SessionId;
  readonly at: UtcTimestamp;
}

export type AdapterEvent =
  | (AdapterEventBase & { readonly type: "started" })
  | (AdapterEventBase & { readonly type: "activity"; readonly summary: string })
  | (AdapterEventBase & {
      readonly type: "usage";
      readonly quantity: BudgetQuantity;
      readonly provenance: UsageProvenance;
      readonly tokenBreakdown?: Readonly<Partial<Record<TokenCategory, number>>>;
    })
  | (AdapterEventBase & {
      readonly type: "artifact_candidate";
      readonly path: ConfinedRelativePath;
    })
  | (AdapterEventBase & {
      readonly type: "checkpoint_candidate";
      readonly candidate: CheckpointCandidate;
    })
  | (AdapterEventBase & {
      readonly type: "rate_limited";
      /** Délai officiel communiqué par le fournisseur, s'il existe. */
      readonly retryAfterMs: DurationMs | null;
    })
  | (AdapterEventBase & {
      readonly type: "error";
      readonly code: "auth_failed" | "incompatible" | "transient" | "fatal";
      readonly message: string;
    })
  | (AdapterEventBase & { readonly type: "ended"; readonly exitReason: string });

export type CancelResult =
  | { readonly status: "cancelled"; readonly within: DurationMs }
  | { readonly status: "forced"; readonly within: DurationMs }
  | { readonly status: "unconfirmed"; readonly detail: string };

/** Rapprochement : fin et consommation confirmées, ou incertitude déclarée. */
export type ReconcileResult =
  | {
      readonly status: "confirmed";
      readonly ended: true;
      readonly usage: readonly BudgetQuantity[];
      readonly provenance: Exclude<UsageProvenance, "unknown">;
    }
  | { readonly status: "uncertain"; readonly detail: string };

export interface RuntimeAdapter {
  readonly id: AdapterId;
  probe(): Promise<ProbeResult>;
  capabilities(): Promise<AdapterCapabilities>;
  start(request: StartRequest): Promise<SessionHandle>;
  events(handle: SessionHandle): AsyncIterable<AdapterEvent>;
  cancel(handle: SessionHandle, timeoutMs: DurationMs): Promise<CancelResult>;
  reconcile(sessionId: SessionId): Promise<ReconcileResult>;
}
