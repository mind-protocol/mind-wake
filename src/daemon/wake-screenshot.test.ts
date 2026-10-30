import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { configuredWakeScreenshot, parseWakeScreenshotSurface, captureClickPoint } from "./wake-screenshot.js";
it("keeps physical signed click coordinates and rejects incomplete or malformed points", () => {
  expect(captureClickPoint({ MIND_WAKE_CAPTURE_CLICK_X: "-120", MIND_WAKE_CAPTURE_CLICK_Y: "0" })).toEqual({ x: -120, y: 0 });
  for (const [x, y] of [["1", undefined], ["", "2"], ["1.5", "2"], ["Infinity", "2"], ["2147483648", "0"]]) {
    expect(captureClickPoint({ MIND_WAKE_CAPTURE_CLICK_X: x, MIND_WAKE_CAPTURE_CLICK_Y: y })).toBeUndefined();
  }
});
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-image-config-"));
  fs.mkdirSync(path.join(dir, "installation"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (value: unknown) =>
  fs.writeFileSync(path.join(dir, "installation/wake-screenshot.json"), JSON.stringify(value));
it("never captures by default or without transmission consent", () => {
  expect(configuredWakeScreenshot(dir)).toBeUndefined();
  write({ enabled: true, surface: "primary" });
  expect(configuredWakeScreenshot(dir)).toBeUndefined();
});
it("uses exactly the approved surface and supports revocation", () => {
  write({
    enabled: true,
    surface: "wake-window",
    authorizedAt: new Date().toISOString(),
    providerTransmissionAcknowledged: true,
  });
  expect(configuredWakeScreenshot(dir)).toBe("wake-window");
  expect(configuredWakeScreenshot(dir, "off")).toBeUndefined();
  write({ enabled: false });
  expect(configuredWakeScreenshot(dir, "wake-window")).toBeUndefined();
  expect(configuredWakeScreenshot(dir)).toBeUndefined();
});
it("does not expand a malformed selection to the whole screen", () => {
  write({
    enabled: true,
    surface: "all",
    authorizedAt: new Date().toISOString(),
    providerTransmissionAcknowledged: true,
  });
  expect(configuredWakeScreenshot(dir)).toBeUndefined();
  expect(() => parseWakeScreenshotSurface("all")).toThrow();
  expect(parseWakeScreenshotSurface("off")).toBe("off");
});
