/**
 * Seul module de câblage du stockage de la CLI : la base SQLite de contrôle de
 * `dataDir`, via `src/store/` (S3). Le `UnitOfWork` en mémoire (`memory.ts`) reste
 * réservé aux tests.
 */

import fs from "node:fs";
import path from "node:path";
import type { UnitOfWork } from "../../contracts/index.js";
import {
  openStore as openSqliteStore,
  openStoreReadOnly as openSqliteStoreReadOnly,
} from "../../store/index.js";

export type Persistence = "memory" | "sqlite";

/** Stockage câblé dans ce build. */
export const STORE_BACKEND: Persistence = "sqlite";

/** Nom de la base de contrôle dans le dossier de données. */
export const CONTROL_DB_FILE = "control.sqlite";

/**
 * `write` : crée la base si besoin et applique les migrations (`init`).
 * `read` : consultation ; n'ouvre qu'une base existante, en lecture seule, sans migrer.
 */
export type StoreAccess = "read" | "write";

export interface Store {
  readonly uow: UnitOfWork;
  readonly persistence: Persistence;
  /** Dossier de données servi par ce stockage. */
  readonly dataDir: string;
  close(): void;
}

/**
 * Ouvre le stockage du profil situé dans `dataDir` ; seule la base de `dataDir` peut
 * être créée ou modifiée, et seulement en accès `write`. En accès `read`, une base
 * absente donne un stockage SQLite vide en mémoire : aucun fichier n'est créé.
 */
export function openStore(dataDir: string, access: StoreAccess): Store {
  const file = path.join(dataDir, CONTROL_DB_FILE);
  const opened =
    access === "write"
      ? openSqliteStore(file)
      : fs.existsSync(file)
        ? openSqliteStoreReadOnly(file)
        : openSqliteStore(":memory:");
  return {
    uow: opened.uow,
    persistence: "sqlite",
    dataDir,
    close: () => {
      opened.close();
    },
  };
}

export type SqliteProbe =
  | { readonly status: "ok"; readonly driver: string; readonly sqliteVersion: string }
  | { readonly status: "fail"; readonly driver: string; readonly detail: string };

const DRIVER = "better-sqlite3";

/**
 * Vérifie que le pilote SQLite se charge et ouvre une base `:memory:`. Aucun fichier
 * créé, aucun accès réseau.
 */
export async function probeSqliteDriver(): Promise<SqliteProbe> {
  try {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(":memory:");
    try {
      const row = db.prepare("select sqlite_version() as version").get() as
        { version?: unknown } | undefined;
      const version = typeof row?.version === "string" ? row.version : "inconnue";
      return { status: "ok", driver: DRIVER, sqliteVersion: version };
    } finally {
      db.close();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "fail", driver: DRIVER, detail };
  }
}
