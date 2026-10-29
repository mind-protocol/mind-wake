/** Utilitaires SQLite internes au dépôt. */

import type { SqliteDatabase } from "./database.js";

/**
 * Exécute `fn` dans une transaction `BEGIN IMMEDIATE` (ou un savepoint si une
 * transaction est déjà ouverte). Le verrou d'écriture est pris dès le début : une
 * lecture suivie d'une écriture ne peut pas être devancée par une autre connexion.
 */
export function immediate<T>(db: SqliteDatabase, fn: () => T): T {
  return db.transaction(fn).immediate();
}

/** `null` SQL vers propriété facultative absente (`exactOptionalPropertyTypes`). */
export function optional<K extends string, V>(
  key: K,
  value: V | null | undefined,
): { [P in K]?: V } {
  return (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
