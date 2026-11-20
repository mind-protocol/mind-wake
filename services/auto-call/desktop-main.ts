/**
 * Pont desktop de l'interrupteur « Actif — appel toutes les 10 min » (page Appel) :
 * une requête JSON sur stdin ({action: "status" | "on" | "off"}), une réponse JSON sur stdout.
 * N'écrit que `auto-call.json` ; le minuteur et les appels restent dans le moteur.
 */
import { resolveDataDir } from "../../src/cli/paths.js";
import { processContext } from "../../src/cli/context.js";
import { readAutoCallState, readAutoCallTrace, setAutoCallEnabled } from "../../src/communication/auto-call.js";

let input = "";
for await (const chunk of process.stdin) {
  input += String(chunk);
  if (input.length > 4096) break;
}
try {
  const { action } = JSON.parse(input || "{}") as { action?: unknown };
  const dataDir = resolveDataDir(processContext(), undefined).path;
  if (action !== "status" && action !== "on" && action !== "off") throw Error("Action inconnue");
  const state = action === "status" ? readAutoCallState(dataDir) : setAutoCallEnabled(dataDir, action === "on");
  const trace = readAutoCallTrace(dataDir, 1)[0] ?? null;
  process.stdout.write(JSON.stringify({ ok: true, data: {
    enabled: state.enabled, intervalMinutes: state.intervalMinutes, nextAt: state.nextAt,
    lastOutcome: state.lastOutcome, lastAt: state.lastAt, lastTrace: trace,
  } }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: { message: error instanceof Error ? error.message : String(error) } }) + "\n");
  process.exitCode = 1;
}
