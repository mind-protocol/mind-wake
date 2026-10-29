/**
 * Emplacements du daemon dans le dossier de données. L'espace d'exploration
 * (`workspace/`) est séparé de la base de contrôle ; les artefacts ont leur racine
 * dédiée, seule considérée par la réconciliation des artefacts (S8).
 */

import path from "node:path";

/** Base de contrôle, partagée avec la CLI (`src/cli/store/index.ts`). */
export const CONTROL_DB_FILE = "control.sqlite";

export function controlDbPath(dataDir: string): string {
  return path.join(dataDir, CONTROL_DB_FILE);
}

/** Espace d'exploration : racine des chemins relatifs de la policy (`writeRoots`…). */
export function workspaceDirFor(dataDir: string): string {
  return path.join(dataDir, "workspace");
}

/** Préfixe, relatif à l'espace d'exploration, de la racine d'artefacts. */
export const ARTIFACTS_SEGMENT = "artifacts";

export function artifactsDirFor(dataDir: string): string {
  return path.join(workspaceDirFor(dataDir), ARTIFACTS_SEGMENT);
}

/**
 * Signal d'activité utilisateur SIMULÉ : la présence du fichier vaut « l'humain est
 * actif ». Écrit par l'humain ou le banc de démonstration, jamais par l'agent (il est
 * hors de l'espace d'exploration). Remplacé par `GetLastInputInfo` en mode réel.
 */
export function simulatedActivityFlagFor(dataDir: string): string {
  return path.join(dataDir, "simulated-user-activity");
}
