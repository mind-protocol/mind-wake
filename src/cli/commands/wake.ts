/**
 * `wake` : l'humain réveille son agent maintenant. Lève une pause, puis demande une
 * session immédiate : ni fenêtre horaire, ni attente d'inactivité, ni pilotage. Arrêt
 * d'urgence, plafonds, garde de quota et consentements restent imposés. Refusé après
 * un arrêt d'urgence ou sur un profil désactivé.
 */

import type { ProfileState } from "../../contracts/index.js";
import { requestHumanWake } from "../../daemon/human-wake.js";
import { requestResume } from "../../runner/controls.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import { EXIT_FAILURE, EXIT_OK, type CommandResult } from "../output.js";
import type { DataDir } from "../paths.js";
import { withControlStore } from "./control.js";
import { NO_PROFILE_HINT, withReadStore } from "./read.js";

export type WakeStatus = "requested" | "already_running" | "refused";

export interface WakeData {
  readonly profileId: string | null;
  readonly status: WakeStatus;
  readonly state: ProfileState | null;
  readonly requestedAt: string | null;
  readonly detail: string;
}

const ACCEPTING: readonly ProfileState[] = ["ready", "hibernating", "paused", "blocked"];

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
    let now: ProfileState = state;
    if (state === "paused") {
      const resumed = withControlStore(ctx, dataDir, (uow) =>
        requestResume({ uow, profileId: DEFAULT_PROFILE_ID, now: ctx.now }),
      );
      now = resumed?.state ?? state;
    }
    data = {
      profileId: DEFAULT_PROFILE_ID,
      status: "requested",
      state: now,
      requestedAt: requestHumanWake(dataDir.path, ctx.now().getTime()),
      detail: "réveil demandé : l'agent démarre dès que le daemon le prend",
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
