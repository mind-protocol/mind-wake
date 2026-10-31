/** Owns the entire cooperation in one Job Object, including all nested role jobs. */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ProcessTreeSupervisor,
  type ContainedCommand,
  type SessionProcess,
} from "../runner/process-tree.js";
import type { ProfileId, SessionId } from "../contracts/index.js";
import {
  assertConversationAllowed,
  inspectConversationRuntime,
  ConversationRuntimeBlocked,
  type RuntimeInspection,
} from "./role-runtime.js";

interface OwnerSupervisor {
  readonly available: boolean;
  spawn(profileId: ProfileId, sessionId: SessionId, command: ContainedCommand): SessionProcess;
  query(
    profileId: ProfileId,
    sessionId: SessionId,
    details?: boolean,
  ): {
    found: boolean | null;
    active: number | null;
    processes?: readonly { pid: number; name: string }[];
  };
}
export interface ConversationOwnerStarted {
  pid: number;
  profileId: ProfileId;
  sessionId: SessionId;
  jobName: string;
  maxProcesses: number;
}
export interface ConversationOwnerOptions {
  signal?: AbortSignal;
  pollMs?: number;
  onLog?: (line: string) => void | Promise<void>;
  onStarted?: (owner: ConversationOwnerStarted) => void;
  /** Test seams only; the production CLI accepts neither commands nor policies. */
  inspect?: () => RuntimeInspection;
  command?: ContainedCommand;
  supervisor?: OwnerSupervisor;
}
export interface ConversationOwnerResult {
  pid: number;
  exit: Awaited<SessionProcess["exited"]>;
  stopReason?: string;
  processControl: {
    immediateJobLimit: number;
    aggregateLimit: number;
    enforcement: "observed_fail_closed";
    largestObserved: number | null;
    transientOvershootPossible: true;
  };
}

/** Preserve native client/profile settings; credentials remain in their normal CLI stores. */
export function conversationOwnerEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        !/(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE)/i.test(entry[0]),
    ),
  );
}
export function conversationWorkerCommand(dataDir: string, id: string): ContainedCommand {
  const source = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(source ? "./worker.ts" : "./worker.js", import.meta.url));
  const args = source
    ? [
        "--experimental-transform-types",
        "--disable-warning=ExperimentalWarning",
        "--import",
        new URL("../../test/fixtures/store-ledger/ts-hooks.ts", import.meta.url).href,
        entry,
      ]
    : [entry];
  return {
    executable: process.execPath,
    args: [...args, "--data-dir", dataDir, "--conversation", id],
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { ...conversationOwnerEnv(), MIND_WAKE_DATA_DIR: dataDir },
  };
}

