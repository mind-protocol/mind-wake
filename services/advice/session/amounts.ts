/**
 * Montants en unités fictives : entiers exacts (`bigint`), jamais de `number` flottant
 * (TRANSACTIONS §2.9, §6). Sérialisés comme chaînes décimales canoniques.
 *
 * Ces unités sont SIMULÉES : elles ne représentent ni un token, ni une monnaie, ni un
 * droit sur des fonds réels.
 */

/** Montant atomique fictif, entier positif ou nul. */
export type FictiveAmount = bigint;

/** Borne haute de tout montant manipulé : refuse les débordements silencieux. */
export const MAX_FICTIVE_AMOUNT: FictiveAmount = 10n ** 30n - 1n;

const CANONICAL_DECIMAL = /^(0|[1-9][0-9]{0,29})$/;
const SIGNED_DECIMAL = /^-?(0|[1-9][0-9]{0,30})$/;

export class AmountError extends RangeError {
  override readonly name = "AmountError";
}

/**
 * Lit un montant fourni de l'extérieur. Seules une chaîne décimale canonique ou une
 * valeur `bigint` sont acceptées : `number`, décimales, exposants, signes, espaces et
 * zéros non significatifs sont refusés.
 */
export function parseAmount(value: unknown, field = "montant"): FictiveAmount {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "string" && CANONICAL_DECIMAL.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new AmountError(
      `${field} invalide : entier décimal canonique attendu (chaîne ou bigint), reçu ${describe(value)}`,
    );
  }
  return checkBounds(parsed, field);
}

export function checkBounds(value: bigint, field = "montant"): FictiveAmount {
  if (value < 0n) throw new AmountError(`${field} négatif refusé`);
  if (value > MAX_FICTIVE_AMOUNT) throw new AmountError(`${field} hors bornes`);
  return value;
}

/** Produit borné : un dépassement est refusé, jamais tronqué. */
export function multiplyAmount(unit: FictiveAmount, count: number, field = "produit"): bigint {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new AmountError(`${field} : multiplicateur entier positif attendu`);
  }
  return checkBounds(checkBounds(unit, field) * BigInt(count), field);
}

export function formatAmount(value: FictiveAmount): string {
  return checkBounds(value).toString(10);
}

/** Montant signé d'une ligne comptable (débit négatif, crédit positif). */
export function formatSigned(value: bigint): string {
  return value.toString(10);
}

export function parseSigned(value: string): bigint {
  if (!SIGNED_DECIMAL.test(value) || value === "-0") {
    throw new AmountError(`ligne comptable invalide : ${value}`);
  }
  return BigInt(value);
}

function describe(value: unknown): string {
  if (typeof value === "string") return `« ${value.slice(0, 40)} »`;
  if (typeof value === "number") return `nombre ${String(value)}`;
  return typeof value;
}
