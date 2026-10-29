import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { seedSimulatedProfile } from "../../test/demo/harness.js";
import { processContext } from "./context.js";
import { runCli } from "./run.js";
import { executionMode } from "../daemon/execution-mode.js";
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-mode-"));
  seedSimulatedProfile(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
async function cli(command: string) {
  let output = "";
  const code = await runCli([command, "--data-dir", dir, "--json"], {
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
it("never lifts an emergency stop or activates an unconfigured profile", async () => {
  await cli("stop");
  expect((await cli("always-on")).code).toBe(1);
  expect(executionMode(dir)).toBe("on");
});
