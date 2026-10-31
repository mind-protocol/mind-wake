import {
  configureWorkspaceSync,
  requestWorkspaceSync,
  workspaceSyncStatus,
} from "../../daemon/workspace-git-sync.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import type { DataDir } from "../paths.js";
import type { CommandResult } from "../output.js";
import { withReadStore } from "./read.js";

export async function workspaceSync(
  ctx: CliContext,
  dir: DataDir,
  action: string,
  input: { workspaceDir?: string; githubUrl?: string; enabled?: string },
): Promise<CommandResult<ReturnType<typeof workspaceSyncStatus>>> {
  const profile = withReadStore(
    ctx,
    dir,
    ({ uow }) => uow?.profiles.get(DEFAULT_PROFILE_ID) ?? null,
  );
  if (!profile) throw Error("Configure the existing Wake profile first");
  if (action === "configure") {
    if (
      input.workspaceDir === undefined ||
      input.githubUrl === undefined ||
      !["true", "false"].includes(input.enabled ?? "")
    )
      throw Error("Configure requires --workspace, --github-url and --enabled true|false");
    await configureWorkspaceSync(dir.path, {
      workspaceDir: input.workspaceDir,
      githubUrl: input.githubUrl,
      enabled: input.enabled === "true",
    });
  } else if (action === "now") {
    if (
      profile.emergencyStopLocked ||
      ["paused", "checkpointing", "stopped", "disabled"].includes(profile.state)
    )
      throw Error("Wake is paused or stopped");
    requestWorkspaceSync(dir.path);
  } else if (action !== "status") throw Error("Use workspace-sync status|configure|now");
  return { exitCode: 0, data: workspaceSyncStatus(dir.path), human: (d) => JSON.stringify(d) };
}
