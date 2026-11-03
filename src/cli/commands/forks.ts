import { FORK_IDS, readForks, runForks, sendToFork, setForkEnabled } from "../../daemon/forks.js";
import { workspaceDirFor } from "../../daemon/paths.js";
import { secondThreadProfileControl } from "./second-thread.js";
import type { CliContext } from "../context.js";
import type { DataDir } from "../paths.js";
import type { CommandResult } from "../output.js";
import { withReadStore } from "./read.js";
import { resolvePolicy } from "../../policy/index.js";
import { DEFAULT_PROFILE_ID } from "../context.js";

export async function forks(
  ctx: CliContext,
  dataDir: DataDir,
  action: string,
): Promise<CommandResult<unknown>> {
  const workspace = workspaceDirFor(dataDir.path);
  const profile = () => {
    const state = secondThreadProfileControl(ctx, dataDir);
    if (state === "stop") return state;
    return withReadStore(ctx, dataDir, ({ uow }) => {
      if (uow === null) return "stop" as const;
      const policy = resolvePolicy(uow.policies, DEFAULT_PROFILE_ID);
      return policy.status === "active" &&
        policy.revision.groups.runtime.adapterId === "codex" &&
        policy.revision.groups.runtime.nativeCapabilities === true
        ? state
        : ("stop" as const);
    });
  };
  if (action === "run") {
    const model = withReadStore(ctx, dataDir, ({ uow }) => {
      const policy = uow === null ? null : resolvePolicy(uow.policies, DEFAULT_PROFILE_ID);
      return policy?.status === "active" ? policy.revision.groups.runtime.model : undefined;
    });
    await runForks({
      dataDir: dataDir.path,
      workspace,
      profile,
      log: ctx.stderr,
      ...(model === undefined ? {} : { model }),
    });
  } else if (["on", "off", "send"].includes(action)) {
    const raw = JSON.parse((await ctx.readStdin?.()) ?? "{}") as { id?: unknown; text?: unknown };
    if (typeof raw.id !== "number" || !FORK_IDS.includes(raw.id as (typeof FORK_IDS)[number]))
      throw Error("Fork attendu : 2 à 8.");
    if (action === "on" && profile() === "stop")
      throw Error(
        "Fork indisponible : Wake nécessite un profil Codex natif actif et le consentement hôte.",
      );
    if (action === "send") {
      if (typeof raw.text !== "string") throw Error("Message manquant.");
      sendToFork(dataDir.path, raw.id, raw.text);
    } else setForkEnabled(dataDir.path, raw.id, action === "on");
  } else if (action !== "status") throw Error("Action de fork inconnue.");
  return {
    exitCode: 0,
    data: { ...readForks(dataDir.path, workspace), dataDir: dataDir.path, profile: profile() },
    human: () => "État des forks Codex.",
  };
}
