import fs from "node:fs";
import {
  WakeManager,
  managerFile,
  type WakePassage,
  type WakeBlockStep,
} from "../../daemon/wake-manager.js";
import { workspaceDirFor } from "../../daemon/paths.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import type { DataDir } from "../paths.js";
import type { CommandResult } from "../output.js";
import { withReadStore } from "./read.js";
import { StopFlag } from "../../runner/controls.js";

/** Explicit JSON operation; never configures rotation or changes owner controls. */
export async function wakePassages(ctx: CliContext, dir: DataDir): Promise<CommandResult<unknown>> {
  const raw = await ctx.readStdin?.();
  if (!raw || raw.length > 2_000_000) throw Error("Passages JSON missing or too large");
  const input = JSON.parse(raw) as {
    operation?: unknown;
    mode?: unknown;
    expectedRevision?: unknown;
    passages?: unknown;
    passageId?: unknown;
    steps?: unknown;
  };
  if (
    !input ||
    !Number.isSafeInteger(input.expectedRevision) ||
    (input.mode !== "validate" && input.mode !== "apply")
  )
    throw Error("Explicit mode and expectedRevision required");
  const profile = withReadStore(
    ctx,
    dir,
    ({ uow }) => uow?.profiles.get(DEFAULT_PROFILE_ID) ?? null,
  );
  if (!profile) throw Error("Wake profile unavailable");
  if (
    input.mode === "apply" &&
    (new StopFlag(dir.path).exists() ||
      profile.emergencyStopLocked ||
      ["paused", "checkpointing", "stopped", "disabled"].includes(profile.state))
  )
    throw Error("Wake est en pause ou arrêté. Le planning est conservé.");
  if (input.operation !== "import" && input.operation !== "plan")
    throw Error("Unknown passage operation");
  if (input.operation === "plan" && (input.mode !== "apply" || typeof input.passageId !== "string"))
    throw Error("Passage plan requires apply mode and passageId");
  const workspace = workspaceDirFor(dir.path);
  if (!fs.existsSync(managerFile(workspace))) throw Error("Planning unavailable");
  const manager = new WakeManager(workspace, { readOnly: input.mode === "validate" });
  try {
    const data =
      input.operation === "import"
        ? manager.importPassages(
            input.passages as WakePassage[],
            input.expectedRevision as number,
            input.mode,
          )
        : manager.planPassage(
            input.passageId as string,
            input.steps as WakeBlockStep[],
            input.expectedRevision as number,
          );
    return {
      exitCode: 0,
      data,
      human: () =>
        input.mode === "validate"
          ? "Passages validés sans enregistrement."
          : "Passages enregistrés.",
    };
  } finally {
    manager.close();
  }
}
