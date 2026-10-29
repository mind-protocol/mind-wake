/**
 * Daemon Wake au premier plan (AGENTS §5 « Daemon », SPEC §5 et §8).
 *
 * Démarrage : ouvre la base de contrôle, prend le verrou d'instance du profil (un seul
 * daemon par profil), applique un arrêt d'urgence resté en marqueur de secours,
 * réconcilie les sessions orphelines et les artefacts, puis boucle sur le scheduler.
 * Le runner (S7) exécute chaque session lancée par le scheduler (S6) ; les checkpoints
 * candidats sont autorisés par le policy engine puis publiés par `src/checkpoint/`.
 *
 * Aucun port réseau. Le canal de contrôle est la base SQLite : `pause`, `resume` et
 * `stop` de la CLI y persistent l'état ; le watchdog du runner le relit toutes les
 * 50 ms pendant une session, le scheduler à chaque tour. `stop` termine aussi le Job
 * Object de la session par son nom, sans passer par le daemon.
 *
 * Ce build n'a qu'un adapter : l'adapter factice. Le daemon refuse de démarrer sans
 * `simulated: true`, et tout ce qu'il produit est marqué SIMULÉ.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  FAKE_ADAPTER_ID,
  FakeAdapter,
  emergenceScenario,
  fakeScenario,
  type FakeScenario,
} from "../adapters/fake/index.js";
import {
  loadWakeMemory,
  openRoot,
  publishCheckpoint,
  reconcileArtifacts,
  type ConfinedRoot,
  type WakeMemory,
} from "../checkpoint/index.js";
import type {
  CheckpointCandidate,
  ExperimentId,
  PolicyRevisionId,
  ProfileId,
  SessionId,
  SessionRecord,
  UtcTimestamp,
} from "../contracts/index.js";
import { prepareJournalEvent } from "../journal/index.js";
import { decideAction, decisionJournalEvent, resolvePolicy } from "../policy/index.js";
import {
  ProcessTreeSupervisor,
  SessionRunner,
  StopFlag,
  runtimeDirFor,
  type SessionResult,
} from "../runner/index.js";
import {
  InstanceLockError,
  Scheduler,
  SqliteSchedulerStateRepository,
  acquireInstanceLock,
  instanceLockPath,
  type InstanceLock,
  type LaunchTicket,
  type SessionFailure,
  type SessionLauncher,
  type SessionReport,
} from "../scheduler/index.js";
import { openStore, type Store } from "../store/index.js";
import {
  SIMULATED_RUNTIME,
  SimulatedActivitySignal,
  SimulatedEnvironment,
  simulatedLiveChecks,
} from "./environment.js";
import { registerProposal } from "./experiments.js";
import {
  ARTIFACTS_SEGMENT,
  artifactsDirFor,
  controlDbPath,
  simulatedActivityFlagFor,
} from "./paths.js";
import { closeAbandonedRuns, recordDaemonEnd, recordDaemonStart } from "./runs.js";

export class DaemonError extends Error {
  override readonly name = "DaemonError";
  constructor(
    readonly code:
      | "real_adapter_missing"
      | "no_profile"
      | "already_running"
      | "runtime_mismatch"
      | "termination_unavailable",
    message: string,
  ) {
    super(message);
  }
}

export interface DaemonOptions {
  readonly dataDir: string;
  readonly profileId: ProfileId;
  /** Seul mode disponible : adapter factice, tout est marqué SIMULÉ. */
  readonly simulated: boolean;
  /** Veille maximale du scheduler entre deux tours (≥ 1 000 ms). */
  readonly recheckIntervalMs?: number;
  /** Arrêt propre après ce nombre de sessions terminées (démo, tests). */
  readonly exitAfterSessions?: number;
  /** Lanceur Job Object compilé ; par défaut `<dataDir>/runtime`. */
  readonly runtimeDir?: string;
  /** Scénario imposé à chaque session (tests) ; sinon l'agent factice de la démo. */
  readonly scenario?: FakeScenario;
  readonly log?: (line: string) => void;
}

