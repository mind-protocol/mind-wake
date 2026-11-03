import { readProjectWakeObjectives } from "../../daemon/wake-preview.js";
import {
  readSecondThread,
  runSecondThread,
  saveSecondThreadEnabled,
  sendToSecondThread,
  type SecondThreadControl,
  type SecondThreadView,
} from "../../daemon/second-thread.js";
import { workspaceDirFor } from "../../daemon/paths.js";
import { resolvePolicy } from "../../policy/index.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import type { DataDir } from "../paths.js";
import type { CommandResult } from "../output.js";
import { withReadStore } from "./read.js";

/** `hold` en pause, `stop` après Force-off ou sans consentement au mode hôte. */
export function secondThreadProfileControl(ctx: CliContext, dataDir: DataDir): SecondThreadControl {
  return withReadStore(ctx, dataDir, ({ uow }) => {
    const profile = uow?.profiles.get(DEFAULT_PROFILE_ID) ?? null;
    if (
      uow === null ||
      profile === null ||
      profile.emergencyStopLocked ||
      ["stopped", "disabled"].includes(profile.state)
    )
      return "stop";
    const policy = resolvePolicy(uow.policies, DEFAULT_PROFILE_ID);
    if (
      policy.status !== "active" ||
      policy.revision.groups.runtime.hostUnsandboxedAcknowledged !== true
    )
      return "stop";
    return ["paused", "checkpointing"].includes(profile.state) ? "hold" : "run";
  });
}

type View = SecondThreadView & { projectWakes: ReturnType<typeof readProjectWakeObjectives>; dataDir: string; detail: string; profile: SecondThreadControl };

function view(ctx: CliContext, dataDir: DataDir, detail: string): View {
  const state = readSecondThread(dataDir.path);
  return {
    ...state,
    projectWakes: readProjectWakeObjectives(workspaceDirFor(dataDir.path),state.position?.projectId ?? null,state.position?.inBlock ?? 0),
    dataDir: dataDir.path,
    detail,
    profile: secondThreadProfileControl(ctx, dataDir),
  };
}

export async function secondThread(
  ctx: CliContext,
  dataDir: DataDir,
  action: string | undefined,
): Promise<CommandResult<unknown>> {
  switch (action ?? "status") {
    case "status":
      return {
        exitCode: 0,
        data: view(ctx, dataDir, "État du second fil."),
        human: (d) => (d as View).detail,
      };
    case "on": {
      if (secondThreadProfileControl(ctx, dataDir) === "stop")
        return {
          exitCode: 1,
          data: view(
            ctx,
            dataDir,
            "Second fil indisponible : profil arrêté ou mode hôte non consenti.",
          ),
          human: (d) => (d as View).detail,
        };
      saveSecondThreadEnabled(dataDir.path, true);
      return {
        exitCode: 0,
        data: view(ctx, dataDir, "Second fil Claude Code activé."),
        human: (d) => (d as View).detail,
      };
    }
    case "off":
      saveSecondThreadEnabled(dataDir.path, false);
      return {
        exitCode: 0,
        data: view(ctx, dataDir, "Second fil désactivé ; son historique est conservé."),
        human: (d) => (d as View).detail,
      };
    case "send": {
      const raw = (await ctx.readStdin?.()) ?? "";
      const entry = sendToSecondThread(dataDir.path, raw);
      return {
        exitCode: 0,
        data: entry,
        human: () => "Message ajouté au second fil ; il sera lu au prochain tour.",
      };
    }
    case "run": {
      const summary = await runSecondThread({
        dataDir: dataDir.path,
        workspace: () => workspaceDirFor(dataDir.path),
        profile: () => secondThreadProfileControl(ctx, dataDir),
        log: (line) => {
          ctx.stderr(`${new Date().toISOString()} ${line}`);
        },
      });
      return {
        exitCode: 0,
        data: summary,
        human: () => `Second fil arrêté : ${summary.reason} (${String(summary.turns)} tours).`,
      };
    }
    default:
      throw Error(`action inconnue du second fil : ${action ?? ""}`);
  }
}
