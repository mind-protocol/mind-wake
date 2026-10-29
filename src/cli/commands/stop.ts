/**
 * `stop` : arrêt d'urgence (kill switch). Persiste d'abord `stopped` avec le verrou
 * d'arrêt d'urgence, ce qui bloque toute nouvelle action, puis termine par son nom le
 * Job Object de chaque session ouverte, avec toute sa descendance, sans attendre le
 * modèle ni le daemon. Si la persistance échoue, un marqueur de secours est écrit et
 * l'arborescence est terminée quand même ; le démarrage suivant appliquera l'arrêt.
 */

import type { ProfileState, SessionId, UtcTimestamp } from "../../contracts/index.js";
import {
  persistEmergencyStop,
  StopFlag,
  type EmergencyStopPersistence,
} from "../../runner/controls.js";
import { runtimeDirFor } from "../../runner/paths.js";
import { ProcessTreeSupervisor } from "../../runner/process-tree.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import { EXIT_FAILURE, EXIT_OK, type CommandResult } from "../output.js";
import { inspectDataDir, type DataDir } from "../paths.js";
import { withControlStore } from "./control.js";
import { NO_PROFILE_HINT } from "./read.js";

export interface StopTermination {
  readonly sessionId: string;
  /** Job encore présent ; `null` si la vérification a été impossible. */
  readonly processFound: boolean | null;
  readonly confirmed: boolean;
  readonly elapsedMs: number;
  readonly detail: string | null;
}

export interface StopData {
  readonly profileId: string | null;
  readonly persisted: boolean;
  readonly locked: boolean;
  readonly previousState: ProfileState | null;
  readonly fallbackFlagWritten: boolean;
  readonly error: string | null;
  readonly terminations: readonly StopTermination[];
  readonly hint: string | null;
}

interface Persisted {
  readonly persistence: EmergencyStopPersistence;
  readonly open: readonly SessionId[];
}

export function stop(ctx: CliContext, dataDir: DataDir): CommandResult<StopData> {
  const flag = new StopFlag(dataDir.path);
  let outcome: Persisted | null;
  let failure: string | null = null;
  try {
    outcome = withControlStore(ctx, dataDir, (uow): Persisted => {
      const persistence = persistEmergencyStop(
        { uow, profileId: DEFAULT_PROFILE_ID, now: ctx.now },
        flag,
      );
      let open: readonly SessionId[];
      try {
        open = uow.sessions.listOpen(DEFAULT_PROFILE_ID).map((s) => s.id);
      } catch {
        open = [];
      }
      return { persistence, open };
    });
    if (outcome === null) {
      return result({
        profileId: null,
        persisted: false,
        locked: false,
        previousState: null,
        fallbackFlagWritten: false,
        error: null,
        terminations: [],
        hint: NO_PROFILE_HINT,
      });
    }
  } catch (error) {
    // Base inaccessible : le marqueur de secours est lu par le runner actif et au démarrage.
    outcome = null;
    failure = error instanceof Error ? error.message : String(error);
  }
  const fallbackFlagWritten =
    outcome?.persistence.flagWritten ??
    (inspectDataDir(dataDir.path).status === "ok" &&
      flag.write("arrêt d'urgence : base inaccessible", ctx.now().toISOString() as UtcTimestamp));

  const terminations: StopTermination[] = [];
  const open = outcome?.open ?? [];
  if (open.length > 0) {
    const supervisor = new ProcessTreeSupervisor(runtimeDirFor(dataDir.path), ctx.platform);
    for (const sessionId of open) {
      const t = supervisor.terminate(DEFAULT_PROFILE_ID, sessionId);
      terminations.push({
        sessionId,
        processFound: t.found,
        confirmed: t.confirmed,
        elapsedMs: Math.round(t.elapsedMs * 1000) / 1000,
        detail: t.detail ?? null,
      });
    }
  }
  const persisted = outcome?.persistence.persisted ?? false;
  return result({
    profileId: DEFAULT_PROFILE_ID,
    persisted,
    locked: persisted,
    previousState: outcome?.persistence.previousState ?? null,
    fallbackFlagWritten,
    error: outcome?.persistence.error ?? failure,
    terminations,
    hint: null,
  });
}

function result(data: StopData): CommandResult<StopData> {
  const ok = data.persisted && data.terminations.every((t) => t.confirmed);
  return { exitCode: ok ? EXIT_OK : EXIT_FAILURE, data, human: formatStop };
}

function formatStop(data: StopData): string {
  if (data.profileId === null) return `Arrêt d'urgence sans objet : ${data.hint ?? ""}`;
  const lines = data.persisted
    ? [
        "Arrêt d'urgence enregistré : profil stopped et verrouillé, aucun réveil, aucune nouvelle action.",
      ]
    : [
        `Attention : arrêt d'urgence NON persisté (${data.error ?? "erreur inconnue"}).`,
        data.fallbackFlagWritten
          ? "Marqueur de secours écrit : récupération conservatrice au prochain démarrage."
          : "Marqueur de secours impossible à écrire.",
      ];
  if (data.previousState !== null) lines.push(`État précédent : ${data.previousState}`);
  if (data.terminations.length === 0) lines.push("Aucune session ouverte à terminer.");
  for (const t of data.terminations) {
    lines.push(
      t.confirmed
        ? `Session ${t.sessionId} : ${t.processFound === true ? "arborescence terminée" : "aucun processus actif"} (${String(t.elapsedMs)} ms).`
        : `Session ${t.sessionId} : terminaison NON confirmée (${t.detail ?? "inconnu"}).`,
    );
  }
  lines.push("La reprise exige une réactivation explicite : `resume` est refusée.");
  return lines.join("\n");
}
