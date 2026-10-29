/**
 * `pause` : interdit les prochains réveils. Une session en cours reçoit, par le runner,
 * une demande de checkpoint dans l'enveloppe restante puis est terminée. N'active rien.
 */

import type { ProfileState } from "../../contracts/index.js";
import { requestPause, type PauseStatus } from "../../runner/controls.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import { EXIT_FAILURE, EXIT_OK, type CommandResult } from "../output.js";
import type { DataDir } from "../paths.js";
import { withControlStore } from "./control.js";
import { NO_PROFILE_HINT } from "./read.js";

export interface PauseData {
  readonly profileId: string | null;
  readonly status: PauseStatus;
  readonly state: ProfileState | null;
  readonly detail: string;
}

export function pause(ctx: CliContext, dataDir: DataDir): CommandResult<PauseData> {
  const result = withControlStore(ctx, dataDir, (uow) =>
    requestPause({ uow, profileId: DEFAULT_PROFILE_ID, now: ctx.now }),
  );
  const data: PauseData =
    result === null
      ? { profileId: null, status: "refused", state: null, detail: NO_PROFILE_HINT }
      : { profileId: DEFAULT_PROFILE_ID, ...result };
  return {
    exitCode: data.status === "refused" ? EXIT_FAILURE : EXIT_OK,
    data,
    human: formatPause,
  };
}

const HEADLINES: { readonly [S in PauseStatus]: string } = {
  paused: "Pause appliquée : plus aucun réveil.",
  pause_requested: "Pause demandée : plus aucun réveil ; la session en cours va s'arrêter.",
  already_paused: "Profil déjà en pause.",
  refused: "Pause sans effet.",
};

function formatPause(data: PauseData): string {
  return [
    HEADLINES[data.status],
    `Détail : ${data.detail}`,
    ...(data.state === null ? [] : [`État : ${data.state}`]),
  ].join("\n");
}
