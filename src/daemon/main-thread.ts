/**
 * Fil principal On/Off (vue d'ensemble). Off : le scheduler ne lance plus aucun réveil
 * de la session principale ; une session déjà en cours termine normalement. Forks,
 * second fil, coach et réponse rapide gardent leurs propres réglages ; pause et
 * Force-off restent appliqués. Rien n'est effacé : historique et conversation restent.
 *
 * Réglage `main-thread.json` ; absent ou illisible : On (comportement d'avant).
 */
import fs from "node:fs";
import path from "node:path";

export const MAIN_THREAD_CONFIG = "main-thread.json";

export interface MainThreadSetting {
  readonly enabled: boolean;
  readonly updatedAt: string | null;
}

export function readMainThread(dataDir: string): MainThreadSetting {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, MAIN_THREAD_CONFIG), "utf8")) as {
      enabled?: unknown;
      updatedAt?: unknown;
    };
    return {
      enabled: data.enabled !== false,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
    };
  } catch {
    return { enabled: true, updatedAt: null };
  }
}

export function mainThreadEnabled(dataDir: string): boolean {
  return readMainThread(dataDir).enabled;
}

export function saveMainThreadEnabled(dataDir: string, enabled: boolean, now = new Date()): void {
  const file = path.join(dataDir, MAIN_THREAD_CONFIG),
    tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ version: 1, enabled, updatedAt: now.toISOString() }) + "\n",
  );
  fs.renameSync(tmp, file);
}
