/**
 * Accès en lecture seule partagé par les consultations (`status`, `journal`,
 * `policy show`). Une consultation ne crée jamais le dossier de données ni la base, et
 * n'appelle aucune méthode d'écriture : elle ne peut pas déclencher de session.
 */

import type { UnitOfWork } from "../../contracts/index.js";
import type { CliContext } from "../context.js";
import { inspectDataDir, type DataDir } from "../paths.js";
import type { SqliteDatabase } from "../../store/index.js";
import type { Persistence } from "../store/index.js";

export interface ReadScope {
  readonly uow: UnitOfWork | null;
  readonly persistence: Persistence | null;
  /** Connexion SQLite en lecture seule, si le stockage en expose une. */
  readonly db?: SqliteDatabase;
}

export function withReadStore<T>(
  ctx: CliContext,
  dataDir: DataDir,
  fn: (scope: ReadScope) => T,
): T {
  if (inspectDataDir(dataDir.path).status !== "ok") return fn({ uow: null, persistence: null });
  const store = ctx.openStore(dataDir.path, "read");
  try {
    return fn({
      uow: store.uow,
      persistence: store.persistence,
      ...(store.db === undefined ? {} : { db: store.db }),
    });
  } finally {
    store.close();
  }
}

export const NO_PROFILE_HINT =
  "aucun profil : lancer `mind-wake init` pour préparer un profil désactivé";
