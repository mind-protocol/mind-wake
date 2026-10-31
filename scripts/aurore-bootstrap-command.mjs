/** Internal updater bridge: stderr retained privately; entire child tree belongs to the Job Object. */
import fs from "node:fs";
import { spawn } from "node:child_process";
const [exe, encodedArgs, errorFile] = process.argv.slice(2);
const fd = fs.openSync(errorFile, "a", 0o600);
try {
  const child = spawn(exe, JSON.parse(encodedArgs), {
    windowsHide: true,
    stdio: ["ignore", "inherit", fd],
  });
  child.once("error", () => {
    process.exitCode = 1;
    fs.closeSync(fd);
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
    fs.closeSync(fd);
  });
} catch {
  fs.closeSync(fd);
  process.exitCode = 1;
}
