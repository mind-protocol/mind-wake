/**
 * Point d'entrée du processus passerelle SIMULÉE.
 *
 * Usage : gateway-main.ts --pipe <pipe local> --config <fichier JSON> --events <fichier JSONL>
 * Écrit `{"ready":true}` sur stdout une fois à l'écoute ; s'arrête sur SIGTERM ou stdin fermé.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { JsonlFileExchangeEventSink } from "./events.js";
import { startGateway } from "./gateway.js";
import { ConversationService, gatewayConfigSchema } from "./service.js";

const { values } = parseArgs({
  options: {
    pipe: { type: "string" },
    config: { type: "string" },
    events: { type: "string" },
  },
  strict: true,
});
if (values.pipe === undefined || values.config === undefined || values.events === undefined) {
  process.stderr.write("Usage : --pipe <pipe> --config <fichier> --events <fichier>\n");
  process.exit(2);
}

const config = gatewayConfigSchema.parse(JSON.parse(readFileSync(values.config, "utf8")));
const service = new ConversationService(config, new JsonlFileExchangeEventSink(values.events));
const gateway = await startGateway(service, values.pipe);
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);

const stop = (): void => {
  void gateway.close().then(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.stdin.on("end", stop);
process.stdin.resume();
