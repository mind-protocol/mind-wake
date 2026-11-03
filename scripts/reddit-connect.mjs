import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const child = spawn(
  process.execPath,
  [
    "--experimental-transform-types",
    "--disable-warning=ExperimentalWarning",
    "--import",
    pathToFileURL(
      fileURLToPath(new URL("../test/fixtures/store-ledger/ts-hooks.ts", import.meta.url)),
    ).href,
    fileURLToPath(new URL("../services/reddit/connect.ts", import.meta.url)),
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", windowsHide: true },
);
child.once("error", () => {
  process.stderr.write("Impossible de démarrer la connexion Reddit.\n");
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
