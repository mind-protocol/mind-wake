/**
 * Plafonds autorisés par la policy (SPEC §4, §6). Le ledger n'accepte pas les plafonds
 * d'un appelant sur parole : chaque `PeriodLimit` est borné par la révision consentie
 * et effective du profil, elle-même restreinte par toute révision ultérieure non encore
 * consentie (une restriction s'applique sans attendre ; un élargissement, jamais).
 *
 * Aucune borne n'est dérivée d'une jauge de quota fournisseur : pour
 * `provider_quota_bp`, seuls les seuils consentis de `SubscriptionQuotaGuard` comptent,
 * et un dépassement non mesuré (`overshootBoundBasisPoints: null`) n'autorise rien.
 */

import type {
  BudgetGroup,
  BudgetPeriodDefinition,
  BudgetUnit,
  PolicyGroups,
} from "../contracts/index.js";
import { DEFAULT_WEEK_STARTS_ON } from "./periods.js";

export interface UnitCeiling {
  /** Plafond maximal autorisé pour la période. */
  readonly cap: number;
  /** Réserve humaine minimale à conserver. */
  readonly minUserReserve: number;
}

export interface AuthorizedCeiling {
  readonly definition: BudgetPeriodDefinition;
  readonly tokens: UnitCeiling;
  readonly sessions: UnitCeiling;
  readonly durationMs: UnitCeiling;
  /** `null` : aucune API payante autorisée. */
  readonly money: (UnitCeiling & { readonly currency: string }) | null;
  /** `null` : voie abonnement désactivée ou dépassement non mesuré. Vaut pour toute fenêtre. */
  readonly providerQuota: UnitCeiling | null;
}

const NOTHING: UnitCeiling = { cap: 0, minUserReserve: 0 };

function moneyCeiling(budget: BudgetGroup): AuthorizedCeiling["money"] {
  const paid = budget.paidApi;
  return paid.authorized
    ? { cap: paid.perPeriodCapMinor, minUserReserve: 0, currency: paid.currency }
    : null;
}

function providerQuotaCeiling(budget: BudgetGroup): UnitCeiling | null {
  const guard = budget.subscriptionQuota;
  if (guard?.enabled !== true || guard.overshootBoundBasisPoints === null) return null;
  return { cap: guard.stopAtBasisPoints + guard.overshootBoundBasisPoints, minUserReserve: 0 };
}

/** Plafonds qu'une révision autorise par période. */
export function ceilingFromPolicy(groups: PolicyGroups): AuthorizedCeiling {
  const { budget, schedule } = groups;
  return {
    definition: budget.period,
    tokens: { cap: budget.tokensPerPeriod, minUserReserve: budget.userReserveTokens },
    sessions: { cap: budget.sessionsPerPeriod, minUserReserve: 0 },
    // Pas de champ dédié : borne déduite des plafonds consentis de nombre et de durée.
    durationMs: {
      cap: budget.sessionsPerPeriod * schedule.maxSessionDurationMs,
      minUserReserve: 0,
    },
    money: moneyCeiling(budget),
    providerQuota: providerQuotaCeiling(budget),
  };
}

function tighter(a: UnitCeiling, b: UnitCeiling): UnitCeiling {
  return {
    cap: Math.min(a.cap, b.cap),
    minUserReserve: Math.max(a.minUserReserve, b.minUserReserve),
  };
}

/** Plafonds de `effective`, restreints par une révision ultérieure non consentie. */
export function restrictCeiling(
  effective: AuthorizedCeiling,
  later: AuthorizedCeiling,
): AuthorizedCeiling {
  const money =
    effective.money === null ||
    later.money === null ||
    effective.money.currency !== later.money.currency
      ? null
      : { ...tighter(effective.money, later.money), currency: effective.money.currency };
  const providerQuota =
    effective.providerQuota === null || later.providerQuota === null
      ? null
      : tighter(effective.providerQuota, later.providerQuota);
  return {
    definition: effective.definition,
    tokens: tighter(effective.tokens, later.tokens),
    sessions: tighter(effective.sessions, later.sessions),
    durationMs: tighter(effective.durationMs, later.durationMs),
    money,
    providerQuota,
  };
}

/**
 * Plafond autorisé pour une unité et son qualifiant. Une unité non autorisée (ou une
 * autre devise que celle consentie) reçoit un plafond nul.
 */
export function unitCeiling(
  ceiling: AuthorizedCeiling,
  unit: BudgetUnit,
  qualifier: string,
): UnitCeiling {
  switch (unit) {
    case "tokens":
      return ceiling.tokens;
    case "sessions":
      return ceiling.sessions;
    case "duration_ms":
      return ceiling.durationMs;
    case "money":
      return ceiling.money?.currency === qualifier ? ceiling.money : NOTHING;
    case "provider_quota_bp":
      return ceiling.providerQuota ?? NOTHING;
  }
}

export function sameDefinition(a: BudgetPeriodDefinition, b: BudgetPeriodDefinition): boolean {
  const week = (d: BudgetPeriodDefinition): number =>
    d.kind === "week" ? (d.weekStartsOn ?? DEFAULT_WEEK_STARTS_ON) : -1;
  return a.kind === b.kind && a.timeZone === b.timeZone && week(a) === week(b);
}
