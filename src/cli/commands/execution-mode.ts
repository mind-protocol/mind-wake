import {
  executionMode,
  saveExecutionMode,
  type ExecutionMode,
} from "../../daemon/execution-mode.js";
import { consumeHumanWake, requestHumanWake } from "../../daemon/human-wake.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import type { DataDir } from "../paths.js";
import type { CommandResult } from "../output.js";
import { withReadStore } from "./read.js";
import { resume } from "./resume.js";

export function changeExecutionMode(
  ctx: CliContext,
  dataDir: DataDir,
  mode: ExecutionMode,
): CommandResult<{
  changed: boolean;
  mode: ExecutionMode;
  detail: string;
}> {
  const profile = withReadStore(
    ctx,
    dataDir,
    ({ uow }) => uow?.profiles.get(DEFAULT_PROFILE_ID) ?? null,
  );
  const refused = (detail: string): ReturnType<typeof changeExecutionMode> => ({
    exitCode: 1,
    data: { changed: false, mode: executionMode(dataDir.path), detail },
    human: (d) => d.detail,
  });
  if (
    !profile ||
    profile.emergencyStopLocked ||
    !["ready", "hibernating", "running", "checkpointing", "paused"].includes(profile.state)
  )
    return refused(
      "Mode indisponible : configurer ou réactiver explicitement le profil avant de changer de mode.",
    );
  if (profile.state === "paused") {
    const result = resume(ctx, dataDir);
    if (result.exitCode !== 0) return refused(result.data.detail);
  }
  const previous = executionMode(dataDir.path);
  saveExecutionMode(dataDir.path, mode);
  if (mode === "always-on") requestHumanWake(dataDir.path, ctx.now().getTime());
  else if (previous === "always-on") consumeHumanWake(dataDir.path);
  const detail =
    mode === "always-on"
      ? "Always-on : chaque réponse terminée déclenche la session suivante. Pause, arrêt et disponibilité du fournisseur restent appliqués."
      : "On : retour aux réveils planifiés.";
  return { exitCode: 0, data: { changed: true, mode, detail }, human: (d) => d.detail };
}
