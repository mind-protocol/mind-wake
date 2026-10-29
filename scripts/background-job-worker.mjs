/** Runs inside a Windows Job Object; raw output goes to files, not Wake's memory. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const [script, output, ...args] = process.argv.slice(2);
if (!script || !output) throw new Error("Missing job script/output");
const stdout = fs.openSync(path.join(output, "stdout.log"), "a");
const stderr = fs.openSync(path.join(output, "stderr.log"), "a");
const child = spawn(process.execPath, [script, ...args], {
  stdio: ["ignore", stdout, stderr],
  windowsHide: true,
});
child.once("error", (error) => {
  fs.writeSync(stderr, String(error));
  process.exitCode = 1;
});
child.once("close", (code) => {
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  process.exitCode = code ?? 1;
});