export interface DaemonSummary {
  readonly runId: string;
  readonly sessions: readonly SessionResult[];
  readonly reason: string;
}

const DEFAULT_RECHECK_MS = 2_000;

function utcNow(): UtcTimestamp {
  return new Date().toISOString() as UtcTimestamp;
}

/** Ce que le scheduler doit savoir de la fin d'une session menée par le runner. */
export function reportFor(result: SessionResult): SessionReport {
  const failure = ((): SessionFailure | undefined => {
    if (result.reason === "provider.rate_limited") {
      return { kind: "rate_limited", retryAfterMs: null };
    }
    if (result.reason.startsWith("adapter.auth_failed")) {
      return { kind: "auth_failed", detail: result.reason };
    }
    if (result.reason.startsWith("adapter.incompatible")) {
      return { kind: "incompatible", detail: result.reason };
    }
    if (result.outcome === "failed" || result.outcome === "orphaned") {
      return { kind: "transient", detail: result.reason };
    }
    return undefined;
  })();
  return {
    sessionId: result.sessionId,
    outcome: result.outcome,
    ...(failure === undefined ? {} : { failure }),
  };
}

interface SessionContext {
  readonly revisionId: PolicyRevisionId;
  experimentId: ExperimentId | null;
  scenario: FakeScenario;
}

export class WakeDaemon implements SessionLauncher {
  readonly runId = `run-${randomUUID()}`;
  readonly #o: DaemonOptions;
  readonly #store: Store;
  readonly #lock: InstanceLock;
  readonly #runner: SessionRunner;
  readonly #signal: SimulatedActivitySignal;
  readonly #root: ConfinedRoot;
  readonly #sessions = new Map<SessionId, SessionContext>();
  readonly #results: SessionResult[] = [];
  readonly #abort = new AbortController();
  #stopReason = "arrêt demandé";
  #scheduler: Scheduler | null = null;

