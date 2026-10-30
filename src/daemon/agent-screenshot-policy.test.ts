import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  collectAgentScreenshot,
  decideAgentScreenshot,
  readAgentScreenshotPolicy,
  SCREENSHOT_STATE_FILE,
} from "./agent-screenshot-policy.js";
import type { WakeScreenshotSurface } from "./wake-screenshot.js";
import { configuredWakeScreenshot } from "./wake-screenshot.js";
import { readAgentPilot } from "./agent-pilot.js";

let dir: string;
const now = 10_000;
const idle = { idleMs: 120_000, observedAtMs: now };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-screenshots-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const write = (mode: unknown, idleThresholdMs?: unknown): void => {
  fs.writeFileSync(
    path.join(dir, "pilote.json"),
    JSON.stringify({
      version: 1,
      compactAboveTokens: 1234,
      wakeScreenshot: { mode, idleThresholdMs },
    }),
  );
};
const decide = (observation = idle) => decideAgentScreenshot(dir, "primary", observation, now);

it("preserves authorized defaults and never grants permission or changes surface", () => {
  expect(decide().surface).toBe("primary");
  write("on");
  expect(decideAgentScreenshot(dir, undefined, idle, now).reason).toBe("not-authorized");
  expect(decideAgentScreenshot(dir, "wake-window", idle, now).surface).toBe("wake-window");
  fs.mkdirSync(path.join(dir, "installation"));
  fs.writeFileSync(path.join(dir, "installation/wake-screenshot.json"), '{"enabled":false}');
  expect(
    decideAgentScreenshot(dir, configuredWakeScreenshot(dir, "primary"), idle, now).surface,
  ).toBeUndefined();
  expect(
    decideAgentScreenshot(dir, configuredWakeScreenshot(dir, "off"), idle, now).surface,
  ).toBeUndefined();
});

it("rereads off/on/auto each wake and never reactivates manual off when idle", () => {
  write("off");
  expect(decide()).toEqual({ mode: "off", reason: "agent-off" });
  expect(decide({ ...idle, idleMs: 86_400_000 }).surface).toBeUndefined();
  write("auto", 5000);
  expect(decide({ ...idle, idleMs: 4999 }).reason).toBe("auto-active");
  expect(decide({ ...idle, idleMs: 5000 }).surface).toBe("primary");
  write("on");
  expect(decide({ ...idle, idleMs: 0 }).surface).toBe("primary");
  expect(readAgentPilot(dir)).toEqual({ compactAboveTokens: 1234 });
});

it("auto requires a fresh valid signal and defaults to 60 seconds", () => {
  write("auto");
  expect(readAgentScreenshotPolicy(dir)?.idleThresholdMs).toBe(60_000);
  for (const observation of [
    null,
    { ...idle, observedAtMs: now - 2001 },
    { ...idle, observedAtMs: now + 1 },
    { ...idle, idleMs: -1 },
  ]) {
    expect(decideAgentScreenshot(dir, "primary", observation, now).reason).toBe("auto-unknown");
  }
  expect(decide({ ...idle, idleMs: 59_999 }).reason).toBe("auto-active");
  expect(decide({ ...idle, idleMs: 60_000 }).reason).toBe("auto-idle");
});

it("fails closed on invalid settings without mutating them or compaction data", () => {
  for (const [mode, threshold] of [
    ["other", undefined],
    ["off", 0],
    ["auto", -1],
    ["auto", 1.5],
    ["auto", 86_400_001],
    ["auto", "60000"],
    ["auto", null],
  ]) {
    write(mode, threshold);
    expect(decide().reason).toBe("invalid-policy");
    expect(readAgentPilot(dir)).toEqual({ compactAboveTokens: 1234 });
  }
  for (const text of ["broken", "null", "[]", '{"version":2}', " ".repeat(4097)]) {
    fs.writeFileSync(path.join(dir, "pilote.json"), text);
    expect(decide().surface).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, "pilote.json"), "utf8")).toBe(text);
  }
});

it("retains the last observed off across compaction-only rewrites, deletion and fresh resolver calls", () => {
  const state = path.join(dir, "state");
  write("off");
  const evaluate = () => decideAgentScreenshot(dir, "primary", idle, now, state);
  expect(evaluate().reason).toBe("agent-off");
  fs.writeFileSync(path.join(dir, "pilote.json"), '{"version":1,"compactRequest":"new"}');
  expect(evaluate().reason).toBe("agent-off");
  fs.unlinkSync(path.join(dir, "pilote.json"));
  expect(evaluate().reason).toBe("agent-off");
  expect(
    JSON.parse(fs.readFileSync(path.join(state, SCREENSHOT_STATE_FILE), "utf8")),
  ).toMatchObject({ mode: "off" });
  write("auto", 1234);
  expect(evaluate().reason).toBe("auto-idle");
  fs.unlinkSync(path.join(dir, "pilote.json"));
  expect(evaluate().mode).toBe("auto");
  expect(evaluate().surface).toBe("primary");
});

it("fails closed when saved policy is unreadable or cannot be persisted", () => {
  const state = path.join(dir, "state");
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, SCREENSHOT_STATE_FILE), "broken");
  expect(decideAgentScreenshot(dir, "primary", idle, now, state).reason).toBe("invalid-policy");
  write("off");
  expect(decideAgentScreenshot(dir, "primary", idle, now, state).reason).toBe("agent-off");
  fs.writeFileSync(path.join(dir, "not-a-directory"), "fixture");
  expect(
    decideAgentScreenshot(dir, "primary", idle, now, path.join(dir, "not-a-directory")).surface,
  ).toBeUndefined();
});

it.each(["activity", "off", "consent", "stale"])(
  "discards a newly captured image when %s changes during capture",
  async (change) => {
    write("auto");
    let observation = idle;
    let surface: WakeScreenshotSurface | undefined = "primary";
    let calls = 0;
    const result = await collectAgentScreenshot({
      artifactsDir: dir,
      stateDir: path.join(dir, "state"),
      now: () => now,
      observation: () => observation,
      authorizedSurface: () => surface,
      capture: () => {
        calls++;
        if (change === "activity") observation = { ...idle, idleMs: 0 };
        if (change === "off") write("off");
        if (change === "consent") surface = undefined;
        if (change === "stale") observation = { ...idle, observedAtMs: now - 2001 };
        return Promise.resolve({
          surface: "primary" as const,
          mediaType: "image/jpeg" as const,
          base64: "/9j/2Q==",
          width: 1,
          height: 1,
          capturedAt: new Date().toISOString(),
        });
      },
    });
    expect(calls).toBe(1);
    expect(result.image).toBeUndefined();
    expect(result.discardedAfterCapture).toBe(true);
  },
);

it("never calls the capture backend for off and retains a still-authorized auto image", async () => {
  let calls = 0;
  const options = {
    artifactsDir: dir,
    stateDir: path.join(dir, "state"),
    now: () => now,
    observation: () => idle,
    authorizedSurface: () => "primary" as const,
    capture: () => {
      calls++;
      return Promise.resolve({
        surface: "primary" as const,
        mediaType: "image/jpeg" as const,
        base64: "/9j/2Q==",
        width: 1,
        height: 1,
        capturedAt: new Date().toISOString(),
      });
    },
  };
  write("off");
  expect((await collectAgentScreenshot(options)).image).toBeUndefined();
  expect(calls).toBe(0);
  write("auto");
  expect((await collectAgentScreenshot(options)).image?.surface).toBe("primary");
  expect(calls).toBe(1);
});
