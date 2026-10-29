/**
 * `resume` : lève une pause (`paused → ready`) après revérification de la policy
 * consentie. Refusée après un arrêt d'urgence verrouillé ; n'active jamais un profil
 * désactivé.
 */

import type { ProfileState } from "../../contracts/index.js";
import { requestResume, type ResumeStatus } from "../../runner/controls.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import { EXIT_FAILURE, EXIT_OK, type CommandResult } from "../output.js";
import type { DataDir } from "../paths.js";
import { withControlStore } from "./control.js";
import { NO_PROFILE_HINT } from "./read.js";

export interface ResumeData {
  readonly profileId: string | null;
  readonly status: ResumeStatus;
  readonly state: ProfileState | null;
  readonly reason: string;
  readonly detail: string;
}

export function resume(ctx: CliContext, dataDir: DataDir): CommandResult<ResumeData> {
  const result = withControlStore(ctx, dataDir, (uow) =>
    requestResume({ uow, profileId: DEFAULT_PROFILE_ID, now: ctx.now }),
  );
  const data: ResumeData =
    result === null
      ? {
          profileId: null,
          status: "refused",
          state: null,
          reason: "unknown_profile",
          detail: NO_PROFILE_HINT,
        }
      : { profileId: DEFAULT_PROFILE_ID, ...result };
  return {
    exitCode: data.status === "refused" ? EXIT_FAILURE : EXIT_OK,
    data,
    human: formatResume,
  };
}

function formatResume(data: ResumeData): string {
  const headline =
    data.status === "resumed"
      ? "Reprise appliquée : profil prêt, les réveils restent soumis à la policy."
      : data.status === "already_ready"
        ? "Profil déjà prêt."
        : `Reprise refusée (${data.reason}).`;
  return [
    headline,
    `Détail : ${data.detail}`,
    ...(data.state === null ? [] : [`État : ${data.state}`]),
  ].join("\n");
}
