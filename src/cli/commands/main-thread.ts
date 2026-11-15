/**
 * `main-thread status|on|off` : fil principal On/Off depuis la vue d'ensemble.
 * Off n'interrompt pas la session en cours et ne touche ni à la pause, ni au Force-off,
 * ni aux forks ou au second fil ; il empêche seulement les prochains réveils principaux.
 */
import { readMainThread, saveMainThreadEnabled } from "../../daemon/main-thread.js";
import type { CliContext } from "../context.js";
import type { DataDir } from "../paths.js";
import type { CommandResult } from "../output.js";

export interface MainThreadData {
  readonly enabled: boolean;
  readonly updatedAt: string | null;
  readonly changed: boolean;
  readonly detail: string;
}

export const MAIN_THREAD_OFF_DETAIL =
  "Fil principal désactivé : aucun nouveau réveil de l’agent principal. La session en cours se termine normalement ; historique et messages sont conservés.";
export const MAIN_THREAD_ON_DETAIL =
  "Fil principal activé : les réveils reprennent selon le mode choisi (pause et Force-off restent appliqués).";

export function mainThread(
  ctx: CliContext,
  dataDir: DataDir,
  action: string | undefined,
): CommandResult<MainThreadData> {
  const before = readMainThread(dataDir.path);
  const result = (changed: boolean): CommandResult<MainThreadData> => {
    const state = readMainThread(dataDir.path);
    return {
      exitCode: 0,
      data: {
        ...state,
        changed,
        detail: state.enabled ? MAIN_THREAD_ON_DETAIL : MAIN_THREAD_OFF_DETAIL,
      },
      human: (d) => d.detail,
    };
  };
  switch (action ?? "status") {
    case "status":
      return result(false);
    case "on":
      if (!before.enabled) saveMainThreadEnabled(dataDir.path, true, ctx.now());
      return result(!before.enabled);
    case "off":
      if (before.enabled) saveMainThreadEnabled(dataDir.path, false, ctx.now());
      return result(before.enabled);
    default:
      throw Error(`action inconnue du fil principal : ${action ?? ""}`);
  }
}
