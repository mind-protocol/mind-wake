/**
 * Backoff borné après erreur ou limitation (SPEC §5.2). Fonctions pures : l'état
 * résultant est persisté par le scheduler en UTC.
 * - Limitation fournisseur : attendre au moins le délai officiel s'il est fourni, sinon
 *   le backoff exponentiel. Le plafond `maxDelayMs` ne raccourcit jamais un délai officiel.
 * - Erreur transitoire : backoff exponentiel `baseDelayMs × 2^(n−1)`, plafonné.
 * - Échec d'authentification, incompatibilité ou erreur fatale : blocage immédiat.
 * - Au-delà de `maxConsecutiveFailures` échecs consécutifs : blocage.
 * Aucun changement de compte ni de fournisseur pour contourner l'attente.
 */

import type { DurationMs } from "../contracts/index.js";

export interface BackoffPolicy {
  readonly baseDelayMs: DurationMs;
  readonly maxDelayMs: DurationMs;
  /** Nombre d'échecs consécutifs tolérés ; le suivant bloque le profil. */
  readonly maxConsecutiveFailures: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseDelayMs: 60_000,
  maxDelayMs: 3_600_000,
  maxConsecutiveFailures: 5,
};

/** Échec rapporté pour une session, tel que vu par le scheduler. */
export type SessionFailure =
  | { readonly kind: "rate_limited"; readonly retryAfterMs: DurationMs | null }
  | {
      readonly kind: "transient" | "auth_failed" | "incompatible" | "fatal";
      readonly detail: string;
    };

export type BackoffDecision =
  | {
      readonly action: "wait";
      readonly consecutiveFailures: number;
      readonly delayMs: DurationMs;
      readonly detail: string;
    }
  | { readonly action: "block"; readonly consecutiveFailures: number; readonly detail: string };

export function assertBackoffPolicy(policy: BackoffPolicy): void {
  const { baseDelayMs, maxDelayMs, maxConsecutiveFailures } = policy;
  if (
    !Number.isSafeInteger(baseDelayMs) ||
    baseDelayMs <= 0 ||
    !Number.isSafeInteger(maxDelayMs) ||
    maxDelayMs < baseDelayMs ||
    !Number.isSafeInteger(maxConsecutiveFailures) ||
    maxConsecutiveFailures < 1
  ) {
    throw new RangeError(`politique de backoff invalide : ${JSON.stringify(policy)}`);
  }
}

/** Délai exponentiel plafonné pour le `n`-ième échec consécutif (n ≥ 1). */
export function exponentialDelay(policy: BackoffPolicy, failures: number): DurationMs {
  const exponent = Math.min(Math.max(failures - 1, 0), 30);
  return Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
}

/** Décision après un échec, à partir du nombre d'échecs consécutifs déjà enregistrés. */
export function decideAfterFailure(
  policy: BackoffPolicy,
  previousFailures: number,
  failure: SessionFailure,
): BackoffDecision {
  const failures = previousFailures + 1;
  switch (failure.kind) {
    case "auth_failed":
    case "incompatible":
    case "fatal":
      return {
        action: "block",
        consecutiveFailures: failures,
        detail: `failure.${failure.kind}`,
      };
    case "rate_limited":
    case "transient":
      break;
  }
  if (failures > policy.maxConsecutiveFailures) {
    return {
      action: "block",
      consecutiveFailures: failures,
      detail: `failure.max_consecutive_reached: ${String(failures)}`,
    };
  }
  const computed = exponentialDelay(policy, failures);
  if (failure.kind === "rate_limited") {
    const official = failure.retryAfterMs;
    if (official !== null && Number.isSafeInteger(official) && official >= 0) {
      return {
        action: "wait",
        consecutiveFailures: failures,
        delayMs: Math.max(official, computed),
        detail: `rate_limited.retry_after_ms=${String(official)}`,
      };
    }
    return {
      action: "wait",
      consecutiveFailures: failures,
      delayMs: computed,
      detail: "rate_limited.no_official_delay",
    };
  }
  return {
    action: "wait",
    consecutiveFailures: failures,
    delayMs: computed,
    detail: "failure.transient",
  };
}
