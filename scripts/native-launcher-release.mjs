/** Build, then sign externally, then seal the release. Never installs certificates or changes policy. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { ensureJobLauncher } from "../dist/runner/process-tree.js";
import { JOB_SOURCE_SHA256, JOB_EXECUTABLE } from "../dist/runner/bundled-launcher.js";
import { verifyPublisherSignature } from "./authenticode.mjs";
const { values } = parseArgs({ options: { build: { type: "string" }, seal: { type: "string" } } });
if (Boolean(values.build) === Boolean(values.seal))
  throw Error("Use --build NEW_DIRECTORY or --seal DIRECTORY");
const directory = path.resolve(values.build || values.seal);
if (values.build) {
  if (fs.existsSync(directory)) throw Error("Build directory must not exist");
  const status = ensureJobLauncher(directory, process.platform, null);
  if (!status.available) throw Error(status.reason);
  console.log(
    JSON.stringify({
      file: status.launcherPath,
      sourceSha256: JOB_SOURCE_SHA256,
      next: "Sign this exact file with your publisher signing service, then --seal this directory",
    }),
  );
} else {
  const binary = path.join(directory, JOB_EXECUTABLE);
  const signature = verifyPublisherSignature(binary);
  const manifest = {
    format: "mind-wake.job-launcher.v1",
    file: JOB_EXECUTABLE,
    sourceSha256: JOB_SOURCE_SHA256,
    sha256: createHash("sha256").update(fs.readFileSync(binary)).digest("hex"),
    signature,
  };
  fs.writeFileSync(path.join(directory, "job-launcher.json"), JSON.stringify(manifest, null, 2), {
    flag: "wx",
  });
  console.log(JSON.stringify(manifest));
}
