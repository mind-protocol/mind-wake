/**
 * Lancement des processus séparés de la démo (guest, adaptateur MCP du guide) : sources
 * TypeScript exécutées par le type stripping natif de Node, avec les hooks de résolution
 * déjà utilisés par G1 et G2.
 */

import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const CONVERSATION_DIR = join(ROOT, "services/advice/conversation");
const HOOKS = pathToFileURL(join(ROOT, "test/fixtures/store-ledger/ts-hooks.ts")).href;
export const NODE_ARGS = ["--disable-warning=ExperimentalWarning", "--import", HOOKS];

/** Environnement minimal : aucune variable de l'hôte (clés, chemins privés) n'est héritée. */
export function minimalEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "SystemRoot", "TEMP", "TMP", "HOME"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

export async function until<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`délai dépassé : ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
