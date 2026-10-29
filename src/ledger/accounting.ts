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

/**
 * Qualifiant d'une quantité : devise pour la monnaie, fenêtre de quota pour
 * `provider_quota_bp`, chaîne vide sinon. Deux qualifiants ne s'additionnent jamais.
 */
export function quantityQualifier(quantity: BudgetQuantity): string {
  switch (quantity.unit) {
    case "money":
      return quantity.currency;
    case "provider_quota_bp":
      return quantity.windowKey;
    case "tokens":
    case "sessions":
    case "duration_ms":
      return "";
  }
}

export function isQualifiedUnit(unit: BudgetUnit): boolean {
  return unit === "money" || unit === "provider_quota_bp";
}

export function makeQuantity(unit: BudgetUnit, amount: number, qualifier: string): BudgetQuantity {
  switch (unit) {
    case "money":
      return { unit, amountMinor: amount, currency: qualifier };
    case "provider_quota_bp":
      return { unit, amount, windowKey: qualifier };
    case "tokens":
    case "sessions":
    case "duration_ms":
      return { unit, amount };
  }
}

const CURRENCY = /^[A-Z]{3}$/;

export function assertCurrency(currency: CurrencyCode): void {
  if (typeof currency !== "string" || !CURRENCY.test(currency)) {
    throw new RangeError(`devise ISO 4217 invalide : ${JSON.stringify(currency)}`);
  }
}

const WINDOW_KEY = /^[!-~]{1,128}$/;

/** Clé de fenêtre fournisseur : 1 à 128 caractères ASCII visibles. */
export function assertWindowKey(windowKey: string): void {
  if (typeof windowKey !== "string" || !WINDOW_KEY.test(windowKey)) {
    throw new RangeError(`clé de fenêtre de quota invalide : ${JSON.stringify(windowKey)}`);
  }
}

/** Entier sûr positif ou nul : refuse négatifs, décimaux, NaN, Infinity et non-nombres. */
export function assertAmount(amount: number, label: string): void {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
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
  if (quantity.unit === "provider_quota_bp") assertWindowKey(quantity.windowKey);
}

/** Clé d'agrégation : une unité et son qualifiant. Jamais de conversion. */
export function unitKey(unit: BudgetUnit, qualifier: string): string {
  return `${unit}:${qualifier}`;
}

export interface Charge {
  readonly unit: BudgetUnit;
  readonly qualifier: string;
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
    qualifier: string;
    bound: number;
    reported: number;
    provenances: Set<UsageProvenance>;
  }
  const buckets = new Map<string, Bucket>();
  const bucketFor = (unit: BudgetUnit, qualifier: string): Bucket => {
    const key = unitKey(unit, qualifier);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { unit, qualifier, bound: 0, reported: 0, provenances: new Set() };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  for (const quantity of maxima) {
    bucketFor(quantity.unit, quantityQualifier(quantity)).bound += quantityAmount(quantity);
  }
  for (const record of usage) {
    const bucket = bucketFor(record.quantity.unit, quantityQualifier(record.quantity));
    bucket.reported += quantityAmount(record.quantity);
    bucket.provenances.add(record.provenance);
  }

  const charges: Charge[] = [];
  for (const bucket of buckets.values()) {
    const { unit, qualifier, bound, reported, provenances } = bucket;
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
    charges.push({ unit, qualifier, amount, provenance });
  }
  return charges;
}
