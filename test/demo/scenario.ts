/**
 * Scénario de la démo SIMULÉE (AGENTS §7), en processus réels, partagé par le test
 * (`demo.process.test.ts`) et le script (`demo-simulee.ts`) :
 *
 * 1. Session A : l'agent factice choisit une expérience, tente une première fois,
 *    checkpoint ; le daemon s'arrête (hibernation persistée), son processus disparaît.
 * 2. Nouveau processus daemon ; session B : reprise de la même expérience depuis le
 *    checkpoint, exploitation de l'observation de A, petit résultat, bilan.
 * 3. Sur un daemon actif : priorité utilisateur, pause, reprise, arrêt d'urgence, avec
 *    délais mesurés depuis le processus du banc ; aucun réveil après l'arrêt d'urgence,
 *    y compris après redémarrage du daemon.
 */

import type { ExperimentId, SessionId } from "../../src/contracts/index.js";
import { buildReport, formatReport, type ExperimentReport } from "../../src/daemon/index.js";
import {
  PROFILE,
  cli,
  countEvents,
  profileState,
  readDb,
  setUserActive,
  sleep,
  startDaemon,
  waitFor,
} from "./harness.js";

export const RECHECK_MS = 1_000;
const DAEMON_ARGS = ["--simulated", "--recheck-ms", String(RECHECK_MS)];

export interface Measures {
  /** Activité utilisateur signalée → session close et profil en hibernation. */
  userPriorityToSessionEndMs: number;
  /** Activité terminée → nouvelle session lancée (au plus un tour de scheduler). */
  userIdleToRelaunchMs: number;
  /** Lancement de `mind-wake pause` → session close et profil `paused`. */
  pauseToPausedMs: number;
  pauseCliMs: number;
  /** Lancement de `mind-wake stop` → session close, profil `stopped` verrouillé. */
  stopToSessionClosedMs: number;
  stopCliMs: number;
  /** Terminaison de l'arborescence mesurée par `stop` (Job Object, par nom). */
  stopTreeTerminationMs: number | null;
  /** Durée d'observation sans aucun réveil après l'arrêt d'urgence (avant et après redémarrage). */
  quietAfterStopMs: number;
  /**
   * Délais internes, par les horodatages du journal (hors démarrage des processus CLI) :
   * écriture du signal → `session_ended`, `pause_requested` → `session_ended`,
   * `kill_switch_triggered` → `session_ended`.
   */
  userPriorityInDaemonMs: number;
  pauseInDaemonMs: number;
  stopInDaemonMs: number;
}

/** Écart entre un événement et la première fin de session qui le suit. */
function journalDelay(dataDir: string, fromType: string, fromMs?: number): number {
  return readDb(dataDir, (s) => {
    const events = s.uow.journal.list(PROFILE);
    const from = fromMs ?? Date.parse(events.findLast((e) => e.type === fromType)?.at ?? "invalid");
    const end = events.find((e) => e.type === "session_ended" && Date.parse(e.at) >= from);
    if (end === undefined || Number.isNaN(from)) throw new Error(`délai ${fromType} introuvable`);
    return Date.parse(end.at) - from;
  });
}

export interface DemoResult {
  readonly experimentId: ExperimentId;
  readonly sessionA: SessionId;
  readonly sessionB: SessionId;
  readonly report: ExperimentReport;
  readonly reportText: string;
  readonly measures: Measures;
  readonly sessionsAfterStop: number;
  readonly finalState: string | undefined;
  readonly emergencyStopLocked: boolean;
  readonly stopTerminationsConfirmed: boolean;
}

const openSessions = (dataDir: string): number =>
  readDb(dataDir, (s) => s.uow.sessions.listOpen(PROFILE).length);

const startedCount = (dataDir: string): number =>
  readDb(dataDir, (s) => countEvents(s, "session_started"));

async function waitNextSession(dataDir: string, after: number, label: string): Promise<number> {
  return waitFor(
    dataDir,
    (s) =>
      countEvents(s, "session_started") > after && s.uow.sessions.listOpen(PROFILE).length === 1,
    label,
  );
}

