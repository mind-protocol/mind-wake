/** No model call, policy activation, network or profile mutation. Tests process-tree stop on this PC. */
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ProcessTreeSupervisor } from "../dist/runner/process-tree.js";
const { values } = parseArgs({ options: { "data-dir": { type: "string" } } });
if (!values["data-dir"]) throw Error("--data-dir DIRECTORY required");
const supervisor = new ProcessTreeSupervisor(
  path.join(path.resolve(values["data-dir"]), "runtime"),
);
let child;
let timeout;
const result = { ok: false, test: "job-object-start-and-stop", modelCalled: false };
try {
  if (!supervisor.status.available) throw Error(supervisor.status.reason);
  result.launcherPath = supervisor.status.launcherPath;
  result.sha256 = createHash("sha256").update(fs.readFileSync(result.launcherPath)).digest("hex");
  // Child announces that its own descendant has started, before any termination test.
  const descendant = 'console.log("descendant-ready");setInterval(()=>{},1000)';
  const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit'],windowsHide:true});setInterval(()=>{},1000)`;
  child = supervisor.spawn("launcher-preflight", randomUUID(), {
    executable: process.execPath,
    args: ["-e", parent],
  });
  await Promise.race([
    (async () => {
      await child.started();
      if ((await child.readLine()) !== "descendant-ready") throw Error("Descendant did not start");
    })(),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(Error("Launcher did not start within 10s")), 10000);
    }),
  ]);
  clearTimeout(timeout);
  result.termination = await child.terminateTree();
  if (!result.termination.confirmed) throw Error("Process-tree termination not confirmed");
  result.ok = true;
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  result.action =
    "Inspect CodeIntegrity 3077/3089. Supply a publisher-signed launcher accepted by the PC policy, or request an explicit administrator allow rule. Do not disable Code Integrity.";
} finally {
  clearTimeout(timeout);
  if (child && !child.hasExited) await child.terminateTree();
}
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
