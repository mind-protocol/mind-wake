/** Direct repo consultations without restarting the current MCP client. */
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const child = spawn(
  process.execPath,
  [
    "--experimental-transform-types",
    "--disable-warning=ExperimentalWarning",
    "--import",
    pathToFileURL(path.join(root, "test/fixtures/store-ledger/ts-hooks.ts")).href,
    path.join(root, "services/helpers/direct-advice-cli.ts"),
    ...process.argv.slice(2),
  ],
  { cwd: root, windowsHide: true, stdio: "inherit" },
);
child.once("error", (error) => {
  process.stderr.write(error.message + "\n");
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
