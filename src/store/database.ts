/**
 * Ouverture de la base de contrôle : WAL, clés étrangères, attente bornée sur verrou,
 * synchronisation complète, puis migrations.
 */

import Database from "better-sqlite3";
import { migrate } from "./migrations.js";

export type SqliteDatabase = Database.Database;

export interface OpenDatabaseOptions {
  /** Attente maximale sur un verrou d'écriture avant `SQLITE_BUSY`. */
  readonly busyTimeoutMs?: number;
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/**
 * Ouvre (ou crée) la base et applique les migrations manquantes. `synchronous = FULL`
 * en WAL : une transaction validée survit à une coupure d'alimentation, ce qui évite
 * qu'une réservation ou un rapprochement acquitté disparaisse.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): SqliteDatabase {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError(`busyTimeoutMs invalide : ${String(busyTimeoutMs)}`);
  }
  const db = new Database(path, { timeout: busyTimeoutMs });
  try {
    db.pragma(`busy_timeout = ${String(busyTimeoutMs)}`);
    const mode = db.pragma("journal_mode = WAL", { simple: true });
    if (mode !== "wal" && path !== ":memory:") {
      throw new Error(`mode WAL refusé par SQLite (mode obtenu : ${String(mode)})`);
    }
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    if (db.pragma("foreign_keys", { simple: true }) !== 1) {
      throw new Error("impossible d'activer les clés étrangères");
    }
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
