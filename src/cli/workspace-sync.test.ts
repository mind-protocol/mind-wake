import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { seedSimulatedProfile } from "../../test/demo/harness.js";
import { processContext } from "./context.js";
import { runCli } from "./run.js";
import { workspaceSyncStatus } from "../daemon/workspace-git-sync.js";
it("routes workspace CLI settings with literal argv and leaves activation to daemon startup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-workspace-cli-"));
  try {
    seedSimulatedProfile(dir);
    const work = path.join(dir, "selected with spaces");
    fs.mkdirSync(work);
    const cli = async (args: string[]) => {
      let text = "";
      const code = await runCli(["workspace-sync", ...args, "--data-dir", dir, "--json"], {
        ...processContext(),
        env: {},
        stdout: (s) => {
          text += s;
        },
        stderr: (s) => {
          text += s;
        },
      });
      return { code, text };
    };
    expect((await cli(["status"])).code).toBe(0);
    expect(
      (await cli(["configure", "--workspace", work, "--github-url", "", "--enabled", "false"]))
        .code,
    ).toBe(0);
    expect(workspaceSyncStatus(dir)).toMatchObject({
      config: { workspaceDir: work, enabled: false },
      pendingRestart: true,
    });
    expect((await cli(["now"])).code).toBe(1);
    expect(
      (await cli(["configure", "--workspace", work, "--github-url", "", "--enabled", "garbage"]))
        .code,
    ).not.toBe(0);
    expect(fs.existsSync(path.join(dir, "workspace-sync-now.json"))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
