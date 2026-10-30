/** Agent-owned restriction of already authorized ambient captures. No permissions granted here. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WakeImage } from "../contracts/wake-image.js";
import type { IdleObservation } from "../scheduler/priority.js";
import type { WakeScreenshotSurface } from "./wake-screenshot.js";

export const SCREENSHOT_AUTO_IDLE_MS = 60_000;
export const SCREENSHOT_SIGNAL_MAX_AGE_MS = 2_000;
export const SCREENSHOT_STATE_FILE = "agent-screenshot-mode.json";
export interface AgentScreenshotPolicy {
  readonly mode: "on" | "off" | "auto";
  readonly idleThresholdMs: number;
}
export interface ScreenshotDecision {
  readonly mode: AgentScreenshotPolicy["mode"] | "invalid";
  readonly reason:
    | "not-authorized"
    | "agent-off"
    | "invalid-policy"
    | "on"
    | "auto-idle"
    | "auto-active"
    | "auto-unknown";
  readonly surface?: WakeScreenshotSurface;
}

/** Missing setting preserves existing behavior. Unreadable/malformed data suppresses captures. */
function readSmallJson(file: string): unknown {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
    throw new Error("invalid policy file");
  const fd = fs.openSync(file, "r");
  try {
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.size > 4096 ||
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev
    )
      throw new Error("policy file changed");
    const buffer = Buffer.alloc(4097);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > 4096) throw new Error("oversized policy");
    return JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

export function readAgentScreenshotPolicy(
  artifactsDir: string,
  fallback: AgentScreenshotPolicy | null = { mode: "on", idleThresholdMs: SCREENSHOT_AUTO_IDLE_MS },
): AgentScreenshotPolicy | null {
  let raw: unknown;
  try {
    const file = path.join(artifactsDir, "pilote.json");
    raw = readSmallJson(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const pilot = raw as Record<string, unknown>;
  if (pilot["version"] !== 1) return null;
  const setting = pilot["wakeScreenshot"];
  if (setting === undefined) return fallback;
  if (setting === null || typeof setting !== "object" || Array.isArray(setting)) return null;
  const fields = setting as Record<string, unknown>;
  const mode = fields["mode"];
  const idle =
    fields["idleThresholdMs"] === undefined ? SCREENSHOT_AUTO_IDLE_MS : fields["idleThresholdMs"];
  if (mode !== "on" && mode !== "off" && mode !== "auto") return null;
  if (!Number.isSafeInteger(idle) || (idle as number) < 1 || (idle as number) > 86_400_000)
    return null;
  return { mode, idleThresholdMs: idle as number };
}

/** Durable fallback survives a compaction-only rewrite, deletion, or daemon restart. */
function effectivePolicy(artifactsDir: string, stateDir?: string): AgentScreenshotPolicy | null {
  if (stateDir === undefined) return readAgentScreenshotPolicy(artifactsDir);
  const file = path.join(stateDir, SCREENSHOT_STATE_FILE);
  let saved: AgentScreenshotPolicy | null | undefined;
  try {
    const raw = readSmallJson(file) as Record<string, unknown> | null;
    saved =
      raw !== null &&
      raw["version"] === 1 &&
      (raw["mode"] === "on" || raw["mode"] === "off" || raw["mode"] === "auto") &&
      Number.isSafeInteger(raw["idleThresholdMs"]) &&
      (raw["idleThresholdMs"] as number) >= 1 &&
      (raw["idleThresholdMs"] as number) <= 86_400_000
        ? { mode: raw["mode"], idleThresholdMs: raw["idleThresholdMs"] as number }
        : null;
  } catch (error) {
    saved = (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
  const policy =
    saved === undefined
      ? readAgentScreenshotPolicy(artifactsDir)
      : readAgentScreenshotPolicy(artifactsDir, saved);
  if (policy === null) return null;
  if (saved?.mode === policy.mode && saved.idleThresholdMs === policy.idleThresholdMs)
    return policy;
  const temporary = path.join(stateDir, `.agent-screenshot-${randomUUID()}.tmp`);
  try {
    // Never replace an unexpected symlink or non-file left at the state path.
    if (
      fs.existsSync(file) &&
      (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
    )
      return null;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, ...policy }), {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
    return policy;
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* A failed state write remains fail-closed. */
    }
  }
}

export function decideAgentScreenshot(
  artifactsDir: string,
  authorizedSurface: WakeScreenshotSurface | undefined,
  observation: IdleObservation | null,
  now = Date.now(),
  stateDir?: string,
): ScreenshotDecision {
  const policy = effectivePolicy(artifactsDir, stateDir);
  const mode = policy?.mode ?? "invalid";
  if (authorizedSurface === undefined) return { mode, reason: "not-authorized" };
  if (policy === null) return { mode, reason: "invalid-policy" };
  if (mode === "off") return { mode, reason: "agent-off" };
  if (mode === "on") return { mode, reason: "on", surface: authorizedSurface };
  if (
    observation === null ||
    !Number.isSafeInteger(observation.idleMs) ||
    observation.idleMs < 0 ||
    !Number.isFinite(observation.observedAtMs) ||
    now < observation.observedAtMs ||
    now - observation.observedAtMs > SCREENSHOT_SIGNAL_MAX_AGE_MS
  )
    return { mode, reason: "auto-unknown" };
  return observation.idleMs >= policy.idleThresholdMs
    ? { mode, reason: "auto-idle", surface: authorizedSurface }
    : { mode, reason: "auto-active" };
}

/** Recheck consent, agent choice and activity after the asynchronous native capture. */
export async function collectAgentScreenshot(options: {
  artifactsDir: string;
  stateDir: string;
  authorizedSurface: () => WakeScreenshotSurface | undefined;
  observation: () => IdleObservation | null;
  capture: (surface: WakeScreenshotSurface) => Promise<WakeImage | undefined>;
  now?: () => number;
}): Promise<{ decision: ScreenshotDecision; image?: WakeImage; discardedAfterCapture: boolean }> {
  const decide = () =>
    decideAgentScreenshot(
      options.artifactsDir,
      options.authorizedSurface(),
      options.observation(),
      (options.now ?? Date.now)(),
      options.stateDir,
    );
  const before = decide();
  if (before.surface === undefined) return { decision: before, discardedAfterCapture: false };
  const image = await options.capture(before.surface);
  const after = decide();
  const allowed = after.surface === before.surface;
  return {
    decision: after,
    ...(allowed && image !== undefined ? { image } : {}),
    discardedAfterCapture: image !== undefined && !allowed,
  };
}
