import { duoEnabled, configureDuo } from "../../communication/duo-reminder.js";
import {
  coachEnabled,
  configureCoach,
  readCoachState,
  coachEntries,
  sendToCoach,
} from "../../daemon/coach.js";
import fs from "node:fs";
import path from "node:path";
import type { CliContext } from "../context.js";
import type { DataDir } from "../paths.js";
import type { CommandResult } from "../output.js";

export async function coach(
  ctx: CliContext,
  dataDir: DataDir,
  action: string,
): Promise<CommandResult<unknown>> {
  if (["duo-status", "duo-on", "duo-off"].includes(action)) {
    if (action !== "duo-status") configureDuo(dataDir.path, action === "duo-on");
    return { exitCode: 0, data: { enabled: duoEnabled(dataDir.path) }, human: () => `Mode Duo ${duoEnabled(dataDir.path) ? "activé" : "désactivé"}.` };
  }
  if (action === "on" || action === "off") configureCoach(dataDir.path, action === "on");
  else if (action === "send") sendToCoach(dataDir.path, (await ctx.readStdin?.()) ?? "");
  else if (action !== "status") throw Error("Action coach attendue : status, on, off ou send.");
  return {
    exitCode: 0,
    data: {
      enabled: coachEnabled(dataDir.path),
      ...readCoachState(dataDir.path),
      entries: coachEntries(dataDir.path),
      active: fs.existsSync(path.join(dataDir.path, "coach-session.json")),
    },
    human: () =>
      `Coach ${coachEnabled(dataDir.path) ? "activé" : "désactivé"}. Démarrage avec le prochain wake Codex natif autorisé.`,
  };
}
