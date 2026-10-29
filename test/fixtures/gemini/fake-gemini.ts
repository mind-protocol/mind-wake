/**
 * Faux exécutable `gemini` pour les tests de l'adapter : rejoue une sortie `stream-json`
 * enregistrée, sans aucun appel modèle ni réseau. Les enregistrements de `recordings/`
 * sont SYNTHÉTIQUES : écrits d'après le schéma de la source officielle
 * (`packages/core/src/output/types.ts`), pas capturés sur un compte réel.
 *
 * Scénario : variable `FAKE_GEMINI_SCENARIO` (nom d'un fichier de `recordings/`, sans
 * extension). Directives de rejeu, une par ligne, préfixées par `#!` :
 *   `#! exit <code>`   code de sortie final (défaut 0) ;
 *   `#! cut <n>`       écrit seulement les n premiers caractères de la ligne suivante, sans
 *                      fin de ligne, puis se termine (sortie coupée) ;
 *   `#! hang`          ne se termine jamais (annulation) ;
 *   `#! stderr <txt>`  écrit sur la sortie d'erreur.
 * Les arguments reçus et l'environnement visible sont écrits dans `$GEMINI_CLI_HOME`.
 */

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("0.52.0\n");
  process.exit(0);
}

const home = process.env["GEMINI_CLI_HOME"];
if (home !== undefined) {
  fs.writeFileSync(
    path.join(home, "fake-invocation.json"),
    JSON.stringify({ argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort() }),
  );
}

const scenario = process.env["FAKE_GEMINI_SCENARIO"] ?? "success";
const file = path.join(import.meta.dirname, "recordings", `${scenario}.jsonl`);
const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);

let exitCode = 0;
let cut: number | null = null;
for (const line of lines) {
  if (line.startsWith("#! ")) {
    const [directive, ...rest] = line.slice(3).split(" ");
    const value = rest.join(" ");
    if (directive === "exit") exitCode = Number(value);
    if (directive === "cut") cut = Number(value);
    if (directive === "stderr") process.stderr.write(`${value}\n`);
    if (directive === "hang") {
      setInterval(() => undefined, 1_000);
      await new Promise(() => undefined);
    }
    continue;
  }
  if (line.trim() === "") continue;
  if (cut !== null) {
    process.stdout.write(line.slice(0, cut));
    break;
  }
  process.stdout.write(`${line}\n`);
}
process.exitCode = exitCode;
