import fs from "node:fs";
import path from "node:path";
/**
 * `on` : réveils planifiés ; `always-on` : réveils enchaînés ; `listening` (« Off à l'écoute »,
 * démarrage de Windows) : aucun réveil autonome, seulement un réveil ciblé quand un message
 * entrant (humain, appel d'un autre PC, demande `wake`) l'exige. Pause et arrêt restent au-dessus.
 */
export type ExecutionMode = "on" | "always-on" | "listening";
const FILE = "execution-mode.json";
export function executionMode(dataDir: string): ExecutionMode {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), "utf8")) as {
      mode?: unknown;
    };
    return data.mode === "always-on" || data.mode === "listening" ? data.mode : "on";
  } catch {
    return "on";
  }
}
/** « Off à l'écoute » : boucles autonomes (principal, rooms, second fil) au repos. */
export function listeningOnly(dataDir: string): boolean {
  return executionMode(dataDir) === "listening";
}
export function saveExecutionMode(dataDir: string, mode: ExecutionMode): void {
  const file = path.join(dataDir, FILE),
    tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ version: 1, mode, updatedAt: new Date().toISOString() }) + "\n",
  );
  fs.renameSync(tmp, file);
}
