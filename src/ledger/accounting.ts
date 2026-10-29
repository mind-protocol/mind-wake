/**
 * Règles pures de comptabilité : clés d'unité, validation des quantités et conversion
 * d'une réservation en consommation au rapprochement (SPEC §6).
 */

import type {
  BudgetQuantity,
  BudgetUnit,
  CurrencyCode,
  UsageProvenance,
  UsageRecord,
} from "../contracts/index.js";
import { BUDGET_UNITS, USAGE_PROVENANCES } from "../contracts/index.js";

/** Montant entier d'une quantité ; la monnaie est en unités mineures. */
export function quantityAmount(quantity: BudgetQuantity): number {
  return quantity.unit === "money" ? quantity.amountMinor : quantity.amount;
}

/** Devise d'une quantité monétaire ; chaîne vide pour les autres unités. */
export function quantityCurrency(quantity: BudgetQuantity): string {
  return quantity.unit === "money" ? quantity.currency : "";
}

export function makeQuantity(unit: BudgetUnit, amount: number, currency: string): BudgetQuantity {
  switch (unit) {
    case "money":
      return { unit, amountMinor: amount, currency };
    case "tokens":
    case "sessions":
    case "duration_ms":
      return { unit, amount };
  }
}

const CURRENCY = /^[A-Z]{3}$/;

export function assertCurrency(currency: CurrencyCode): void {
  if (!CURRENCY.test(currency)) {
    throw new RangeError(`devise ISO 4217 invalide : ${currency}`);
  }
}

export function assertAmount(amount: number, label: string): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new RangeError(`${label} doit être un entier positif ou nul : ${String(amount)}`);
  }
}

export function assertUnit(unit: string): asserts unit is BudgetUnit {
  if (!(BUDGET_UNITS as readonly string[]).includes(unit)) {
    throw new RangeError(`unité de budget inconnue : ${unit}`);
  }
}

export function assertProvenance(provenance: string): asserts provenance is UsageProvenance {
  if (!(USAGE_PROVENANCES as readonly string[]).includes(provenance)) {
    throw new RangeError(`provenance d'usage inconnue : ${provenance}`);
  }
}

export function assertQuantity(quantity: BudgetQuantity): void {
  assertUnit(quantity.unit);
  assertAmount(quantityAmount(quantity), `quantité ${quantity.unit}`);
  if (quantity.unit === "money") assertCurrency(quantity.currency);
}

/** Clé d'agrégation : une unité, et pour la monnaie une devise. Jamais de conversion. */
export function unitKey(unit: BudgetUnit, currency: string): string {
  return `${unit}:${currency}`;
}

export interface Charge {
  readonly unit: BudgetUnit;
  readonly currency: string;
  readonly amount: number;
  readonly provenance: UsageProvenance;
}

/**
 * Consommation imputée au rapprochement, par unité :
 * - usage uniquement mesuré ou simulé : somme rapportée (`simulated` dès qu'une part
 *   l'est, pour que la mention reste visible) ;
 * - usage estimé ou inconnu : borne maximale, ou somme rapportée si elle la dépasse ;
 * - unité réservée sans aucun usage rapporté : borne maximale, provenance `unknown`.
 * Un usage rapporté pour une unité non réservée est imputé tel quel.
 */
export function computeCharges(
  maxima: readonly BudgetQuantity[],
  usage: readonly UsageRecord[],
): readonly Charge[] {
  interface Bucket {
    unit: BudgetUnit;
    currency: string;
    bound: number;
    reported: number;
    provenances: Set<UsageProvenance>;
  }
  const buckets = new Map<string, Bucket>();
  const bucketFor = (unit: BudgetUnit, currency: string): Bucket => {
    const key = unitKey(unit, currency);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { unit, currency, bound: 0, reported: 0, provenances: new Set() };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  for (const quantity of maxima) {
    bucketFor(quantity.unit, quantityCurrency(quantity)).bound += quantityAmount(quantity);
  }
  for (const record of usage) {
    const bucket = bucketFor(record.quantity.unit, quantityCurrency(record.quantity));
    bucket.reported += quantityAmount(record.quantity);
    bucket.provenances.add(record.provenance);
  }

  const charges: Charge[] = [];
  for (const bucket of buckets.values()) {
    const { unit, currency, bound, reported, provenances } = bucket;
    let amount: number;
    let provenance: UsageProvenance;
    if (provenances.size === 0) {
      amount = bound;
      provenance = "unknown";
    } else if (provenances.has("unknown") || provenances.has("estimated")) {
      amount = Math.max(bound, reported);
      provenance = provenances.has("unknown") ? "unknown" : "estimated";
    } else {
      amount = reported;
      provenance = provenances.has("simulated") ? "simulated" : "measured";
    }
    charges.push({ unit, currency, amount, provenance });
  }
  return charges;
}
