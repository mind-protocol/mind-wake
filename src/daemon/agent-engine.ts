import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type Engine = "claude" | "codex";
export interface EngineChoice {
  preferred: Engine;
  revision: string;
}
const filename = "agent-engine.json";
export const alternate = (engine: Engine): Engine => (engine === "claude" ? "codex" : "claude");
export function engineChoice(dir: string): EngineChoice | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, filename), "utf8")) as EngineChoice;
    return (value.preferred === "claude" || value.preferred === "codex") &&
      typeof value.revision === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}
function write(dir: string, name: string, value: unknown) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const tmp = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
export function setEngineChoice(dir: string, preferred: Engine) {
  if (preferred !== "claude" && preferred !== "codex") throw Error("Moteur inconnu");
  const value = { preferred, revision: randomUUID() };
  write(dir, filename, value);
  return value;
}
function unavailableUntil(dir: string, engine: Engine, choice: EngineChoice): number {
  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(dir, "agent-engine-" + engine + ".json"), "utf8"),
    );
    return state.revision === choice.revision && Number.isFinite(state.until) ? state.until : 0;
  } catch {
    return 0;
  }
}
export function preferredEngine(dir: string, choice: EngineChoice): Engine {
  const other = alternate(choice.preferred);
  return unavailableUntil(dir, choice.preferred, choice) > Date.now() &&
    unavailableUntil(dir, other, choice) <= Date.now()
    ? other
    : choice.preferred;
}

/** A room's legacy retry barrier is bypassed only when its provider cause is known. */
export function engineAwareRetryAt(dir: string, retryAt: number, now = Date.now()): number {
  const choice = engineChoice(dir);
  if (!choice) return retryAt;
  const claudeUntil = unavailableUntil(dir, "claude", choice);
  const codexUntil = unavailableUntil(dir, "codex", choice);
  // Disk/runtime/unknown barriers must not become a model retry loop.
  if (retryAt > now && retryAt !== claudeUntil && retryAt !== codexUntil) return retryAt;
  if (claudeUntil > now && codexUntil > now) return Math.min(claudeUntil, codexUntil);
  // The shared router will choose the available backend without retrying the blocked one.
  return retryAt > now ? 0 : retryAt;
}
export function providerFailure(detail: string) {
  return /quota|rate.?limit|usage.?limit|429|overloaded|service unavailable|temporarily unavailable|provider\.rate_limited|authentication|auth_failed|not logged in|unauthorized|failed to connect|timed? ?out|délai Codex dépassé|system cannot find the file|fichier spécifié est introuvable|indisponible :|ECONNRESET|executable.*not found|exécutable.*introuvable|CreateProcess (?:2|3)\b|ENOENT|\b50[0234]\b/i.test(
    detail,
  );
}
export function recordEngineFailure(
  dir: string,
  choice: EngineChoice,
  engine: Engine,
  retryAt?: number | null,
) {
  write(dir, "agent-engine-" + engine + ".json", {
    revision: choice.revision,
    until: retryAt && retryAt > Date.now() ? retryAt : Date.now() + 60000,
  });
}
export async function launchAgentSession<T>(
  dir: string,
  original: Engine,
  run: (engine: Engine) => Promise<T>,
  failure: (result: T) => { retryAt?: number | null; replay: boolean } | null,
  allowed: () => boolean,
) {
  const choice = engineChoice(dir);
  if (!choice) return run(original);
  const first = preferredEngine(dir, choice);
  const second = alternate(first);
  const attempt = async (engine: Engine) => {
    let value: T;
    try {
      value = await run(engine);
    } catch (error) {
      if (providerFailure(String(error))) recordEngineFailure(dir, choice, engine);
      throw error;
    }
    const failed = failure(value);
    if (failed) recordEngineFailure(dir, choice, engine, failed.retryAt);
    return { value, failed };
  };
  try {
    const { value, failed } = await attempt(first);
    if (!failed?.replay || !allowed() || unavailableUntil(dir, second, choice) > Date.now())
      return value;
  } catch (error) {
    if (
      !providerFailure(String(error)) ||
      !allowed() ||
      unavailableUntil(dir, second, choice) > Date.now()
    )
      throw error;
  }
  return (await attempt(second)).value;
}
