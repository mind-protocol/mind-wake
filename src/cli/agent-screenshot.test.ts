import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setAgentScreenshotPolicy } from "./agent-screenshot.js";
import { decideAgentScreenshot } from "../daemon/agent-screenshot-policy.js";

let workspace: string;
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "screenshot-control-"));
});
afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});
const artifacts = () => path.join(workspace, "artifacts");
const file = () => path.join(artifacts(), "pilote.json");

it("controls the policy applied to subsequent fixture wakes and preserves unrelated fields", () => {
  fs.mkdirSync(artifacts());
  fs.writeFileSync(
    file(),
    JSON.stringify({ version: 1, compactAboveTokens: 50000, compactRequest: "keep", other: 1 }),
  );
  setAgentScreenshotPolicy(workspace, "off");
  expect(
    decideAgentScreenshot(artifacts(), "primary", { idleMs: 900000, observedAtMs: 100 }, 100)
      .reason,
  ).toBe("agent-off");
  setAgentScreenshotPolicy(workspace, "auto", 1000);
  expect(
    decideAgentScreenshot(artifacts(), "primary", { idleMs: 999, observedAtMs: 100 }, 100).reason,
  ).toBe("auto-active");
  expect(
    decideAgentScreenshot(artifacts(), "primary", { idleMs: 1000, observedAtMs: 100 }, 100).surface,
  ).toBe("primary");
  setAgentScreenshotPolicy(workspace, "on");
  expect(
    decideAgentScreenshot(artifacts(), "primary", { idleMs: 0, observedAtMs: 100 }, 100).surface,
  ).toBe("primary");
  expect(JSON.parse(fs.readFileSync(file(), "utf8"))).toMatchObject({
    version: 1,
    compactAboveTokens: 50000,
    compactRequest: "keep",
    other: 1,
    wakeScreenshot: { mode: "on", idleThresholdMs: 1000 },
  });
  expect(fs.readdirSync(artifacts())).toEqual(["pilote.json"]);
});

it("initializes only the explicit workspace and rejects malformed input without changes", () => {
  setAgentScreenshotPolicy(workspace, "off");
  const before = fs.readFileSync(file(), "utf8");
  for (const threshold of [0, -1, 1.5, NaN, 86400001]) {
    expect(() => setAgentScreenshotPolicy(workspace, "auto", threshold)).toThrow();
    expect(fs.readFileSync(file(), "utf8")).toBe(before);
  }
  fs.writeFileSync(file(), "broken");
  expect(() => setAgentScreenshotPolicy(workspace, "on")).toThrow();
  expect(fs.readFileSync(file(), "utf8")).toBe("broken");
});
