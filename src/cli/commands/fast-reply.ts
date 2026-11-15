import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fastReplyApplies,
  fastReplyEnabled,
  readFastReplies,
  runFastReply,
  saveFastReplyEnabled,
} from "../../communication/fast-reply.js";
import type { CliContext } from "../context.js";
import { nodeScriptArgs } from "../script-entry.js";
import type { DataDir } from "../paths.js";
import type { CommandResult } from "../output.js";

const CLI_ENTRY = fileURLToPath(new URL("../main.js", import.meta.url));

/**
 * Secours quand le moteur ne tourne pas : réponse rapide détachée, `reply` rend la main
 * aussitôt. Moteur actif, son service préchauffé répond d'abord ; la réservation par
 * message (`beginFastReply`) laisse alors ce processus repartir sans appel.
 */
export function startFastReply(dataDir: DataDir, messageId: string): boolean {
  // Même mode que ce processus : dist compilé, ou sources quand le moteur tourne hors compilation.
  const entry = nodeScriptArgs(CLI_ENTRY);
  if (!fastReplyEnabled(dataDir.path) || !fastReplyApplies(messageId) || entry === null) return false;
  const log = fs.openSync(path.join(dataDir.path, "fast-reply.log"), "a");
  try {
    const child = spawn(
      process.execPath,
      [...entry, "fast-reply", "run", "--message-id", messageId, "--data-dir", dataDir.path],
      {
        detached: true,
        stdio: ["ignore", log, log],
        windowsHide: true,
      },
    );
    child.unref();
    return true;
  } finally {
    fs.closeSync(log);
  }
}

export async function fastReply(
  ctx: CliContext,
  dataDir: DataDir,
  action: string | undefined,
  messageId: string | undefined,
): Promise<CommandResult<unknown>> {
  switch (action ?? "status") {
    case "status":
      return {
        exitCode: 0,
        data: { enabled: fastReplyEnabled(dataDir.path), recent: readFastReplies(dataDir.path) },
        human: () =>
          fastReplyEnabled(dataDir.path) ? "Réponse rapide activée." : "Réponse rapide désactivée.",
      };
    case "on":
    case "off":
      saveFastReplyEnabled(dataDir.path, action === "on");
      return {
        exitCode: 0,
        data: { enabled: action === "on" },
        human: () => (action === "on" ? "Réponse rapide activée." : "Réponse rapide désactivée."),
      };
    case "run": {
      if (messageId === undefined) throw Error("--message-id requis");
      const state = await runFastReply({
        dataDir: dataDir.path,
        messageId,
        log: (line) => {
          ctx.stderr(`${new Date().toISOString()} ${line}`);
        },
      });
      return { exitCode: 0, data: { messageId, state }, human: () => `Réponse rapide : ${state}.` };
    }
    default:
      throw Error(`action inconnue de la réponse rapide : ${action ?? ""}`);
  }
}
