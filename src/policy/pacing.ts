/**
 * Pilotage de la voie abonnement (ADR-005, complément « cible juste au-dessus de 99 % ») :
 * Wake vise `targetUsageBasisPoints` d'usage à la remise à zéro de la fenêtre qui se
 * remet à zéro le plus tôt, puisque le quota non utilisé est perdu. Tout est en points de
 * base d'une fenêtre fournisseur ; rien n'est jamais converti en tokens.
 *
 * `restant = cible − usage`, `temps nécessaire = restant / débit`, réveil quand
 * `temps avant remise à zéro ≤ temps nécessaire × (1 + marge)`. Le débit est mesuré
 * pendant les sessions (moyenne glissante par runtime et par fenêtre), sinon la valeur
 * initiale prudente de la policy. Code pur : aucune lecture, aucune écriture.
 */

import type { ProviderQuotaSnapshot } from "../contracts/budget.js";
import type { SubscriptionQuotaGuard } from "../contracts/policy.js";
import { BASIS_POINTS_MAX } from "./validate.js";

export const HOUR_MS = 3_600_000;

/** Estimation persistée pour une fenêtre (débit mesuré et marge ajustée). */
export interface PacingEstimate {
  readonly windowKey: string;
  /** Points de base par heure de session continue ; `null` avant toute mesure. */
  readonly rateBasisPointsPerHour: number | null;
  readonly marginRatio: number;
  readonly samples: number;
}

export interface PacingPlan {
  /** Fenêtre pilotée : celle qui se remet à zéro le plus tôt. */
  readonly windowKey: string;
  readonly usedBasisPoints: number;
  readonly targetBasisPoints: number;
  readonly remainingBasisPoints: number;
  readonly rateBasisPointsPerHour: number;
  readonly rateSource: "measured" | "initial";
  readonly marginRatio: number;
  readonly resetsAtMs: number;
  /** Temps de session continue nécessaire pour atteindre la cible. */
  readonly neededMs: number;
  /** Instant de réveil : remise à zéro − temps nécessaire × (1 + marge). */
  readonly wakeAtMs: number;
  readonly due: boolean;
  /** Usage projeté à la remise à zéro si Wake tourne en continu dès maintenant. */
  readonly projectedAtResetBasisPoints: number;
}

type EnabledGuard = Extract<SubscriptionQuotaGuard, { enabled: true }>;

/** Plan de pilotage, ou `null` sans lecture mesurée d'une fenêtre encore ouverte. */
export function planPacing(
  guard: EnabledGuard,
  snapshots: readonly ProviderQuotaSnapshot[],
  nowMs: number,
  estimates: readonly PacingEstimate[] = [],
): PacingPlan | null {
  const open = snapshots
    .filter((s) => s.provenance === "measured")
    .map((s) => ({ s, resetsAtMs: Date.parse(s.resetsAt) }))
    .filter((w) => Number.isFinite(w.resetsAtMs) && w.resetsAtMs > nowMs)
    .sort((a, b) => a.resetsAtMs - b.resetsAtMs);
  const piloted = open[0];
  if (piloted === undefined) return null;
  const estimate = estimates.find((e) => e.windowKey === piloted.s.windowKey);
  const measured = estimate?.rateBasisPointsPerHour;
  const useMeasured = typeof measured === "number" && Number.isFinite(measured) && measured > 0;
  const rate = useMeasured ? measured : guard.initialRateBasisPointsPerHour;
  const margin =
    estimate !== undefined && Number.isFinite(estimate.marginRatio) && estimate.marginRatio >= 0
      ? estimate.marginRatio
      : guard.pacingMarginRatio;
  const target = guard.targetUsageBasisPoints;
  const used = piloted.s.usedBasisPoints;
  const remaining = Math.max(0, target - used);
  const neededMs = (remaining / rate) * HOUR_MS;
  const wakeAtMs = piloted.resetsAtMs - neededMs * (1 + margin);
  const projected = Math.min(
    BASIS_POINTS_MAX,
    Math.round(used + (rate * (piloted.resetsAtMs - nowMs)) / HOUR_MS),
  );
  return {
    windowKey: piloted.s.windowKey,
    usedBasisPoints: used,
    targetBasisPoints: target,
    remainingBasisPoints: remaining,
    rateBasisPointsPerHour: rate,
    rateSource: useMeasured ? "measured" : "initial",
    marginRatio: margin,
    resetsAtMs: piloted.resetsAtMs,
    neededMs,
    wakeAtMs,
    due: remaining > 0 && nowMs >= wakeAtMs,
    projectedAtResetBasisPoints: projected,
  };
}

/** Détail journalisable d'un plan (projection comprise). */
export function pacingDetail(plan: PacingPlan): string {
  return [
    plan.windowKey,
    `used_bp=${String(plan.usedBasisPoints)}`,
    `target_bp=${String(plan.targetBasisPoints)}`,
    `rate_bp_h=${plan.rateBasisPointsPerHour.toFixed(1)}(${plan.rateSource})`,
    `margin=${plan.marginRatio.toFixed(2)}`,
    `needed_ms=${String(Math.round(plan.neededMs))}`,
    `wake_at=${new Date(Math.round(plan.wakeAtMs)).toISOString()}`,
    `projected_bp=${String(plan.projectedAtResetBasisPoints)}`,
  ].join(" ");
}

/** Mise à jour de la moyenne glissante du débit (poids de la nouvelle mesure). */
export const RATE_SMOOTHING = 0.3;

export function smoothRate(previous: number | null, measured: number): number {
  return previous === null ? measured : previous * (1 - RATE_SMOOTHING) + measured * RATE_SMOOTHING;
}

/** Bornes et pas d'ajustement de la marge entre deux fenêtres. */
export const MARGIN_MIN = 0.05;
export const MARGIN_MAX = 3;
export const MARGIN_INCREASE = 1.5;
export const MARGIN_DECREASE = 0.8;
/** Tolérance sous la cible avant de juger la fenêtre manquée. */
export const MISS_TOLERANCE_BP = 50;
/** Cible atteinte plus tôt que ce délai avant la remise à zéro : marge réduite. */
export const EARLY_REACH_MS = HOUR_MS;

/**
 * Ajustement de la marge à la fin d'une fenêtre : sous la cible → plus de marge (réveils
 * plus tôt) ; cible atteinte trop tôt → moins de marge ; sinon inchangée.
 */
export function adjustMargin(
  margin: number,
  finalUsedBasisPoints: number,
  targetBasisPoints: number,
  reachedAtMs: number | null,
  resetsAtMs: number,
): { readonly margin: number; readonly change: "increased" | "decreased" | "kept" } {
  if (finalUsedBasisPoints < targetBasisPoints - MISS_TOLERANCE_BP) {
    return {
      margin: Math.min(MARGIN_MAX, Math.max(margin, MARGIN_MIN) * MARGIN_INCREASE),
      change: "increased",
    };
  }
  if (reachedAtMs !== null && resetsAtMs - reachedAtMs > EARLY_REACH_MS) {
    return { margin: Math.max(MARGIN_MIN, margin * MARGIN_DECREASE), change: "decreased" };
  }
  return { margin, change: "kept" };
}
