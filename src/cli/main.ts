#!/usr/bin/env node
/** Point d'entrée `mind-wake`. Seul `daemon run --simulated` lance des sessions, au premier plan. */

import { processContext } from "./context.js";
import { runCli } from "./run.js";

process.exitCode = await runCli(process.argv.slice(2), processContext());
