import path from "node:path";
import os from "node:os";
import { buildSnapshot } from "./read-model.mjs";

// Same profile resolution as src/cli/paths.ts. No path or action accepted from webview.
const base =
  process.platform === "win32"
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    : process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const dataDir = process.env.MIND_WAKE_DATA_DIR || path.join(base, "mind-wake");
try {
  process.stdout.write(
    JSON.stringify({
      ok: true,
      data: buildSnapshot({
        dataDir,
        codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      }),
    }),
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({ ok: false, error: { message: error.message } }),
  );
  process.exitCode = 1;
}
