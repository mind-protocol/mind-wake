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
const defaultChoice: EngineChoice = { preferred: "claude", revision: "global-default-claude" };
export function engineChoice(dir: string): EngineChoice {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, filename), "utf8")) as EngineChoice;
    return (value.preferred === "claude" || value.preferred === "codex") &&
      typeof value.revision === "string"
      ? value
      : defaultChoice;
  } catch {
    return defaultChoice;
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
/** The selected provider is global and never changes after a provider failure. */
export function preferredEngine(_dir: string, choice: EngineChoice): Engine {
  return choice.preferred;
}

/** Only a cooldown proven to belong to the other provider may be bypassed. */
export function engineAwareRetryAt(dir: string, retryAt: number, now = Date.now()): number {
  const choice = engineChoice(dir);
  const selectedUntil = unavailableUntil(dir, choice.preferred, choice);
  const otherUntil = unavailableUntil(dir, alternate(choice.preferred), choice);
  const localRetry = retryAt > now && retryAt === otherUntil && retryAt !== selectedUntil ? 0 : retryAt;
  return Math.max(localRetry, selectedUntil > now ? selectedUntil : 0);
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
  _original: Engine,
  run: (engine: Engine) => Promise<T>,
  failure: (result: T) => { retryAt?: number | null; replay: boolean } | null,
  _allowed: () => boolean,
) {
  const choice = engineChoice(dir);
  const engine = choice.preferred;
  try {
    const value = await run(engine);
    const failed = failure(value);
    if (failed) recordEngineFailure(dir, choice, engine, failed.retryAt);
    return value;
  } catch (error) {
    if (providerFailure(String(error))) recordEngineFailure(dir, choice, engine);
    throw error;
  }
}
