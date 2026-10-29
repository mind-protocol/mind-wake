#!/usr/bin/env node
/** Point d'entrée `mind-wake`. Aucune commande ne lance de daemon ni de session. */

import { processContext } from "./context.js";
import { runCli } from "./run.js";

process.exitCode = await runCli(process.argv.slice(2), processContext());
