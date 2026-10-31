import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ProcessTreeSupervisor } from "../runner/process-tree.js";
import type { ProfileId, SessionId } from "../contracts/index.js";
export class GitCommandError extends Error {
  constructor(
    operation: string,
    readonly transient: boolean,
  ) {
    super(
      `Git ${operation} failed${transient ? " (temporary network failure; retry in one minute)" : "; inspect the repository locally"}.`,
    );
  }
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
  const stop = () => {
    cancellation.abort();
    void child.terminateTree();
  };
  signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, 30_000);
  try {
    await child.started();
    const line = await child.readLine();
    const exit = await child.exited;
    if (cancellation.signal.aborted) throw new GitCommandError(args[0] ?? "operation", true);
    if (exit.mainExitCode !== 0 || line === null)
      throw new GitCommandError(args[0] ?? "operation", false);
    const result = JSON.parse(line) as { failed: boolean; stdout: string; stderr: string };
    if (result.failed)
      throw new GitCommandError(
        args[0] ?? "operation",
        /could not resolve host|could not resolve hostname|failed to connect|connection timed out|connection reset|network is unreachable|unable to access.*(timeout|couldn.t connect)/i.test(
          result.stderr,
        ),
      );
    return result.stdout.trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    if (!child.hasExited) await child.terminateTree();
  }
}