  private constructor(
    options: DaemonOptions,
    store: Store,
    lock: InstanceLock,
    supervisor: ProcessTreeSupervisor,
  ) {
    this.#o = options;
    this.#store = store;
    this.#lock = lock;
    this.#signal = new SimulatedActivitySignal(simulatedActivityFlagFor(options.dataDir));
    fs.mkdirSync(artifactsDirFor(options.dataDir), { recursive: true });
    this.#root = openRoot(artifactsDirFor(options.dataDir));
    this.#runner = new SessionRunner({
      uow: store.uow,
      profileId: options.profileId,
      supervisor,
      stopFlag: new StopFlag(options.dataDir),
      adapter: (host) =>
        new FakeAdapter({
          host,
          scenario: (sessionId) =>
            this.#sessions.get(sessionId)?.scenario ?? fakeScenario("success"),
          experimentFor: (sessionId) =>
            this.#sessions.get(sessionId)?.experimentId ?? ("exp-inconnue" as ExperimentId),
          onProposal: (sessionId, proposal) => {
            this.#onProposal(sessionId, proposal);
          },
        }),
      liveChecks: () => simulatedLiveChecks(this.#signal),
      onCheckpointCandidate: (candidate) => {
        this.#onCheckpoint(candidate);
      },
    });
  }

  /**
   * Prépare le daemon sans rien lancer. Lève `DaemonError` si le mode réel est demandé,
   * si le profil est absent, si un autre daemon tient le verrou ou si la policy ne
   * désigne pas l'adapter factice.
   */
  static open(options: DaemonOptions): WakeDaemon {
    if (!options.simulated) {
      throw new DaemonError(
        "real_adapter_missing",
        "adapter réel (Codex) non implémenté dans ce build : relancer avec --simulated pour l'adapter factice, tout sera marqué SIMULÉ",
      );
    }
    const dbPath = controlDbPath(options.dataDir);
    if (!fs.existsSync(dbPath)) {
      throw new DaemonError("no_profile", "aucune base de contrôle : lancer `mind-wake init`");
    }
    const store = openStore(dbPath);
    let lock: InstanceLock | null = null;
    try {
      if (store.uow.profiles.get(options.profileId) === null) {
        throw new DaemonError("no_profile", `profil ${options.profileId} absent`);
      }
      try {
        lock = acquireInstanceLock(instanceLockPath(options.dataDir, options.profileId));
      } catch (error) {
        if (error instanceof InstanceLockError) {
          throw new DaemonError(
            "already_running",
            "un daemon tient déjà le verrou d'instance de ce profil",
          );
        }
        throw error;
      }
      const resolution = resolvePolicy(store.uow.policies, options.profileId);
      if (
        resolution.status === "active" &&
        resolution.revision.groups.runtime.adapterId !== FAKE_ADAPTER_ID
      ) {
        throw new DaemonError(
          "runtime_mismatch",
          `la policy désigne l'adapter « ${resolution.revision.groups.runtime.adapterId} » : le mode simulé n'exécute que l'adapter factice`,
        );
      }
      const supervisor = new ProcessTreeSupervisor(
        options.runtimeDir ?? runtimeDirFor(options.dataDir),
      );
      if (!supervisor.status.available) {
        throw new DaemonError("termination_unavailable", supervisor.status.reason);
      }
      return new WakeDaemon(options, store, lock, supervisor);
    } catch (error) {
      lock?.release();
      store.close();
      throw error;
    }
  }

  get store(): Store {
    return this.#store;
  }

  #log(line: string): void {
    this.#o.log?.(`[SIMULÉ] ${line}`);
  }

  /** Arrêt propre : plus aucun réveil ; la session en cours, s'il y en a une, se termine. */
  requestStop(reason: string): void {
    this.#stopReason = reason;
    this.#abort.abort();
  }

  async run(): Promise<DaemonSummary> {
    const { uow, db } = this.#store;
    const { profileId } = this.#o;
    const at = utcNow();
    const abandoned = closeAbandonedRuns(db, profileId, at);
    recordDaemonStart(db, {
      id: this.runId,
      profileId,
      pid: process.pid,
      mode: "simulated",
      adapterId: FAKE_ADAPTER_ID,
      startedAt: at,
      endedAt: null,
      endReason: null,
    });
    uow.journal.append(
      prepareJournalEvent({
        type: "daemon_started",
        at,
        profileId,
        reason: "daemon démarré au premier plan (SIMULÉ : adapter factice, aucun appel modèle)",
        metadata: {
          runId: this.runId,
          pid: process.pid,
          mode: "simulated",
          adapterId: FAKE_ADAPTER_ID,
          isolation: "not_implemented",
          abandonedRuns: abandoned.map((r) => r.id),
        },
      }),
    );
    this.#log(`daemon démarré (pid ${String(process.pid)}, exécution ${this.runId})`);
    if (abandoned.length > 0) {
      this.#log(`${String(abandoned.length)} exécution(s) précédente(s) arrêtée(s) brutalement`);
    }

    const startup = this.#runner.reconcileAtStartup();
    if (startup.emergencyStopRecovered) this.#log("arrêt d'urgence non persisté : appliqué");
    for (const orphan of startup.orphans) {
      this.#log(
        `session orpheline ${orphan.sessionId} : close, réservation ${orphan.reservationStatus ?? "inconnue"}, rien n'est rejoué`,
      );
    }
    this.#reconcileArtifacts();

    const scheduler = new Scheduler({
      profileId,
      uow: this.#store.uow,
      state: new SqliteSchedulerStateRepository(db),
      clock: { now: () => Date.now(), monotonic: () => performance.now() },
      environment: new SimulatedEnvironment(this.#runner.adapter, {
        adapterId: FAKE_ADAPTER_ID,
        ...SIMULATED_RUNTIME,
      }),
      priority: this.#signal,
      launcher: this,
      lock: this.#lock,
      recheckIntervalMs: this.#o.recheckIntervalMs ?? DEFAULT_RECHECK_MS,
    });
    this.#scheduler = scheduler;
    try {
      await scheduler.run(this.#abort.signal);
    } finally {
      this.#close();
    }
    return { runId: this.runId, sessions: [...this.#results], reason: this.#stopReason };
  }

  #close(): void {
    const at = utcNow();
    try {
      recordDaemonEnd(this.#store.db, this.runId, at, this.#stopReason);
      this.#store.uow.journal.append(
        prepareJournalEvent({
          type: "daemon_stopped",
          at,
          profileId: this.#o.profileId,
          reason: `daemon arrêté : ${this.#stopReason}`,
          metadata: { runId: this.runId, sessions: this.#results.length, mode: "simulated" },
        }),
      );
    } finally {
      this.#lock.release();
      this.#store.close();
    }
    this.#log(`daemon arrêté : ${this.#stopReason}`);
  }

  #reconcileArtifacts(): void {
    const report = reconcileArtifacts(this.#store.db, this.#root, this.#o.profileId);
    if (report.anomalies.length === 0 && !report.truncated) return;
    this.#store.uow.journal.append(
      prepareJournalEvent({
        type: "orphan_reconciled",
        at: utcNow(),
        profileId: this.#o.profileId,
        reason: "artefacts : anomalies constatées au démarrage (rapport seulement, rien supprimé)",
        metadata: {
          kind: "artifacts",
          referenced: report.referenced,
          scannedFiles: report.scannedFiles,
          truncated: report.truncated,
          anomalies: report.anomalies.map((a) => ({ kind: a.kind, path: a.path })),
        },
      }),
    );
    this.#log(`artefacts : ${String(report.anomalies.length)} anomalie(s) journalisée(s)`);
  }

  // ── SessionLauncher ────────────────────────────────────────────────────────────

  reconcileOrphans(): Promise<void> {
    this.#runner.reconcileAtStartup();
    return Promise.resolve();
  }

  async launch(ticket: LaunchTicket): Promise<SessionReport> {
    const { uow } = this.#store;
    const record = uow.sessions.get(ticket.sessionId);
    const experimentId = record?.experimentId ?? null;
    const tokens = ticket.maxima.find((q) => q.unit === "tokens");
    const maxInputTokens = Math.max(
      1,
      Math.floor((tokens?.unit === "tokens" ? tokens.amount : 0) / 2),
    );
    const memory = this.#memory(experimentId, maxInputTokens);
    const scenario =
      this.#o.scenario ??
      emergenceScenario({
        artifactRoot: this.#root.real,
        artifactsSegment: ARTIFACTS_SEGMENT,
        memory: memory?.included ?? [],
        lastCheckpoint: memory?.checkpoint?.sequence ?? null,
      });
    this.#sessions.set(ticket.sessionId, {
      revisionId: ticket.policyRevisionId,
      experimentId,
      scenario,
    });
    this.#log(
      `session ${ticket.sessionId} lancée (scénario ${scenario.name}, mémoire ${memory?.status ?? "aucune expérience"}${memory?.interruption == null ? "" : ` — ${memory.interruption}`})`,
    );
    let result: SessionResult;
    try {
      const running = await this.#runner.launch({
        profileId: ticket.profileId,
        sessionId: ticket.sessionId,
        experimentId,
        reservationId: ticket.reservationId,
        decision: {
          verdict: "allow",
          revisionId: ticket.policyRevisionId,
          reason: "launch.allowed",
        },
        context: memory?.text ?? "",
        maxInputTokens,
        sessionPrepared: true,
      });
      result = await running.done;
    } catch (error) {
      // Lancement impossible (arrêt survenu entre-temps…) : la session préparée devient
      // orpheline, sa réservation reste incertaine ; rien n'est relancé.
      this.#runner.reconcileAtStartup();
      const detail = error instanceof Error ? error.message : String(error);
      this.#log(`session ${ticket.sessionId} non lancée : ${detail}`);
      this.#sessions.delete(ticket.sessionId);
      return {
        sessionId: ticket.sessionId,
        outcome: "orphaned",
        failure: { kind: "fatal", detail },
      };
    }
    this.#sessions.delete(ticket.sessionId);
    this.#results.push(result);
    this.#log(
      `session ${result.sessionId} terminée : ${result.outcome} (${result.reason}), ${String(result.tokens)} tokens ${result.provenance}, profil ${result.profileState ?? "inconnu"}`,
    );
    const limit = this.#o.exitAfterSessions;
    if (limit !== undefined && this.#results.length >= limit) {
      this.requestStop(`${String(limit)} session(s) terminée(s) (--exit-after-sessions)`);
    }
    return reportFor(result);
  }

  #memory(experimentId: ExperimentId | null, maxInputTokens: number): WakeMemory | null {
    if (experimentId === null) return null;
    const { db, uow } = this.#store;
    const last = db
      .prepare<[string], { id: string }>(
        `SELECT id FROM sessions WHERE experiment_id = ? AND outcome IS NOT NULL
         ORDER BY ended_at DESC, rowid DESC LIMIT 1`,
      )
      .get(experimentId);
    const lastSession: SessionRecord | null =
      last === undefined ? null : uow.sessions.get(last.id as SessionId);
    return loadWakeMemory({ uow, experimentId, maxInputTokens, lastSession });
  }

  // ── Contenu proposé par l'agent (non fiable) ──────────────────────────────────

  #onProposal(sessionId: SessionId, proposal: unknown): void {
    const context = this.#sessions.get(sessionId);
    const revision =
      context === undefined ? null : this.#store.uow.policies.getRevision(context.revisionId);
    if (context === undefined || revision === null) return;
    const outcome = registerProposal(
      {
        uow: this.#store.uow,
        db: this.#store.db,
        profileId: this.#o.profileId,
        sessionId,
        revision,
        now: utcNow,
        simulated: true,
      },
      proposal,
    );
    if (outcome.status === "accepted") {
      context.experimentId = outcome.experiment.id;
      this.#log(`expérience choisie par l'agent : ${outcome.experiment.title}`);
    } else {
      // Une expérience déjà active reste celle de la session.
      context.experimentId ??= this.#store.uow.experiments.getActive(this.#o.profileId)?.id ?? null;
      this.#log(`proposition refusée : ${outcome.reason}`);
    }
  }

  #onCheckpoint(candidate: CheckpointCandidate): void {
    const { uow } = this.#store;
    const context = this.#sessions.get(candidate.sessionId);
    const profile = uow.profiles.get(this.#o.profileId);
    if (context === undefined || profile === null) return;
    const at = utcNow();
    const action = { kind: "publish_checkpoint" };
    const decision = decideAction(
      uow.policies,
      { state: profile.state, emergencyStopLocked: profile.emergencyStopLocked },
      {
        profileId: this.#o.profileId,
        sessionId: candidate.sessionId,
        policyRevisionId: context.revisionId,
      },
      { ...simulatedLiveChecks(this.#signal), now: at },
      action,
    );
    uow.journal.append(
      prepareJournalEvent(
        decisionJournalEvent(decision, {
          profileId: this.#o.profileId,
          at,
          action,
          sessionId: candidate.sessionId,
        }),
      ),
    );
    if (decision.verdict !== "allow") {
      this.#log(`checkpoint refusé par la policy : ${decision.reason}`);
      return;
    }
    const published = publishCheckpoint(
      {
        uow,
        root: this.#root,
        profileId: this.#o.profileId,
        sessionId: candidate.sessionId,
        now: utcNow,
      },
      candidate,
    );
    this.#log(
      published.status === "published"
        ? `checkpoint ${String(published.checkpoint.sequence)} publié (${String(published.checkpoint.artifacts.length)} artefact(s))`
        : `checkpoint rejeté : ${published.reasons.join(", ")}`,
    );
  }

  /** Scheduler en service (tests). */
  get scheduler(): Scheduler | null {
    return this.#scheduler;
  }
}
