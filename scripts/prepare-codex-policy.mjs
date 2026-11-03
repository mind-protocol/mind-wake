/** Prepare a fresh native Codex policy. Does not activate or grant permissions. */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { nativeCodexPolicy } from "./codex-policy.mjs";
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    model: { type: "string", default: "gpt-6.1-sol" },
    "time-zone": { type: "string", default: "Europe/Paris" },
  },
});
if (!values.output)
  throw Error(
    "Usage: node scripts/prepare-codex-policy.mjs --output FILE [--model MODEL] [--time-zone IANA]",
  );
const policy = nativeCodexPolicy({ model: values.model, timeZone: values["time-zone"] });
fs.writeFileSync(path.resolve(values.output), JSON.stringify(policy, null, 2) + "\n", {
  flag: "wx",
});
console.log(
  "Brouillon écrit. Aucune activation : examiner puis utiliser policy configure et enable après accord.",
);
