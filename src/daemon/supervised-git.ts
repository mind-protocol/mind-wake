import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ProcessTreeSupervisor } from "../runner/process-tree.js";
import type { ProfileId, SessionId } from "../contracts/index.js";
import { redactPrivatePaths, redactString } from "../journal/redact.js";
export class GitCommandError extends Error {
  constructor(
    operation: string,
    readonly transient: boolean,
    reason: "network" | "file-changed" = "network",
    readonly failureReason: GitFailureReason | null = null,
    /** Redacted excerpt of Git's own error lines (see gitErrorDetail); never part of `message`. */
    readonly detail: string | null = null,
  ) {
    super(
      `Git ${operation} failed${
        !transient
          ? `${failureReason ? ` (${failureReason})` : ""}; inspect the repository locally`
          : reason === "file-changed"
            ? " (a file changed while Git was reading it; retry in one minute)"
            : " (temporary network failure; retry in one minute)"
      }.`,
    );
  }
}
/** Fixed labels for non-network failures: enough to diagnose, without raw output, URLs or tokens. */
export type GitFailureReason =
  | "push-protection"
  | "file-too-large"
  | "pack-too-large"
  | "server-disconnect"
  | "rejected"
  | "auth";
const FAILURE_REASONS: readonly [GitFailureReason, RegExp][] = [
  ["push-protection", /GH013|push protection|secret scanning/i],
  ["file-too-large", /GH001|exceeds GitHub's file size limit/i],
  ["pack-too-large", /pack exceeds maximum allowed size|HTTP 413|request entity too large/i],
  [
    "server-disconnect",
    /RPC failed|hung up unexpectedly|unexpected disconnect|curl 92|early EOF|HTTP\/2 stream \d+ was not closed cleanly/i,
  ],
  ["auth", /authentication failed|could not read username|HTTP 40[13]|permission to .* denied/i],
  ["rejected", /\[(remote )?rejected\]|pre-receive hook declined|non-fast-forward/i],
];
export function gitFailureReason(stderr: string): GitFailureReason | null {
  return FAILURE_REASONS.find(([, pattern]) => pattern.test(stderr))?.[0] ?? null;
}
/**
 * Short excerpt of Git's error output for the operator: secrets, credentials in URLs and
 * private profile paths are masked, URLs are reduced to their host, and only the last
 * error-looking lines are kept (at most `max` characters).
 */
export function gitErrorDetail(stderr: string, max = 300): string | null {
  const lines = redactPrivatePaths(redactString(stderr))
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@]*@)?([^\s/:'"]+)[^\s'"]*/gi, "<$1>")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const errors = lines.filter((line) => /error|fatal|rejected|denied|declined|failed|^!/i.test(line));
  const text = (errors.length ? errors : lines).slice(-3).join(" | ");
  if (!text) return null;
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
}
/** Git reads a live workspace: a file rewritten mid-add is a race, not a broken repository. */
export const FILE_CHANGED_WHILE_INDEXING = /short read while indexing|file changed as we read it/i;
/** Remove only a newly-created lock after the supervised process is confirmed dead. */
export function cleanupKilledGitIndexLock(
  indexLock: string,
  existedBefore: boolean,
  killedBySupervisor: boolean,
  processExited: boolean,
): void {
  if (existedBefore || !killedBySupervisor || !processExited) return;
  try {
    fs.unlinkSync(indexLock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
/** Git subcommand after leading `-c key=value` options: `-c x=y push` is a push. */
export function gitOperation(args: readonly string[]): string {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i] ?? "operation";
}
/** Large workspace transfers outlast 30 s; local reads stay short. */
export function gitTimeoutMs(operation: string): number {
  return operation === "add" || operation === "commit" || operation === "push" ? 5 * 60_000 : 30_000;
}
/** No shell. Errors deliberately omit raw Git output, URLs and credentials. */
export async function git(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  environment: Record<string, string> = {},
): Promise<string> {
  if (signal?.aborted) throw Error("Git operation cancelled");
  // The native Job Object owns Git and descendants from creation, without PID races.
  // Its lifetime includes main-process exit and daemon death.
  const supervisor = new ProcessTreeSupervisor(path.join(os.tmpdir(), "mind-wake-git-runtime"));
  const child = supervisor.spawn("workspace-git" as ProfileId, randomUUID() as SessionId, {
    executable: process.execPath,
    args: [
      fileURLToPath(new URL("../../scripts/workspace-git-command.mjs", import.meta.url)),
      JSON.stringify(["-c", "credential.interactive=false", "-c", "core.askPass=", ...args]),
    ],
    cwd,
    env: {
      ...Object.fromEntries(
        [
          "PATH",
          "Path",
          "HOME",
          "USERPROFILE",
          "APPDATA",
          "LOCALAPPDATA",
          "PROGRAMFILES",
          "SSH_AUTH_SOCK",
        ].flatMap((key) => {
          const value = process.env[key];
          return value === undefined ? [] : [[key, value]];
        }),
      ),
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes",
      GIT_SSH_VARIANT: "ssh",
      MIND_WAKE_AUTO_PUSH_RUNNING: "1",
      ...environment,
    },
  });
  const cancellation = new AbortController();
  const indexLock = path.join(cwd, ".git", "index.lock");
  const hadIndexLock = fs.existsSync(indexLock);
  let killedBySupervisor = false;
  const stop = () => {
    cancellation.abort();
    killedBySupervisor = true;
    void child.terminateTree();
  };
  signal?.addEventListener("abort", stop, { once: true });
  const operation = gitOperation(args);
  const timeoutMs = gitTimeoutMs(operation);
  const timer = setTimeout(stop, timeoutMs);
  try {
    await child.started();
    const line = await child.readLine();
    const exit = await child.exited;
    if (cancellation.signal.aborted) throw new GitCommandError(operation, true);
    if (exit.mainExitCode !== 0 || line === null)
      throw new GitCommandError(operation, false);
    const result = JSON.parse(line) as { failed: boolean; stdout: string; stderr: string };
    if (result.failed && FILE_CHANGED_WHILE_INDEXING.test(result.stderr))
      throw new GitCommandError(operation, true, "file-changed");
    if (result.failed)
      throw new GitCommandError(
        operation,
        /could not resolve host|could not resolve hostname|failed to connect|connection timed out|connection reset|network is unreachable|unable to access.*(timeout|couldn.t connect)/i.test(
          result.stderr,
        ),
        "network",
        gitFailureReason(result.stderr),
        gitErrorDetail(result.stderr),
      );
    return result.stdout.trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    if (!child.hasExited) await child.terminateTree();
    // Only remove a lock this invocation could have created, and only after its
    // process tree has exited. Never clear a pre-existing owner's lock.
    cleanupKilledGitIndexLock(indexLock, hadIndexLock, killedBySupervisor, child.hasExited);
  }
}
