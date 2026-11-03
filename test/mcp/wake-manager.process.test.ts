import fs from "node:fs";
import path from "node:path";
import type { UtcTimestamp } from "../../src/contracts/index.js";
import { expect, it } from "vitest";
import { startHarness } from "./harness.js";
import { seedSimulatedProfile, PROFILE } from "../demo/harness.js";
import { workspaceDirFor, controlDbPath } from "../../src/daemon/paths.js";
import { openStore } from "../../src/store/index.js";

it("exposes the rotation through real MCP stdio and preserves Pause", async () => {
  const h = await startHarness();
  try {
    const dir = path.join(h.dir, "rotation-profile");
    fs.mkdirSync(dir);
    seedSimulatedProfile(dir);
    const artifacts = path.join(workspaceDirFor(dir), "artifacts");
    fs.mkdirSync(artifacts, { recursive: true });
    fs.writeFileSync(
      path.join(artifacts, "projets-compteur.json"),
      JSON.stringify({
        current: "a",
        projects: { a: { status: "en cours" }, b: { status: "en cours" } },
      }),
    );
    const party = await h.party("agent", {
      MIND_WAKE_DATA_DIR: dir,
      MIND_WAKE_SESSION: "mcp-session",
    });
    const names = (await party.client.listTools()).tools.map((t) => t.name);
    for (const name of [
      "get_next_wakes",
      "configure_wake_rotation",
      "get_wake_project",
      "save_wake_context",
      "plan_wake_block",
      "set_wake_project_status",
    ])
      expect(names).toContain(name);
    expect((await party.call("configure_wake_rotation", { enabled: true })).isError).toBe(false);
    const preview = await party.call("get_next_wakes", { count: 51 });
    expect(preview.isError).toBe(false);
    expect(preview.data["wakes"]).toHaveLength(51);
    expect(preview.data["rotation"]).toMatchObject({ used: 0 });
    expect(
      (
        await party.call("save_wake_context", {
          project_id: "a",
          summary: "Actual result",
          next_actions: ["Continue"],
          open_questions: [],
          sources: ["artifacts/proof.md"],
        })
      ).isError,
    ).toBe(false);
    const read = await party.call("get_wake_project", { project_id: "a" });
    expect(read.data["contextSessionId"]).toBe("mcp-session");
    expect(read.data["context"]).toMatchObject({ summary: "Actual result" });
    expect(
      (
        await party.call("plan_wake_block", {
          project_id: "a",
          steps: Array.from({ length: 10 }, (_, i) => ({
            wake: i + 1,
            objective: "Work",
            expected: "Proof",
          })),
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await party.call("set_wake_project_status", {
          project_id: "a",
          status: "blocked",
          reason: "Needs response",
        })
      ).isError,
    ).toBe(false);
    const after = await party.call("get_next_wakes", { count: 1 });
    expect(after.data["wakes"]).toMatchObject([{ projectId: "b" }]);
    const control = openStore(controlDbPath(dir));
    try {
      control.uow.profiles.transition(PROFILE, {
        from: "ready",
        to: "paused",
        reason: "Human pause",
        at: new Date().toISOString() as UtcTimestamp,
      });
    } finally {
      control.close();
    }
    expect((await party.call("configure_wake_rotation", { enabled: false })).isError).toBe(true);
    expect((await party.call("get_next_wakes", { count: 1 })).isError).toBe(false);
  } finally {
    await h.close();
  }
}, 60_000);