export async function runSimulatedDemo(
  dataDir: string,
  log: (line: string) => void = () => undefined,
): Promise<DemoResult> {
  // ── Session A, puis arrêt du processus daemon ────────────────────────────────────
  log("Session A : daemon simulé, première session…");
  const first = await startDaemon(dataDir, [...DAEMON_ARGS, "--exit-after-sessions", "1"]).exited;
  if (first.code !== 0) throw new Error(`daemon A : code ${String(first.code)}\n${first.stderr}`);
  log(first.stdout.trim());
  const afterA = readDb(dataDir, (s) => ({
    state: profileState(s),
    experiment: s.uow.experiments.getActive(PROFILE),
  }));
  if (afterA.experiment === null) throw new Error("aucune expérience choisie en session A");
  log(`Hibernation persistée : profil ${String(afterA.state)} ; processus daemon terminé.`);

  // ── Redémarrage réel, session B ──────────────────────────────────────────────────
  log("Redémarrage du daemon (nouveau processus), session B…");
  const second = await startDaemon(dataDir, [...DAEMON_ARGS, "--exit-after-sessions", "1"]).exited;
  if (second.code !== 0)
    throw new Error(`daemon B : code ${String(second.code)}\n${second.stderr}`);
  log(second.stdout.trim());
  const experimentId = afterA.experiment.id;
  const { report, sessions } = readDb(dataDir, (s) => {
    const built = buildReport(s.uow, s.db, experimentId);
    if (built === null) throw new Error("bilan introuvable");
    return { report: built, sessions: built.sessions.map((x) => x.sessionId) };
  });
  const reportText = formatReport(report);
  log(reportText);

  // ── Contrôles sur un daemon actif ────────────────────────────────────────────────
  log("Contrôles sur un daemon actif (session de continuation)…");
  const daemon = startDaemon(dataDir, DAEMON_ARGS);
  try {
    let before = startedCount(dataDir);
    await waitNextSession(dataDir, before, "session de continuation lancée");

    // Priorité utilisateur.
    let t0 = performance.now();
    const flagAt = Date.now();
    setUserActive(dataDir, true);
    const userPriorityToSessionEndMs = await waitFor(
      dataDir,
      (s) => s.uow.sessions.listOpen(PROFILE).length === 0 && profileState(s) === "hibernating",
      "fin de session sur priorité utilisateur",
      15_000,
      t0,
    );
    before = startedCount(dataDir);
    await sleep(RECHECK_MS * 2.5);
    if (startedCount(dataDir) !== before) throw new Error("réveil malgré l'activité utilisateur");
    t0 = performance.now();
    setUserActive(dataDir, false);
    const userIdleToRelaunchMs = await waitNextSession(dataDir, before, "relance après activité");
    log(
      `Priorité utilisateur : session close en ${userPriorityToSessionEndMs.toFixed(0)} ms ; aucune relance pendant l'activité ; relance ${userIdleToRelaunchMs.toFixed(0)} ms après.`,
    );

    // Pause puis reprise.
    t0 = performance.now();
    const pause = await cli(dataDir, ["pause"]);
    const pauseToPausedMs = await waitFor(
      dataDir,
      (s) => s.uow.sessions.listOpen(PROFILE).length === 0 && profileState(s) === "paused",
      "pause effective",
      15_000,
      t0,
    );
    before = startedCount(dataDir);
    await sleep(RECHECK_MS * 2.5);
    if (startedCount(dataDir) !== before) throw new Error("réveil pendant la pause");
    log(
      `Pause : CLI ${pause.elapsedMs.toFixed(0)} ms, session close et profil paused en ${pauseToPausedMs.toFixed(0)} ms.`,
    );
    const resume = await cli(dataDir, ["resume"]);
    if (resume.code !== 0) throw new Error(`resume : ${resume.stdout}${resume.stderr}`);
    await waitNextSession(dataDir, before, "relance après reprise");

    // Arrêt d'urgence.
    t0 = performance.now();
    const stop = await cli(dataDir, ["stop", "--json"]);
    const stopToSessionClosedMs = await waitFor(
      dataDir,
      (s) =>
        s.uow.sessions.listOpen(PROFILE).length === 0 &&
        profileState(s) === "stopped" &&
        s.uow.profiles.get(PROFILE)?.emergencyStopLocked === true,
      "arrêt d'urgence effectif",
      15_000,
      t0,
    );
    const stopData = (
      JSON.parse(stop.stdout) as {
        data: { terminations: { confirmed: boolean; elapsedMs: number }[] };
      }
    ).data;
    log(
      `Arrêt d'urgence : CLI ${stop.elapsedMs.toFixed(0)} ms (arborescence ${String(stopData.terminations[0]?.elapsedMs ?? "—")} ms), session close et profil stopped en ${stopToSessionClosedMs.toFixed(0)} ms.`,
    );
    const userPriorityInDaemonMs = journalDelay(dataDir, "user_activity", flagAt);
    const pauseInDaemonMs = journalDelay(dataDir, "pause_requested");
    const stopInDaemonMs = journalDelay(dataDir, "kill_switch_triggered");
    log(
      `Délais internes (journal) : priorité utilisateur ${String(userPriorityInDaemonMs)} ms, pause ${String(pauseInDaemonMs)} ms, arrêt d'urgence ${String(stopInDaemonMs)} ms.`,
    );
    const quietBegin = performance.now();
    const atStop = startedCount(dataDir);
    await sleep(RECHECK_MS * 3);
    await daemon.kill();
    const restarted = startDaemon(dataDir, DAEMON_ARGS);
    await sleep(RECHECK_MS * 4);
    await restarted.kill();
    const quietAfterStopMs = performance.now() - quietBegin;
    const sessionsAfterStop = startedCount(dataDir) - atStop;
    const final = readDb(dataDir, (s) => s.uow.profiles.get(PROFILE));
    log(
      `Après l'arrêt d'urgence : ${String(sessionsAfterStop)} réveil en ${quietAfterStopMs.toFixed(0)} ms, redémarrage du daemon compris ; profil ${String(final?.state)}, verrou ${String(final?.emergencyStopLocked)}.`,
    );
    return {
      experimentId,
      sessionA: sessions[0] as SessionId,
      sessionB: sessions[1] as SessionId,
      report,
      reportText,
      measures: {
        userPriorityToSessionEndMs,
        userIdleToRelaunchMs,
        pauseToPausedMs,
        pauseCliMs: pause.elapsedMs,
        stopToSessionClosedMs,
        stopCliMs: stop.elapsedMs,
        stopTreeTerminationMs: stopData.terminations[0]?.elapsedMs ?? null,
        quietAfterStopMs,
        userPriorityInDaemonMs,
        pauseInDaemonMs,
        stopInDaemonMs,
      },
      sessionsAfterStop,
      finalState: final?.state,
      emergencyStopLocked: final?.emergencyStopLocked === true,
      stopTerminationsConfirmed: stopData.terminations.every((t) => t.confirmed),
    };
  } finally {
    await daemon.kill();
    if (openSessions(dataDir) > 0) log("Attention : session encore ouverte en fin de démo.");
  }
}
