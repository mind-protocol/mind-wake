/**
 * `init` : prépare le profil local à l'état `disabled`, sans policy, budget ni
 * permission. Idempotent : un profil existant n'est jamais modifié ni activé.
 * Seule écriture hors stockage : la création du dossier de données.
 */

import fs from "node:fs";
import type { ProfileRecord, ProfileState } from "../../contracts/index.js";
import { JournalWriter, toUtcTimestamp } from "../../journal/index.js";
import { DEFAULT_AGENT_ID, DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import { EXIT_OK, type CommandResult } from "../output.js";
import type { DataDir } from "../paths.js";
import type { Persistence } from "../store/index.js";

export interface InitData {
  readonly dataDir: string;
  readonly persistence: Persistence;
  readonly created: boolean;
  readonly profile: {
    readonly id: string;
    readonly state: ProfileState;
    readonly activePolicyRevisionId: string | null;
  };
}

export const INIT_REASON =
  "créé par init : désactivé, aucune policy, aucun budget, aucune permission";

export function init(ctx: CliContext, dataDir: DataDir): CommandResult<InitData> {
  fs.mkdirSync(dataDir.path, { recursive: true });
  const store = ctx.openStore(dataDir.path);
  try {
    const { uow } = store;
    const { created, profile } = uow.transaction((tx) => {
      const existing = tx.profiles.get(DEFAULT_PROFILE_ID);
      if (existing !== null) return { created: false, profile: existing };
      const at = toUtcTimestamp(ctx.now());
      const record: ProfileRecord = {
        id: DEFAULT_PROFILE_ID,
        agentId: DEFAULT_AGENT_ID,
        state: "disabled",
        activePolicyRevisionId: null,
        nextWakeAt: null,
        emergencyStopLocked: false,
        stateReason: INIT_REASON,
        updatedAt: at,
      };
      tx.profiles.create(record);
      new JournalWriter(tx.journal).record({
        type: "profile_state_changed",
        at,
        profileId: record.id,
        reason: "profil créé à l'état disabled par init",
        metadata: { from: null, to: "disabled", command: "init" },
      });
      return { created: true, profile: record };
    });
    return {
      exitCode: EXIT_OK,
      data: {
        dataDir: dataDir.path,
        persistence: store.persistence,
        created,
        profile: {
          id: profile.id,
          state: profile.state,
          activePolicyRevisionId: profile.activePolicyRevisionId,
        },
      },
      human: formatInit,
    };
  } finally {
    store.close();
  }
}

function formatInit(data: InitData): string {
  const lines = data.created
    ? [
        `Profil « ${data.profile.id} » créé à l'état ${data.profile.state}.`,
        "Aucune policy, aucun budget, aucune permission : l'exploration est arrêtée.",
      ]
    : [
        `Profil « ${data.profile.id} » déjà présent (état ${data.profile.state}) : rien n'a été modifié.`,
      ];
  lines.push(`Dossier de données : ${data.dataDir}`);
  if (data.persistence === "memory") {
    lines.push(
      "Attention : stockage SQLite non câblé, ce profil n'existe qu'en mémoire pendant cette commande.",
    );
  }
  return lines.join("\n");
}
