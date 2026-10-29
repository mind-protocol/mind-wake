/**
 * `wake` : l'humain demande un réveil au plus tôt. Avance la prochaine évaluation du
 * scheduler sans rien accorder : fenêtres, priorité humaine, budgets et permissions
 * restent vérifiés au lancement. Refusé en pause, après arrêt d'urgence, sur un profil
 * désactivé ou bloqué : `wake` ne lève aucun de ces états.
 */

import type { ProfileState } from "../../contracts/index.js";
import { requestHumanWake } from "../../daemon/human-wake.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import { EXIT_FAILURE, EXIT_OK, type CommandResult } from "../output.js";
import type { DataDir } from "../paths.js";
import { NO_PROFILE_HINT, withReadStore } from "./read.js";

export type WakeStatus = "requested" | "already_running" | "refused";

export interface WakeData {
  readonly profileId: string | null;
  readonly status: WakeStatus;
  readonly state: ProfileState | null;
  readonly requestedAt: string | null;
  readonly detail: string;
}

const ACCEPTING: readonly ProfileState[] = ["ready", "hibernating"];

export function wake(ctx: CliContext, dataDir: DataDir): CommandResult<WakeData> {
  const state = withReadStore(ctx, dataDir, ({ uow }) =>
    uow === null ? null : (uow.profiles.get(DEFAULT_PROFILE_ID)?.state ?? null),
  );
  let data: WakeData;
  if (state === null) {
    data = {
      profileId: null,
      status: "refused",
      state: null,
      requestedAt: null,
      detail: NO_PROFILE_HINT,
    };
  } else if (state === "running" || state === "checkpointing") {
    data = {
      profileId: DEFAULT_PROFILE_ID,
      status: "already_running",
      state,
      requestedAt: null,
      detail: "une session est déjà en cours",
    };
  } else if (!ACCEPTING.includes(state)) {
    data = {
      profileId: DEFAULT_PROFILE_ID,
      status: "refused",
      state,
      requestedAt: null,
      detail: `profil ${state} : un réveil ne lève ni pause, ni arrêt, ni blocage`,
    };
  } else {
    data = {
      profileId: DEFAULT_PROFILE_ID,
      status: "requested",
      state,
      requestedAt: requestHumanWake(dataDir.path, ctx.now().getTime()),
      detail:
        "réveil demandé : le daemon l'évalue à son prochain tour, sous les mêmes contrôles (fenêtres, priorité, budgets) ; valable une heure",
    };
  }
  return { exitCode: data.status === "refused" ? EXIT_FAILURE : EXIT_OK, data, human: formatWake };
}

const HEADLINES: { readonly [S in WakeStatus]: string } = {
  requested: "Réveil demandé.",
  already_running: "Déjà en cours.",
  refused: "Réveil refusé.",
};

function formatWake(data: WakeData): string {
  return [
    HEADLINES[data.status],
    `Détail : ${data.detail}`,
    ...(data.state === null ? [] : [`État : ${data.state}`]),
  ].join("\n");
}
