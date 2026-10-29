/**
 * Consultation de Wake en LECTURE SEULE, par les mêmes modules que la CLI (`status`,
 * `journal`) et le bilan d'expérience du daemon. Aucune écriture, aucune commande
 * réservée à l'humain (`enable`, confirmation, `uninstall`, pause, policy…) : ces
 * fonctions n'ouvrent la base qu'en lecture et ne créent jamais le dossier de données.
 */

import { journal } from "../../src/cli/commands/journal.js";
import { withReadStore } from "../../src/cli/commands/read.js";
import { status } from "../../src/cli/commands/status.js";
import { DEFAULT_PROFILE_ID, processContext, type CliContext } from "../../src/cli/context.js";
import { resolveDataDir, type DataDir } from "../../src/cli/paths.js";
import type { ExperimentId } from "../../src/contracts/index.js";
import { buildReport } from "../../src/daemon/report.js";

export const MAX_WAKE_JOURNAL = 100;

export interface WakeReader {
  status(): unknown;
  journal(limit: number, afterSequence: number | null): unknown;
  lastReport(): unknown;
}

export function wakeReader(env: Readonly<Record<string, string | undefined>>): WakeReader {
  // La sortie standard appartient au transport MCP : la CLI n'y écrit rien ici.
  const ctx: CliContext = {
    ...processContext(),
    env,
    stdout: () => undefined,
    stderr: () => undefined,
  };
  const dataDir = (): DataDir => resolveDataDir(ctx, undefined);
  return {
    status: () => status(ctx, dataDir()).data,
    journal: (limit, afterSequence) =>
      journal(ctx, dataDir(), {
        limit: Math.min(Math.max(limit, 1), MAX_WAKE_JOURNAL),
        afterSequence,
      }).data,
    lastReport: () =>
      withReadStore(ctx, dataDir(), ({ uow, db }) => {
        if (uow === null || db === undefined) return { report: null, hint: "aucun profil Wake" };
        const profile = uow.profiles.get(DEFAULT_PROFILE_ID);
        if (profile === null) return { report: null, hint: "aucun profil Wake" };
        const active = uow.experiments.getActive(profile.id);
        const lastId: ExperimentId | undefined =
          active?.id ??
          uow.journal.list(profile.id).findLast((e) => e.experimentId !== undefined)?.experimentId;
        if (lastId === undefined) return { report: null, hint: "aucune expérience encore" };
        return { report: buildReport(uow, db, lastId), hint: null };
      }),
  };
}
