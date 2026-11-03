import { WakeManager, managerFile } from "../../daemon/wake-manager.js";
import { workspaceDirFor } from "../../daemon/paths.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import type { DataDir } from "../paths.js";
import type { CommandResult } from "../output.js";
import { withReadStore } from "./read.js";
import fs from "node:fs";

export async function wakeOrder(ctx: CliContext, dir: DataDir): Promise<CommandResult<{revision: number}>> {
  const profile = withReadStore(ctx, dir, ({uow}) => uow?.profiles.get(DEFAULT_PROFILE_ID) ?? null);
  if (!profile || profile.emergencyStopLocked || ["paused", "checkpointing", "stopped", "disabled"].includes(profile.state))
    throw Error("Wake est en pause ou arrêté. Le planning est conservé.");
  const raw = await ctx.readStdin?.();
  if (!raw || raw.length > 16000) throw Error("Ordre de projets manquant ou trop volumineux.");
  const input = JSON.parse(raw) as {revision?: unknown; projectIds?: unknown};
  if (!input || !Number.isSafeInteger(input.revision) || !Array.isArray(input.projectIds)) throw Error("Ordre de projets invalide.");
  const workspace = workspaceDirFor(dir.path);
  if (!fs.existsSync(managerFile(workspace))) throw Error("Planning indisponible.");
  const manager = new WakeManager(workspace);
  try {
    const data = manager.reorderBlocks(input.projectIds as string[], input.revision as number);
    return {exitCode: 0, data, human: () => "Ordre des prochains blocs enregistré."};
  } finally { manager.close(); }
}