export async function serveConversationOwner(
  dataDir: string,
  id: string,
  options: ConversationOwnerOptions = {},
): Promise<ConversationOwnerResult> {
  if (!path.isAbsolute(dataDir) || !/^[A-Za-z0-9_.:-]{1,200}$/.test(id))
    throw Error("Explicit absolute profile and conversation required");
  const initial = options.inspect ? options.inspect() : assertConversationAllowed(dataDir);
  if (!initial.allowed) throw new ConversationRuntimeBlocked(initial.reason);
  const maxProcesses = initial.revision.groups.filesAndTools.maxProcesses;
  if (!Number.isSafeInteger(maxProcesses) || maxProcesses < 1)
    throw new ConversationRuntimeBlocked("global_process_limit_unknown");
  if (options.signal?.aborted) throw new DOMException("Conversation owner cancelled", "AbortError");
  const supervisor =
    options.supervisor ?? new ProcessTreeSupervisor(path.join(dataDir, "conversation-runtime"));
  if (!supervisor.available)
    throw new ConversationRuntimeBlocked("global_process_supervisor_unavailable");
  const check = (): string | null => {
    if (options.signal?.aborted) return "owner_cancelled";
    const current = options.inspect ? options.inspect() : inspectConversationRuntime(dataDir);
    if (!current.allowed) return current.reason;
    if (current.revision.id !== initial.revision.id) return "policy_changed";
    if (current.revision.groups.filesAndTools.maxProcesses !== maxProcesses)
      return "global_process_limit_changed";
    return null;
  };
  // Compiling the launcher can take time: check controls again at the actual spawn.
  const before = check();
  if (before) throw new ConversationRuntimeBlocked(before);
  const sessionId = `conversation-owner-${randomUUID()}` as SessionId;
  const command = options.command ?? conversationWorkerCommand(dataDir, id);
  const child = supervisor.spawn(initial.profileId, sessionId, { ...command, maxProcesses });
  let started = false;
  let mainPid: number | undefined;
  const processControl: ConversationOwnerResult["processControl"] = {
    immediateJobLimit: maxProcesses,
    aggregateLimit: maxProcesses,
    enforcement: "observed_fail_closed",
    largestObserved: null,
    transientOvershootPossible: true,
  };
  let stopped: Promise<unknown> | undefined, stopReason: string | undefined;
  const stop = (reason: string) => {
    if (stopped) return;
    stopReason = reason;
    stopped = child.terminateTree(1000);
  };
  const abort = () => {
    stop("owner_cancelled");
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setInterval(() => {
    try {
      const reason = check();
      if (reason) stop(reason);
      if (started && !stopped) {
        const processes = supervisor.query(initial.profileId, sessionId);
        if (processes.active !== null)
          processControl.largestObserved = Math.max(
            processControl.largestObserved ?? 0,
            processes.active,
          );
        if (processes.found !== true || processes.active === null) {
          // The job can disappear just before the exit notification reaches Node.
          let mainAlive = false;
          if (mainPid !== undefined)
            try {
              process.kill(mainPid, 0);
              mainAlive = true;
            } catch {
              /* Owned main process exited. */
            }
          if (!child.hasExited && mainAlive) stop("global_process_count_unknown");
        } else if (processes.active > maxProcesses) {
          const details = supervisor.query(initial.profileId, sessionId, true);
          process.stdout.write(
            JSON.stringify({
              schema: "mind.conversation/process-limit",
              conversationId: id,
              active: processes.active,
              limit: maxProcesses,
              processes: details.processes ?? [],
            }) + "\n",
          );
          stop("global_process_limit_exceeded");
        }
      }
    } catch {
      stop("control_unavailable");
    }
  }, options.pollMs ?? 100);
  timer.unref();
  let logError: Error | undefined;
  const logs = (async () => {
    let line;
    while ((line = await child.readLine()) !== null) {
      if (options.onLog) await options.onLog(line);
      else process.stdout.write(line + "\n");
    }
  })().catch((error: unknown) => {
    logError = error instanceof Error ? error : new Error(String(error));
    stop("log_forwarding_failed");
  });
  try {
    const pid = await child.started();
    mainPid = pid;
    started = true;
    options.onStarted?.({
      pid,
      profileId: initial.profileId,
      sessionId,
      jobName: child.jobName,
      maxProcesses,
    });
    const after = check();
    if (after) stop(after);
    const exit = await child.exited;
    await logs;
    await stopped;
    if (logError) throw logError;
    const result = { pid, exit, processControl, ...(stopReason ? { stopReason } : {}) };
    process.stdout.write(
      JSON.stringify({
        schema: "mind.conversation/owner-control",
        conversationId: id,
        pid,
        sessionId,
        exit,
        processControl,
        stopReason: stopReason ?? null,
      }) + "\n",
    );
    return result;
  } finally {
    clearInterval(timer);
    options.signal?.removeEventListener("abort", abort);
    if (!child.hasExited) await child.terminateTree(1000);
    await stopped;
    await logs;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({
    options: { "data-dir": { type: "string" }, conversation: { type: "string" } },
  });
  if (!values["data-dir"] || !values.conversation)
    throw Error("Explicit conversation and profile required");
  const controller = new AbortController(),
    stop = () => {
      controller.abort();
    };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await serveConversationOwner(
      path.resolve(values["data-dir"]),
      values.conversation,
      {
        signal: controller.signal,
      },
    );
    if (!result.stopReason && result.exit.mainExitCode !== 0)
      process.exitCode = result.exit.mainExitCode ?? 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
