/** Explicit handoff from the autonomous scheduler to message-driven conversations. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import type { ProfileId, UtcTimestamp } from "../contracts/index.js";
import { latestDaemonRun, isProcessAlive, type DaemonRun } from "../daemon/runs.js";
import { controlDbPath } from "../daemon/paths.js";
import { acquireInstanceLock, instanceLockPath } from "../scheduler/instance-lock.js";
import { openStore, openStoreReadOnly } from "../store/index.js";
import { ProcessTreeSupervisor } from "../runner/process-tree.js";
import { SessionRunner } from "../runner/runner.js";
import { runtimeDirFor } from "../runner/paths.js";
import { StopFlag } from "../runner/controls.js";
import { FakeAdapter, fakeScenario } from "../adapters/fake/index.js";
import { prepareJournalEvent } from "../journal/index.js";

export const CONVERSATION_MODE_FILE = "conversation-mode.json";
const PROFILE = "default" as ProfileId;
export interface ConversationModeState {
  enabled: boolean;
  ready: boolean;
  requestedAt: string | null;
  activatedAt: string | null;
  detail: string | null;
}
export interface ConversationModeOptions {
  /** Injection boundary for isolated tests; production uses the authenticated owner. */
  stopOwnedEngine?: () => Promise<void>;
  /** Must prove that no legacy engine can wake after the handoff. */
  assertSchedulerStopped?: () => void;
  /** Recovery-only seam; never used to launch an adapter. */
  recoverySupervisor?: ProcessTreeSupervisor;
}
function ordinary(file: string, maxBytes = 4096): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes)
    throw Error("Unsafe conversation mode file");
}
export function inspectConversationMode(dataDir: string): ConversationModeState {
  const file = path.join(dataDir, CONVERSATION_MODE_FILE);
  try {
    fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { enabled: false, ready: false, requestedAt: null, activatedAt: null, detail: null };
    throw error;
  }
  try {
    ordinary(file);
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (
      value["version"] !== 1 ||
      value["mode"] !== "conversation" ||
      value["enabled"] !== true ||
      typeof value["ready"] !== "boolean" ||
      typeof value["requestedAt"] !== "string" ||
      !Number.isFinite(Date.parse(value["requestedAt"]))
    )
      throw Error("Invalid conversation mode state");
    return {
      enabled: true,
      ready: value["ready"],
      requestedAt: value["requestedAt"],
      activatedAt: typeof value["activatedAt"] === "string" ? value["activatedAt"] : null,
      detail: typeof value["detail"] === "string" ? value["detail"] : null,
    };
  } catch {
    // A damaged handoff flag cannot silently restore the old autonomous scheduler.
    return {
      enabled: true,
      ready: false,
      requestedAt: null,
      activatedAt: null,
      detail: "Conversation mode state is invalid; autonomous wakes remain disabled",
    };
  }
}
export const inspectMode = inspectConversationMode;

