/** Opt-in, single Windows capture, resized in RAM; no screenshot file. */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WakeImage } from "../contracts/wake-image.js";
import { freshWakeImage } from "../adapters/wake-image.js";
export type WakeScreenshotSurface = WakeImage["surface"];
export type WakeScreenshotChoice = WakeScreenshotSurface | "off";
export function captureClickPoint(env: Readonly<Record<string, string | undefined>>): { x: number; y: number } | undefined {
  const x = env["MIND_WAKE_CAPTURE_CLICK_X"], y = env["MIND_WAKE_CAPTURE_CLICK_Y"];
  if (x === undefined || y === undefined || !/^-?\d+$/.test(x) || !/^-?\d+$/.test(y)) return undefined;
  const point = { x: Number(x), y: Number(y) };
  return [point.x, point.y].every(n => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647) ? point : undefined;
}
export function parseWakeScreenshotSurface(
  value: string | undefined,
): WakeScreenshotChoice | undefined {
  if (value === undefined) return undefined;
  if (value === "primary" || value === "wake-window" || value === "off") return value;
  throw new Error("--wake-screenshot : choisir primary, wake-window ou off");
}
/** Local administrator setting, outside the agent workspace. Never expands to another surface. */
export function configuredWakeScreenshot(
  dataDir: string,
  override?: WakeScreenshotChoice,
): WakeScreenshotSurface | undefined {
  if (override === "off") return undefined;
  try {
    const file = path.join(dataDir, "installation", "wake-screenshot.json");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) return undefined;
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (value["enabled"] === false) return undefined;
    if (override !== undefined) return override;
    if (
      value["enabled"] !== true ||
      value["providerTransmissionAcknowledged"] !== true ||
      typeof value["authorizedAt"] !== "string" ||
      !Number.isFinite(Date.parse(value["authorizedAt"]))
    )
      return undefined;
    return value["surface"] === "primary" || value["surface"] === "wake-window"
      ? value["surface"]
      : undefined;
  } catch {
    return override;
  }
}
export async function captureWakeScreenshot(
  surface: WakeScreenshotSurface,
): Promise<WakeImage | undefined> {
  if (process.platform !== "win32") return undefined;
  const script = fileURLToPath(
    new URL("../../src/daemon/wake-screenshot-native.ps1", import.meta.url),
  );
  if (!fs.existsSync(script)) return undefined;
  const desktop = fileURLToPath(
    new URL("../../desktop/src-tauri/target/debug/mind-wake-desktop.exe", import.meta.url),
  );
  const env: Record<string, string> = {
    MIND_WAKE_CAPTURE_SURFACE: surface,
    MIND_WAKE_CAPTURE_DESKTOP: desktop,
  };
  const point = surface === "primary" ? captureClickPoint(process.env) : undefined;
  if (point) {
    env["MIND_WAKE_CAPTURE_CLICK_X"] = String(point.x);
    env["MIND_WAKE_CAPTURE_CLICK_Y"] = String(point.y);
    for (const key of ["MIND_WAKE_CAPTURE_CLICK_AT_MS", "MIND_WAKE_CAPTURE_CLICK_ROOT"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
  }
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", script],
      { windowsHide: true, env, timeout: 8000, maxBuffer: 2_000_000 },
      (error, stdout) => {
        if (error) return resolve(undefined);
        try {
          const image = freshWakeImage(JSON.parse(stdout.trim()) as WakeImage);
          resolve(image ?? undefined);
        } catch {
          resolve(undefined);
        }
      },
    );
  });
}
