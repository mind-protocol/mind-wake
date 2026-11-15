/**
 * Arguments Node pour lancer un script du dépôt depuis le code en cours d'exécution.
 * Compilé (`dist/…/x.js`) : le fichier JS. Exécuté depuis les sources (`src/…/x.ts`,
 * moteur lancé hors compilation) : la source TypeScript avec le chargeur du dépôt, comme
 * les services. Ainsi un sous-processus suit le même mode que son parent.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Chargeur TypeScript commun aux services, au desktop et au moteur hors compilation. */
export const TS_HOOKS = "test/fixtures/store-ledger/ts-hooks.ts";

export function typeScriptNodeArgs(repo: string): string[] {
  return [
    "--experimental-transform-types",
    "--disable-warning=ExperimentalWarning",
    "--import",
    pathToFileURL(path.join(repo, TS_HOOKS)).href,
  ];
}

/** Dépôt contenant `file` (ancêtre qui possède le chargeur TypeScript). */
function repoOf(file: string): string | null {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, TS_HOOKS))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * `compiled` est le chemin `.js` calculé depuis `import.meta.url`. S'il n'existe pas mais que
 * sa source `.ts` existe (exécution depuis `src/`), rend les arguments TypeScript ; sinon
 * le fichier tel quel. `null` si aucun des deux n'existe.
 */
export function nodeScriptArgs(compiled: string): string[] | null {
  if (fs.existsSync(compiled)) return [compiled];
  const source = compiled.replace(/\.js$/, ".ts");
  if (source === compiled || !fs.existsSync(source)) return null;
  const repo = repoOf(source);
  return repo === null ? null : [...typeScriptNodeArgs(repo), source];
}
