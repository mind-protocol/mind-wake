/**
 * Accès en écriture partagé par les contrôles humains (`pause`, `resume`, `stop`). Un
 * profil absent n'est jamais créé : la base n'est ouverte en écriture que si une
 * consultation en lecture seule y a trouvé le profil.
 */

import type { UnitOfWork } from "../../contracts/index.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import type { DataDir } from "../paths.js";
import { withReadStore } from "./read.js";

export function withControlStore<T>(
  ctx: CliContext,
  dataDir: DataDir,
  fn: (uow: UnitOfWork) => T,
): T | null {
  const exists = withReadStore(
    ctx,
    dataDir,
    ({ uow }) => (uow?.profiles.get(DEFAULT_PROFILE_ID) ?? null) !== null,
  );
  if (!exists) return null;
  const store = ctx.openStore(dataDir.path, "write");
  try {
    return fn(store.uow);
  } finally {
    store.close();
  }
}
