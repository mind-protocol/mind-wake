/**
 * Réveil demandé par l'humain (`mind-wake wake`, bouton « Réveiller » du desktop) : un
 * fichier dans le dossier de données, hors de l'espace d'exploration, donc jamais écrit
 * par l'agent. Comme les demandes de l'agent (`wakeups.ts`), il n'ajoute qu'une
 * **échéance candidate** au scheduler : fenêtres, priorité humaine, pause, arrêt
 * d'urgence, budgets et permissions restent vérifiés par `decideLaunch`. Une demande non
 * servie expire au bout d'une heure ; elle est consommée au lancement d'une session.
 */

import fs from "node:fs";
import path from "node:path";

export const HUMAN_WAKE_FILE = "human-wake-request.json";
export const HUMAN_WAKE_TTL_MS = 3_600_000;

export function humanWakeFileFor(dataDir: string): string {
  return path.join(dataDir, HUMAN_WAKE_FILE);
}

/** Écrit (ou remplace) la demande ; écriture atomique par renommage. */
export function requestHumanWake(dataDir: string, nowMs: number): string {
  const file = humanWakeFileFor(dataDir);
  const at = new Date(nowMs).toISOString();
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, requestedAt: at })}\n`);
  fs.renameSync(tmp, file);
  return at;
}

/** Échéance demandée encore valide, sinon `null` (fichier absent, illisible ou expiré). */
export function pendingHumanWake(dataDir: string, nowMs: number): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(humanWakeFileFor(dataDir), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; requestedAt?: unknown };
    const at = typeof parsed.requestedAt === "string" ? Date.parse(parsed.requestedAt) : NaN;
    if (parsed.version !== 1 || Number.isNaN(at) || nowMs - at > HUMAN_WAKE_TTL_MS) {
      consumeHumanWake(dataDir);
      return null;
    }
    return at;
  } catch {
    consumeHumanWake(dataDir);
    return null;
  }
}

/** Retire la demande (servie, expirée ou illisible). */
export function consumeHumanWake(dataDir: string): void {
  fs.rmSync(humanWakeFileFor(dataDir), { force: true });
}
