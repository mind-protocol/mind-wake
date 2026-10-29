/**
 * Seul module de câblage du stockage de la CLI. Aujourd'hui : `UnitOfWork` en mémoire,
 * non persistant. Après fusion de S3, `openStore` ouvrira la base SQLite de `dataDir`
 * via `src/store/` ; aucun autre fichier de la CLI ne doit changer.
 */

import type { UnitOfWork } from "../../contracts/index.js";
import { MemoryUnitOfWork } from "./memory.js";

export type Persistence = "memory" | "sqlite";

export interface Store {
  readonly uow: UnitOfWork;
  readonly persistence: Persistence;
  /** Dossier de données servi par ce stockage. */
  readonly dataDir: string;
  close(): void;
}

/**
 * Ouvre le stockage du profil situé dans `dataDir`. N'écrit rien tant que S3 n'est pas
 * câblé ; ensuite, seule la base de `dataDir` pourra être créée ou modifiée.
 */
export function openStore(dataDir: string): Store {
  return { uow: new MemoryUnitOfWork(), persistence: "memory", dataDir, close: () => undefined };
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
