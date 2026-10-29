/**
 * Démo SIMULÉE de MIND Wake (AGENTS §7), à lancer depuis la racine du dépôt :
 *
 *   node --experimental-transform-types --import ./test/fixtures/store-ledger/ts-hooks.ts test/demo/demo-simulee.ts [--keep]
 *
 * Tout se passe dans un dossier temporaire, avec l'adapter factice : aucun appel modèle,
 * aucun réseau, aucune modification système persistante. `--keep` conserve le dossier
 * pour l'inspecter (`mind-wake status --data-dir …`, `journal`, artefacts).
 */

import { demoDir, killAllDaemons, seedSimulatedProfile } from "./harness.js";
import { runSimulatedDemo } from "./scenario.js";

const keep = process.argv.includes("--keep");
const dir = demoDir();
const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
log(`Dossier de démonstration (temporaire) : ${dir.path}`);
log("Tout ce qui suit est SIMULÉ : adapter factice, agent scripté, aucun appel modèle.\n");
try {
  seedSimulatedProfile(dir.path);
  const result = await runSimulatedDemo(dir.path, log);
  log("\nDélais mesurés (ms) :");
  for (const [name, value] of Object.entries(result.measures) as [string, number | null][]) {
    log(`  ${name} : ${value === null ? "—" : value.toFixed(1)}`);
  }
  log(
    `Réveils après l'arrêt d'urgence : ${String(result.sessionsAfterStop)} ; profil ${String(result.finalState)}, verrou ${String(result.emergencyStopLocked)}.`,
  );
} finally {
  await killAllDaemons();
  if (keep) log(`Dossier conservé : ${dir.path}`);
  else dir.remove();
}
