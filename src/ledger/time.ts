/**
 * Horodatages UTC canoniques. Toutes les dates persistées ont le format produit par
 * `Date.prototype.toISOString` (`YYYY-MM-DDTHH:mm:ss.sssZ`), ce qui rend leur
 * comparaison lexicographique équivalente à la comparaison chronologique.
 */

import type { UtcTimestamp } from "../contracts/index.js";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function toUtcTimestamp(ms: number): UtcTimestamp {
  return new Date(ms).toISOString() as UtcTimestamp;
}

/** Lit un instant UTC ; refuse tout autre format (fuseau local, décalage, texte libre). */
export function parseUtcTimestamp(value: string): number {
  if (!ISO_UTC.test(value)) {
    throw new RangeError(`horodatage UTC invalide : ${value}`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new RangeError(`horodatage UTC invalide : ${value}`);
  }
  return ms;
}

export function normalizeUtcTimestamp(value: string): UtcTimestamp {
  return toUtcTimestamp(parseUtcTimestamp(value));
}