function writeMode(dataDir: string, state: ConversationModeState): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, CONVERSATION_MODE_FILE);
  try {
    ordinary(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(dataDir, `.conversation-mode-${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({ version: 1, mode: "conversation", ...state }, null, 2) + "\n",
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
async function stopOwnedEngine(dataDir: string): Promise<void> {
  const manifest = path.join(dataDir, "installation", "manifest.json");
  if (!fs.existsSync(manifest)) return;
  ordinary(manifest, 262144);
  const binding = JSON.parse(fs.readFileSync(manifest, "utf8")) as { dataDir?: unknown };
  if (
    typeof binding.dataDir !== "string" ||
    path.resolve(binding.dataDir) !== path.resolve(dataDir)
  )
    throw Error("Engine manifest does not belong to this conversation profile");
  const modulePath = fileURLToPath(new URL("../../scripts/owned-runtime.mjs", import.meta.url));
  const owned = (await import(pathToFileURL(modulePath).href)) as {
    ownedComponents: (
      file: string,
      role: string,
      op: string,
      signal: AbortSignal,
    ) => Promise<{ members: { component: { state: string } }[] }>;
  };
  try {
    const result = await owned.ownedComponents(
      manifest,
      "daemon",
      "stop",
      new AbortController().signal,
    );
    if (result.members.some((member) => member.component.state !== "stopped"))
      throw Error("Legacy engine owner did not confirm its stop");
  } catch (error) {
    // Already loaded owners predate the stop operation. Authenticate their presence
    // before using the existing desktop process-identity verification fallback.
    const observed = await owned.ownedComponents(
      manifest,
      "daemon",
      "observe",
      new AbortController().signal,
    );
    if (
      process.platform !== "win32" ||
      observed.members.length !== 1 ||
      observed.members[0]?.component.state !== "running"
    )
      throw error;
    const run = readEngineRun(dataDir);
    if (!run || run.endedAt !== null || !isProcessAlive(run.pid)) throw error;
    const script = fileURLToPath(
      new URL("../../desktop/src-tauri/src/restart-engine.ps1", import.meta.url),
    );
    await promisify(execFile)(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", fs.readFileSync(script, "utf8")],
      {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 65536,
        env: {
          ...process.env,
          WAKE_RESTART_PID: String(run.pid),
          WAKE_RESTART_STARTED: run.startedAt,
        },
      },
    );
    if (isProcessAlive(run.pid))
      throw Error("Verified legacy engine did not stop", { cause: error });
  }
}
function readEngineRun(dataDir: string): DaemonRun | null {
  const file = controlDbPath(dataDir);
  if (!fs.existsSync(file)) return null;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return latestDaemonRun(db, PROFILE);
  } finally {
    db.close();
  }
}
function assertSchedulerStopped(dataDir: string): void {
  const latest = readEngineRun(dataDir);
  if (latest?.endedAt === null && isProcessAlive(latest.pid))
    throw Error("A legacy engine is still alive; its owner must stop it before activation");
}

/** Keep the emergency marker until the separate explicit activation clears it. */
class PreservedStopFlag extends StopFlag {
  override clear(): void {}
}
function reconcileLegacySessions(dataDir: string, injected?: ProcessTreeSupervisor): void {
  const file = controlDbPath(dataDir);
  if (!fs.existsSync(file)) return;
  const check = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (!check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get())
      return;
  } finally {
    check.close();
  }
  const reader = openStoreReadOnly(file);
  let needsRecovery: boolean;
  try {
    const profile = reader.uow.profiles.get(PROFILE);
    needsRecovery =
      reader.uow.sessions.listOpen(PROFILE).length > 0 ||
      profile?.state === "running" ||
      profile?.state === "checkpointing" ||
      (new StopFlag(dataDir).exists() && profile?.emergencyStopLocked !== true);
  } finally {
    reader.close();
  }
  if (!needsRecovery) return;
  const store = openStore(file),
    supervisor = injected ?? new ProcessTreeSupervisor(runtimeDirFor(dataDir));
  try {
    // Runner recovery accepts unknown process states. This handoff is stricter:
    // prove every old model tree is gone before closing any persisted session.
    for (const session of store.uow.sessions.listOpen(PROFILE)) {
      const found = supervisor.query(PROFILE, session.id);
      if (found.found === null)
        throw Error("Cannot prove that a legacy model process tree has stopped");
      if (found.found) {
        const stopped = supervisor.terminate(PROFILE, session.id, 1000);
        if (!stopped.confirmed || supervisor.query(PROFILE, session.id).found !== false)
          throw Error("A legacy model process tree did not confirm its stop");
      }
    }
    const runner = new SessionRunner({
      uow: store.uow,
      profileId: PROFILE,
      supervisor,
      stopFlag: new PreservedStopFlag(dataDir),
      liveChecks: () => ({ onSubscription: false, sandboxOperational: false }),
      // Reconciliation calls no adapter methods and launches no process/model.
      adapter: (host) => new FakeAdapter({ host, scenario: fakeScenario("success") }),
    });
    runner.reconcileAtStartup();
    const profile = store.uow.profiles.get(PROFILE);
    if (
      profile &&
      !profile.emergencyStopLocked &&
      (profile.state === "running" || profile.state === "checkpointing") &&
      store.uow.sessions.listOpen(PROFILE).length === 0
    ) {
      const at = new Date().toISOString() as UtcTimestamp;
      store.uow.profiles.transition(PROFILE, {
        from: profile.state,
        to: "blocked",
        at,
        reason:
          "Legacy scheduler stopped; human activation must revalidate the conversation profile",
      });
      store.uow.journal.append(
        prepareJournalEvent({
          type: "profile_state_changed",
          profileId: PROFILE,
          at,
          reason:
            "Legacy scheduler stopped; human activation must revalidate the conversation profile",
          metadata: { from: profile.state, to: "blocked" },
        }),
      );
    }
  } finally {
    store.close();
  }
}

/** This never clears Pause, Force-off or profile policy. CLI activation does that separately. */
export async function enableConversationMode(
  dataDir: string,
  options: ConversationModeOptions = {},
): Promise<ConversationModeState> {
  const before = inspectConversationMode(dataDir),
    requestedAt = before.requestedAt ?? new Date().toISOString();
  const pending: ConversationModeState = {
    enabled: true,
    ready: false,
    requestedAt,
    activatedAt: null,
    detail: "Stopping the autonomous engine",
  };
  writeMode(dataDir, pending); // Commit the new launch guard before any engine operation.
  try {
    await (options.stopOwnedEngine ?? (() => stopOwnedEngine(dataDir)))();
    (
      options.assertSchedulerStopped ??
      (() => {
        assertSchedulerStopped(dataDir);
      })
    )();
    // The scheduler lock proves more than a possibly stale PID report.
    const lock = acquireInstanceLock(instanceLockPath(dataDir, PROFILE));
    try {
      reconcileLegacySessions(dataDir, options.recoverySupervisor);
      const ready: ConversationModeState = {
        enabled: true,
        ready: true,
        requestedAt,
        activatedAt: new Date().toISOString(),
        detail: null,
      };
      writeMode(dataDir, ready);
      return ready;
    } finally {
      lock.release();
    }
  } catch (error) {
    writeMode(dataDir, {
      ...pending,
      detail: error instanceof Error ? error.message : "Legacy engine handoff failed",
    });
    throw error;
  }
}
