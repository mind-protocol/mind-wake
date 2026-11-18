import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { seedSimulatedProfile } from "../../test/demo/harness.js";
import { processContext } from "./context.js";
import { runCli } from "./run.js";
import { executionMode } from "../daemon/execution-mode.js";
import { mainThreadEnabled } from "../daemon/main-thread.js";
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-mode-"));
  seedSimulatedProfile(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
async function cli(command: string, ...more: string[]) {
  let output = "";
  const code = await runCli([command, ...more, "--data-dir", dir, "--json"], {
    ...processContext(),
    env: {},
    stdout: (s) => {
      output += s;
    },
    stderr: (s) => {
      output += s;
    },
  });
  return { code, json: JSON.parse(output) };
}
it("persists always-on, exposes it in status, resumes an explicit selection and allows returning to On", async () => {
  expect(executionMode(dir)).toBe("on");
  await cli("pause");
  expect((await cli("always-on")).code).toBe(0);
  expect(executionMode(dir)).toBe("always-on");
  const status = (await cli("status")).json.data;
  expect(status.executionMode).toBe("always-on");
  expect(status.profile.state).toBe("ready");
  expect((await cli("on")).code).toBe(0);
  expect(executionMode(dir)).toBe("on");
});
it("listen (Off à l'écoute, Windows startup): lifts a pause, persisted and exposed, On leaves it; Pause stays above it", async () => {
  await cli("always-on");
  await cli("pause");
  const listen = await cli("listen");
  expect(listen.code).toBe(0);
  expect(listen.json.data.mode).toBe("listening");
  expect(executionMode(dir)).toBe("listening");
  let status = (await cli("status")).json.data;
  expect(status.executionMode).toBe("listening");
  expect(status.profile.state).toBe("ready");
  // Pause manuelle : profil en pause, le mode d'écoute reste mémorisé sous la pause.
  await cli("pause");
  status = (await cli("status")).json.data;
  expect(status.profile.state).toBe("paused");
  expect(executionMode(dir)).toBe("listening");
  expect((await cli("on")).code).toBe(0);
  expect(executionMode(dir)).toBe("on");
  await cli("stop");
  expect((await cli("listen")).code).toBe(1);
  expect(executionMode(dir)).toBe("on");
});
it("never lifts an emergency stop or activates an unconfigured profile", async () => {
  await cli("stop");
  expect((await cli("always-on")).code).toBe(1);
  expect(executionMode(dir)).toBe("on");
});
it("main thread On/Off: persisted, exposed in status, independent from the execution mode", async () => {
  expect(mainThreadEnabled(dir)).toBe(true);
  expect((await cli("status")).json.data.mainThread).toEqual({ enabled: true, updatedAt: null });
  await cli("always-on");
  const off = await cli("main-thread", "off");
  expect(off.code).toBe(0);
  expect(off.json.data).toMatchObject({ enabled: false, changed: true });
  expect(mainThreadEnabled(dir)).toBe(false);
  const status = (await cli("status")).json.data;
  expect(status.mainThread.enabled).toBe(false);
  expect(status.executionMode).toBe("always-on");
  expect((await cli("main-thread", "off")).json.data.changed).toBe(false);
  expect((await cli("main-thread", "on")).json.data).toMatchObject({ enabled: true, changed: true });
  expect((await cli("main-thread", "status")).json.data.enabled).toBe(true);
  expect(executionMode(dir)).toBe("always-on");
});
