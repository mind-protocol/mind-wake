/**
 * `reactivate` : action explicite de l'humain qui lève un arrêt d'urgence verrouillé
 * (`stopped → ready`) après revérification de la policy consentie. Retire aussi le
 * marqueur de secours de `stop`. Ne lance aucune session.
 */

import type { ProfileState } from "../../contracts/index.js";
import { requestReactivate, StopFlag, type ReactivateStatus } from "../../runner/controls.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import { EXIT_FAILURE, EXIT_OK, type CommandResult } from "../output.js";
import type { DataDir } from "../paths.js";
import { withControlStore } from "./control.js";
import { NO_PROFILE_HINT } from "./read.js";

export interface ReactivateData {
  readonly profileId: string | null;
  readonly status: ReactivateStatus;
  readonly state: ProfileState | null;
  readonly reason: string;
  readonly detail: string;
}

export function reactivate(ctx: CliContext, dataDir: DataDir): CommandResult<ReactivateData> {
  const result = withControlStore(ctx, dataDir, (uow) =>
    requestReactivate({ uow, profileId: DEFAULT_PROFILE_ID, now: ctx.now }),
  );
  const data: ReactivateData =
    result === null
      ? {
          profileId: null,
          status: "refused",
          state: null,
          reason: "unknown_profile",
          detail: NO_PROFILE_HINT,
        }
      : { profileId: DEFAULT_PROFILE_ID, ...result };
  if (data.status === "reactivated") new StopFlag(dataDir.path).clear();
  return {
    exitCode: data.status === "refused" ? EXIT_FAILURE : EXIT_OK,
    data,
    human: formatReactivate,
  };
}

const HEADLINES: { readonly [S in ReactivateStatus]: string } = {
  reactivated: "Arrêt d'urgence levé : Wake peut de nouveau se réveiller.",
  not_stopped: "Aucun arrêt d'urgence en cours.",
  refused: "Réactivation refusée.",
};

function formatReactivate(data: ReactivateData): string {
  return [
    HEADLINES[data.status],
    `Détail : ${data.detail}`,
    ...(data.state === null ? [] : [`État : ${data.state}`]),
  ].join("\n");
}
