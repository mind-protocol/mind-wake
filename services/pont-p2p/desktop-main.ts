/** Pont desktop des Réglages « Pont pair-à-pair entre colonies » : une requête JSON sur stdin, une réponse sur stdout. */
import { resolveDataDir } from "../../src/cli/paths.js";
import { processContext } from "../../src/cli/context.js";
import { runPontSettings } from "./settings.mjs";

let input = "";
for await (const chunk of process.stdin) {
  input += String(chunk);
  if (input.length > 8192) break;
}
const dataDir = resolveDataDir(processContext(), undefined).path;
const result = await runPontSettings(dataDir, input);
process.stdout.write(result.stdout + "\n");
process.exitCode = result.exitCode;
