/** Actual isolated daemon loop with a fake runtime: no model, screen capture or live profile. */
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { demoDir, PROFILE, readDb, seedSimulatedProfile } from "../../test/demo/harness.js";
import { fakeScenario } from "../adapters/fake/index.js";
import { setAgentScreenshotPolicy } from "../cli/agent-screenshot.js";
import { WakeDaemon, type DaemonOptions } from "./daemon.js";
import { workspaceDirFor } from "./paths.js";

it("reads agent off from the actual artifacts root while a fixture daemon completes its wake", async () => {
  const fixture = demoDir("mind-wake-agent-capture-loop-");
  try {
    seedSimulatedProfile(fixture.path);
    const workspace = workspaceDirFor(fixture.path);
    fs.mkdirSync(workspace, { recursive: true });
    setAgentScreenshotPolicy(workspace, "off");
    const lines: string[] = [];
    const options: DaemonOptions = {
      dataDir: fixture.path,
      profileId: PROFILE,
      simulated: true,
      runtimeDir: path.join(fixture.path, "isolated-runtime"),
      wakeScreenshot: "primary",
      exitAfterSessions: 1,
      scenario: fakeScenario("success"),
      log: (line: string) => {
        lines.push(line);
      },
    };
    const daemon = await WakeDaemon.open(options);
    const summary = await daemon.run();
    expect(summary.sessions).toHaveLength(1);
    expect(summary.sessions[0]?.outcome).toBe("completed");
    expect(lines.some((line) => line.includes("capture ambiante : off, agent-off"))).toBe(true);
    fs.unlinkSync(path.join(workspace, "artifacts", "pilote.json"));
    const restarted = await WakeDaemon.open(options);
    expect((await restarted.run()).sessions[0]?.outcome).toBe("completed");
    expect(lines.filter((line) => line.includes("capture ambiante : off, agent-off"))).toHaveLength(
      2,
    );
    readDb(fixture.path, (store) => {
      const decisions = store.uow.journal
        .list(PROFILE)
        .filter((event) => event.type === "wake_screenshot_decided");
      expect(decisions).toHaveLength(2);
      expect(decisions[1]?.metadata).toMatchObject({
        mode: "off",
        reason: "agent-off",
        imageAttached: false,
      });
    });
  } finally {
    fixture.remove();
  }
}, 60_000);
