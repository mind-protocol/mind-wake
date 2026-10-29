/**
 * Lance le hub MIND local (SIMULATION des séances, messages stockés localement) :
 *
 *   node --experimental-transform-types --import ./test/fixtures/store-ledger/ts-hooks.ts \
 *     services/mcp/hub-main.ts --config <hub.json> --dir <dossier> --pipe <\\.\pipe\nom>
 *
 * Aucun port réseau : `--pipe` doit désigner un pipe nommé Windows ou une socket Unix.
 * Écrit une ligne JSON `{"ready":true}` sur la sortie standard une fois à l'écoute.
 */

import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadHubConfig } from "./config.js";
import { Hub, serveHub } from "./hub.js";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    dir: { type: "string" },
    pipe: { type: "string" },
  },
  strict: true,
});
if (values.config === undefined || values.dir === undefined || values.pipe === undefined) {
  process.stderr.write("Usage : hub-main.ts --config <json> --dir <dossier> --pipe <pipe>\n");
  process.exit(2);
}

mkdirSync(values.dir, { recursive: true });
const hub = new Hub(loadHubConfig(values.config), values.dir);
const served = await serveHub(hub, values.pipe);
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);

const shutdown = (): void => {
  void served.close().then(() => {
    hub.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
