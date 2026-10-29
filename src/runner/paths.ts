/** Emplacements du runner dans le dossier de données de contrôle. */

import path from "node:path";

/** Binaires du runner (lanceur Job Object compilé), hors de l'espace d'exploration. */
export function runtimeDirFor(dataDir: string): string {
  return path.join(dataDir, "runtime");
}
