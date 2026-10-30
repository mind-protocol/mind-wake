import { readFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { digest } from "../advice/conversation/capability.js";
import { loadHubConfig } from "./config.js";
import { Hub } from "./hub.js";
import { serveSharedHub } from "./shared-https.js";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    dir: { type: "string" },
    cert: { type: "string" },
    key: { type: "string" },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "0" },
    "pilot-human-route": { type: "boolean", default: false },
  },
});
const { config, dir, cert, key } = values;
if (!config || !dir || !cert || !key) throw new Error("--config --dir --cert --key requis.");
const settings = loadHubConfig(config);
if (
  (values["pilot-human-route"]
    ? settings.parties.length !== 3 ||
      settings.parties.filter((p) => p.kind === "human").length !== 1 ||
      settings.parties.filter((p) => p.kind === "agent").length !== 2
    : settings.parties.length !== 2 || settings.parties.some((p) => p.kind !== "agent")) ||
  new Set(settings.parties.map((p) => p.keyDigest)).size !== settings.parties.length ||
  settings.parties.some(
    (p) => p.permissions.guide || p.permissions.requestHelp || p.guide || p.fictiveBudget,
  )
)
  throw new Error(
    "Hub dédié : deux agents, ou pilote explicite un humain et deux agents ; clés distinctes, messages seulement.",
  );
mkdirSync(dir, { recursive: true });
const hub = new Hub(settings, dir);
// Re-read administrative config on every call: removal/revocation is immediate.
// Adding/rotating identities requires restart, so the Hub identity table stays authoritative.
const served = serveSharedHub(
  hub,
  { cert: readFileSync(cert), key: readFileSync(key) },
  (secret) => {
    const current = loadHubConfig(config);
    return current.parties.some(
      (p) =>
        p.keyDigest === digest(secret) &&
        settings.parties.some((original) => JSON.stringify(original) === JSON.stringify(p)),
    );
  },
);
const port = await served.listen(Number(values.port), values.host);
process.stdout.write(`${JSON.stringify({ ready: true, port })}\n`);
const shutdown = () => {
  void served.close().then(() => {
    hub.close();
    process.exit(0);
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
