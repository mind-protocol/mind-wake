import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";

it.runIf(process.platform === "win32")("refuses a stale process identity, then stops only the verified engine", async () => {
  const script = fs.readFileSync(new URL("../../desktop/src-tauri/src/restart-engine.ps1", import.meta.url), "utf8");
  // Own disposable process: never address the installed engine from tests.
  const child = spawn(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"], { windowsHide: true });
  const exited = once(child, "exit");
  try {
    await once(child.stdout!, "data");
    const stop = (at: string) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, WAKE_RESTART_PID: String(child.pid), WAKE_RESTART_STARTED: at },
    });
    expect(stop("2000-01-01T00:00:00Z").status).not.toBe(0);
    expect(child.exitCode).toBeNull();
    const result = stop(new Date().toISOString());
    expect(result.status, result.stderr).toBe(0);
    await exited;
    expect(child.exitCode).not.toBeNull();
  } finally { if (child.exitCode === null) child.kill(); }
}, 40_000);
