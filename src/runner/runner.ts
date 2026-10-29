/**
 * Runner de sessions (SPEC §5, §8.1 et §9 ; AGENTS §5 « Cycle de vie et continuité »).
 *
 * - Lance une session seulement sur une réservation `open` du ledger émise pour elle et
 *   une décision `decideLaunch` positive, profil `ready` revérifié dans la transaction
 *   qui crée la session.
 * - Soumet chaque action contrôlée à `decideAction` au moment de l'action, et réévalue
 *   la session à intervalle court (`assessActiveSession`) : révocation, restriction,
 *   priorité humaine, pause ou arrêt interrompent une session déjà active.
 * - Impose la borne de tokens réservée et la durée maximale de session ; à l'approche
 *   de l'une ou l'autre, demande un checkpoint dans l'enveloppe restante.
 * - Rapproche l'usage (`simulated` pour un adapter simulé) ou laisse la réservation
 *   incertaine à sa borne maximale si la fin ou la consommation ne sont pas confirmées.
 * - Kill switch : persiste d'abord `stopped` verrouillé, bloque toute nouvelle action,
 *   puis termine l'arborescence du job sans attendre le modèle.
 * - Au démarrage, toute session ouverte sans processus confirmé devient `orphaned` ;
 *   rien n'est rejoué.
 */

import type {
  AdapterEvent,
  BudgetQuantity,
  CheckpointCandidate,
  ExperimentId,
  PolicyDecision,
  PolicyRevision,
  ProbeResult,
  ProfileId,
  ProfileRecord,
  ProfileState,
  Reservation,
  ReservationId,
  ReservationStatus,
  RuntimeAdapter,
  SessionHandle,
  SessionId,
  SessionOutcome,
  UnitOfWork,
  UsageProvenance,
  UsageRecord,
  UtcTimestamp,
} from "../contracts/index.js";
import { isProfileTransitionAllowed } from "../contracts/index.js";
import { JournalWriter } from "../journal/index.js";
import {
  assessActiveSession,
  decideAction,
  decisionJournalEvent,
  type ActiveSessionRef,
  type SessionChecks,
} from "../policy/index.js";
import {
  pauseRequestedSince,
  persistEmergencyStop,
  requestPause,
  requestResume,
  STOP_REASON,
  type EmergencyStopPersistence,
  type PauseResult,
  type ResumeResult,
  type StopFlag,
} from "./controls.js";
import { canRequestCheckpoint, type AdapterHost, type AuthorizationVerdict } from "./host.js";
import {
  DEFAULT_TERMINATION_TIMEOUT_MS,
  type ContainedCommand,
  type ContainedExit,
  type ContainedProcess,
  type NamedTermination,
  type ProcessTreeSupervisor,
  type TreeTermination,
} from "./process-tree.js";

export class RunnerError extends Error {
  override readonly name = "RunnerError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Autorisation de lancement fournie par le scheduler (S6). */
export interface LaunchGrant {
  readonly profileId: ProfileId;
  readonly sessionId: SessionId;
  readonly experimentId: ExperimentId | null;
  /** Réservation `open` émise pour `sessionId` par le ledger. */
  readonly reservationId: ReservationId;
  /** Décision `decideLaunch` ; seul un accord est accepté. */
  readonly decision: PolicyDecision;
  /** Contexte borné transmis à l'agent ; aucun credential. */
  readonly context: string;
  readonly maxInputTokens: number;
}

export interface SessionResult {
  readonly sessionId: SessionId;
  readonly outcome: SessionOutcome;
  readonly reason: string;
  /** État du profil après la session, `null` si la persistance a échoué. */
  readonly profileState: ProfileState | null;
  readonly reservationStatus: ReservationStatus | null;
  readonly tokens: number;
  readonly provenance: UsageProvenance;
  readonly termination: TreeTermination | null;
  readonly checkpointCandidates: number;
  /** Échec de persistance en fin de session : la réconciliation au démarrage reprendra. */
  readonly persistenceError?: string;
}

export interface RunningSession {
  readonly sessionId: SessionId;
  readonly done: Promise<SessionResult>;
}

export interface StopReport {
  readonly persistence: EmergencyStopPersistence;
  /** Terminaison de la session menée par ce runner, si elle existe. */
  readonly termination: TreeTermination | null;
  /** Terminaisons par nom des sessions ouvertes lancées hors de ce runner. */
  readonly namedTerminations: readonly { sessionId: SessionId; result: NamedTermination }[];
  /** Délai total depuis l'appel, persistance comprise. */
  readonly elapsedMs: number;
}

export interface OrphanReport {
  readonly sessionId: SessionId;
  /** Job encore présent au démarrage (`null` : vérification impossible). */
  readonly processFound: boolean | null;
  readonly termination: NamedTermination | null;
  readonly reservationStatus: ReservationStatus | null;
}

export interface StartupReport {
  /** Arrêt d'urgence non persisté avant le redémarrage, appliqué maintenant. */
  readonly emergencyStopRecovered: boolean;
  readonly orphans: readonly OrphanReport[];
}

export interface RunnerOptions {
  /** Période de réévaluation de la session active. */
  readonly watchdogIntervalMs: number;
  /** Borne de terminaison de l'arborescence (ADR-003 : 1 s). */
  readonly terminationTimeoutMs: number;
  /** Délai maximal accordé à un checkpoint demandé avant terminaison. */
  readonly checkpointGraceMs: number;
}

export const DEFAULT_RUNNER_OPTIONS: RunnerOptions = {
  watchdogIntervalMs: 50,
  terminationTimeoutMs: DEFAULT_TERMINATION_TIMEOUT_MS,
  checkpointGraceMs: 2_000,
};

export interface RunnerDeps {
  readonly uow: UnitOfWork;
  readonly profileId: ProfileId;
  readonly supervisor: ProcessTreeSupervisor;
  /** Construit l'adapter avec les services du runner. */
  readonly adapter: (host: AdapterHost) => RuntimeAdapter;
  readonly stopFlag: StopFlag;
  /** Conditions vivantes revérifiées avant chaque action : priorité humaine, sandbox… */
  readonly liveChecks: () => Omit<SessionChecks, "now">;
  readonly now?: () => Date;
  /** Checkpoints candidats, à valider par S8 ; le runner ne publie rien. */
  readonly onCheckpointCandidate?: (candidate: CheckpointCandidate) => void;
  readonly options?: Partial<RunnerOptions>;
}

type InterruptionKind =
  "stop" | "pause" | "policy" | "deadline" | "budget" | "rate_limited" | "adapter_error";

interface Interruption {
  readonly kind: InterruptionKind;
  readonly outcome: SessionOutcome;
  readonly reason: string;
  /** État visé en fin de session (hors arrêt d'urgence et pause, qui priment). */
  readonly next: "hibernating" | "blocked";
}

interface ActiveSession {
  readonly grant: LaunchGrant;
  readonly ref: ActiveSessionRef;
  readonly revision: PolicyRevision;
  readonly reservation: Reservation;
  readonly maxTokens: number;
  readonly startSequence: number;
  readonly startedAtMs: number;
  readonly deadlineMs: number;
  handle: SessionHandle | null;
  process: ContainedProcess | null;
  tokens: number;
  lastUsageMs: number;
  ended: string | null;
  interruption: Interruption | null;
  /** Plus aucune action accordée. */
  halted: boolean;
  /** Le runner a lui-même placé le profil en `checkpointing`. */
  selfCheckpointing: boolean;
  checkpointRequested: boolean;
  terminating: Promise<TreeTermination> | null;
  termination: TreeTermination | null;
  checkpointCandidates: number;
  finishing: boolean;
}

function utc(ms: number): UtcTimestamp {
  return new Date(ms).toISOString() as UtcTimestamp;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

const STATE_AFTER_PAUSE: ProfileState = "paused";

export class SessionRunner {
  readonly adapter: RuntimeAdapter;
  readonly host: AdapterHost;
  readonly #uow: UnitOfWork;
  readonly #profileId: ProfileId;
  readonly #supervisor: ProcessTreeSupervisor;
  readonly #stopFlag: StopFlag;
  readonly #liveChecks: RunnerDeps["liveChecks"];
  readonly #now: () => Date;
  readonly #onCheckpoint: RunnerDeps["onCheckpointCandidate"];
  readonly #options: RunnerOptions;
  readonly #journal: JournalWriter;
  #active: ActiveSession | null = null;
  #probe: ProbeResult | null = null;

  constructor(deps: RunnerDeps) {
    this.#uow = deps.uow;
    this.#profileId = deps.profileId;
    this.#supervisor = deps.supervisor;
    this.#stopFlag = deps.stopFlag;
    this.#liveChecks = deps.liveChecks;
    this.#now = deps.now ?? (() => new Date());
    this.#onCheckpoint = deps.onCheckpointCandidate;
    this.#options = { ...DEFAULT_RUNNER_OPTIONS, ...deps.options };
    this.#journal = new JournalWriter(deps.uow.journal);
    this.host = {
      spawnContained: (sessionId, command) => this.#spawnContained(sessionId, command),
      authorize: (sessionId, action) => this.#authorize(sessionId, action),
    };
    this.adapter = deps.adapter(this.host);
  }

  get activeSessionId(): SessionId | null {
    return this.#active?.grant.sessionId ?? null;
  }

  #nowMs(): number {
    return this.#now().getTime();
  }

  // ── Lancement ──────────────────────────────────────────────────────────────────

  async launch(grant: LaunchGrant): Promise<RunningSession> {
    if (grant.profileId !== this.#profileId) {
      throw new RunnerError("wrong_profile", "autorisation émise pour un autre profil");
    }
    if (this.#active !== null) {
      throw new RunnerError("session_already_active", "une session est déjà en cours");
    }
    if (!this.#supervisor.status.available) {
      throw new RunnerError("termination_unavailable", this.#supervisor.status.reason);
    }
    if (this.#stopFlag.exists()) {
      throw new RunnerError(
        "emergency_stop_pending",
        "arrêt d'urgence non persisté : réconciliation au démarrage requise",
      );
    }
    const decision = grant.decision;
    if (decision.verdict !== "allow") {
      throw new RunnerError("launch_not_allowed", `lancement refusé : ${decision.reason}`);
    }
    this.#probe ??= await this.adapter.probe();
    const probe = this.#probe;
    if (!probe.available || probe.adapterId !== this.adapter.id) {
      throw new RunnerError("adapter_unavailable", "adapter indisponible ou non conforme");
    }

    const nowMs = this.#nowMs();
    const at = utc(nowMs);
    const prepared = this.#uow.transaction((tx) => {
      const profile = tx.profiles.get(grant.profileId);
      if (profile === null) throw new RunnerError("unknown_profile", "profil inconnu");
      if (profile.emergencyStopLocked || profile.state !== "ready") {
        throw new RunnerError(
          "profile_not_ready",
          `profil en état ${profile.state}${profile.emergencyStopLocked ? " (arrêt d'urgence verrouillé)" : ""}`,
        );
      }
      const reservation = tx.ledger.getReservation(grant.reservationId);
      if (reservation?.status !== "open" || reservation.sessionId !== grant.sessionId) {
        throw new RunnerError(
          "reservation_not_open",
          "réservation absente, close ou d'une autre session",
        );
      }
      const tokens = reservation.maxima.find((q) => q.unit === "tokens");
      if (tokens === undefined) {
        throw new RunnerError("reservation_unbounded", "réservation sans borne de tokens");
      }
      const revision = tx.policies.getRevision(decision.revisionId);
      if (revision === null || tx.policies.listRevocations(revision.id).length > 0) {
        throw new RunnerError("policy_not_effective", "révision de policy inconnue ou révoquée");
      }
      tx.sessions.create({
        id: grant.sessionId,
        profileId: grant.profileId,
        experimentId: grant.experimentId,
        adapterId: this.adapter.id,
        policyRevisionId: revision.id,
        reservationId: reservation.id,
        startedAt: at,
        endedAt: null,
        outcome: null,
        outcomeReason: null,
      });
      tx.profiles.transition(profile.id, {
        from: "ready",
        to: "running",
        reason: "session lancée",
        at,
        sessionId: grant.sessionId,
      });
      this.#recordState(profile, "running", "session lancée", at, grant.sessionId);
      const started = this.#journal.record({
        type: "session_started",
        at,
        profileId: profile.id,
        sessionId: grant.sessionId,
        ...(grant.experimentId === null ? {} : { experimentId: grant.experimentId }),
        policyRevisionId: revision.id,
        reason: probe.simulated ? "session SIMULÉE lancée" : "session lancée",
        metadata: {
          adapterId: this.adapter.id,
          simulated: probe.simulated,
          reservationId: reservation.id,
          maxTokens: tokens.amount,
        },
      });
      return { revision, reservation, maxTokens: tokens.amount, startSequence: started.sequence };
    });

    const session: ActiveSession = {
      grant,
      ref: {
        profileId: grant.profileId,
        sessionId: grant.sessionId,
        policyRevisionId: prepared.revision.id,
      },
      revision: prepared.revision,
      reservation: prepared.reservation,
      maxTokens: prepared.maxTokens,
      startSequence: prepared.startSequence,
      startedAtMs: nowMs,
      deadlineMs: nowMs + prepared.revision.groups.schedule.maxSessionDurationMs,
      handle: null,
      process: null,
      tokens: 0,
      lastUsageMs: 0,
      ended: null,
      interruption: null,
      halted: false,
      selfCheckpointing: false,
      checkpointRequested: false,
      terminating: null,
      termination: null,
      checkpointCandidates: 0,
      finishing: false,
    };
    this.#active = session;
    return { sessionId: grant.sessionId, done: this.#drive(session) };
  }

  async #drive(session: ActiveSession): Promise<SessionResult> {
    const watchdog = setInterval(() => {
      this.#tick(session);
    }, this.#options.watchdogIntervalMs);
    try {
      try {
        session.handle = await this.adapter.start({
          sessionId: session.grant.sessionId,
          reservationId: session.reservation.id,
          policy: session.revision,
          context: session.grant.context,
          maxInputTokens: session.grant.maxInputTokens,
          deadline: utc(session.deadlineMs),
        });
      } catch (error) {
        this.#interrupt(session, {
          kind: "adapter_error",
          outcome: "failed",
          reason: `adapter.start_failed: ${error instanceof Error ? error.message : String(error)}`,
          next: "hibernating",
        });
      }
      if (session.handle !== null) {
        this.#tick(session);
        try {
          for await (const event of this.adapter.events(session.handle)) {
            this.#onEvent(session, event);
          }
        } catch (error) {
          this.#interrupt(session, {
            kind: "adapter_error",
            outcome: "failed",
            reason: `adapter.events_failed: ${error instanceof Error ? error.message : String(error)}`,
            next: "hibernating",
          });
        }
      }
      const exit: ContainedExit | null =
        session.process === null ? null : await session.process.exited;
      if (session.terminating !== null) session.termination = await session.terminating;
      return await this.#finish(session, exit);
    } finally {
      clearInterval(watchdog);
      if (this.#active === session) this.#active = null;
    }
  }

  // ── Services offerts à l'adapter ───────────────────────────────────────────────

  #spawnContained(sessionId: SessionId, command: ContainedCommand): ContainedProcess {
    const session = this.#active;
    if (session?.grant.sessionId !== sessionId || session.halted || session.process !== null) {
      throw new RunnerError("spawn_refused", "lancement de processus hors de la session active");
    }
    const maxProcesses = session.revision.groups.filesAndTools.maxProcesses;
    session.process = this.#supervisor.spawn(session.grant.profileId, sessionId, {
      ...command,
      maxProcesses: Math.min(command.maxProcesses ?? maxProcesses, maxProcesses),
    });
    return session.process;
  }

  #authorize(sessionId: SessionId, action: unknown): AuthorizationVerdict {
    const session = this.#active;
    // Signaux lus avant l'horloge : un signal ne peut pas sembler postérieur à `now`.
    const live = this.#liveChecks();
    const at = utc(this.#nowMs());
    if (session?.grant.sessionId !== sessionId) {
      return { allowed: false, reason: "unknown_condition", interruptSession: true };
    }
    if (session.halted) {
      const reason = session.interruption?.kind === "stop" ? "stopped" : "session_interrupted";
      this.#journal.record({
        type: "action_denied",
        at,
        profileId: session.ref.profileId,
        sessionId,
        policyRevisionId: session.ref.policyRevisionId,
        reason,
        metadata: { verdict: "deny", detail: "session.halted", interruptSession: true },
      });
      return { allowed: false, reason, interruptSession: true };
    }
    const profile = this.#uow.profiles.get(session.ref.profileId);
    const decision = decideAction(
      this.#uow.policies,
      profile === null
        ? { state: "stopped", emergencyStopLocked: true }
        : { state: profile.state, emergencyStopLocked: profile.emergencyStopLocked },
      session.ref,
      { ...live, now: at },
      action,
    );
    this.#journal.record(
      decisionJournalEvent(decision, { profileId: session.ref.profileId, at, action, sessionId }),
    );
    if (decision.interruptSession) {
      session.halted = true;
      queueMicrotask(() => {
        this.#tick(session);
      });
    }
    return {
      allowed: decision.verdict === "allow",
      reason: decision.reason,
      interruptSession: decision.interruptSession,
    };
  }

  // ── Événements de l'adapter ────────────────────────────────────────────────────

  #onEvent(session: ActiveSession, event: AdapterEvent): void {
    const at = utc(this.#nowMs());
    const base = {
      at,
      profileId: session.ref.profileId,
      sessionId: session.ref.sessionId,
      policyRevisionId: session.ref.policyRevisionId,
    };
    switch (event.type) {
      case "usage":
        this.#recordUsage(session, event.quantity, event.provenance);
        break;
      case "checkpoint_candidate":
        session.checkpointCandidates += 1;
        try {
          this.#onCheckpoint?.(event.candidate);
        } catch {
          // Un consommateur défaillant ne doit pas bloquer le cycle de la session.
        }
        break;
      case "rate_limited":
        this.#journal.record({
          ...base,
          type: "rate_limited",
          reason: "limitation fournisseur : attente ou hibernation",
          metadata: { retryAfterMs: event.retryAfterMs },
        });
        this.#interrupt(session, {
          kind: "rate_limited",
          outcome: "interrupted",
          reason: "provider.rate_limited",
          next: "hibernating",
        });
        break;
      case "error": {
        this.#journal.record({
          ...base,
          type: "error",
          reason: `adapter.${event.code}`,
          metadata: { code: event.code, message: event.message },
        });
        const blocking = event.code === "auth_failed" || event.code === "incompatible";
        this.#interrupt(session, {
          kind: "adapter_error",
          outcome: "failed",
          reason: `adapter.${event.code}`,
          next: blocking ? "blocked" : "hibernating",
        });
        break;
      }
      case "ended":
        session.ended = event.exitReason;
        break;
      case "started":
      case "activity":
      case "artifact_candidate":
        break;
    }
  }

  #recordUsage(
    session: ActiveSession,
    quantity: BudgetQuantity,
    provenance: UsageProvenance,
  ): void {
    if (quantity.unit !== "tokens") return;
    // Usage rejoué à l'identique ignoré par le ledger : horodatages strictement croissants.
    const ms = Math.max(this.#nowMs(), session.lastUsageMs + 1);
    session.lastUsageMs = ms;
    session.tokens += quantity.amount;
    const effective = this.#probe?.simulated === true ? "simulated" : provenance;
    try {
      this.#uow.ledger.recordUsage({
        reservationId: session.reservation.id,
        quantity,
        provenance: effective,
        recordedAt: utc(ms),
      });
      this.#journal.record({
        type: "usage_recorded",
        at: utc(ms),
        profileId: session.ref.profileId,
        sessionId: session.ref.sessionId,
        reason: effective === "simulated" ? "usage SIMULÉ" : "usage rapporté",
        metadata: {
          unit: "tokens",
          amount: quantity.amount,
          provenance: effective,
          total: session.tokens,
        },
      });
    } catch {
      // Ledger indisponible : la réservation restera incertaine à sa borne en fin de session.
    }
    if (session.tokens >= session.maxTokens) {
      this.#interrupt(session, {
        kind: "budget",
        outcome: "interrupted",
        reason: "budget.session_token_bound_reached",
        next: "hibernating",
      });
    } else if (
      session.tokens >=
      session.maxTokens - session.revision.groups.budget.checkpointTokens
    ) {
      this.#interruptWithCheckpoint(session, {
        kind: "budget",
        outcome: "interrupted",
        reason: "budget.checkpoint_reserve_reached",
        next: "hibernating",
      });
    }
  }

  // ── Surveillance et interruptions ──────────────────────────────────────────────

  #tick(session: ActiveSession): void {
    if (session.finishing) return;
    let profile: ProfileRecord | null;
    try {
      profile = this.#uow.profiles.get(session.ref.profileId);
    } catch {
      profile = null;
    }
    if (
      profile === null ||
      profile.emergencyStopLocked ||
      profile.state === "stopped" ||
      this.#stopFlag.exists()
    ) {
      this.#interrupt(session, STOP_INTERRUPTION);
      return;
    }
    if (profile.state === "checkpointing" && !session.selfCheckpointing) {
      this.#interruptWithCheckpoint(session, {
        kind: "pause",
        outcome: "interrupted",
        reason: "user.pause",
        next: "hibernating",
      });
      return;
    }
    const live = this.#liveChecks();
    const nowMs = this.#nowMs();
    const assessment = assessActiveSession(
      this.#uow.policies,
      { state: profile.state, emergencyStopLocked: profile.emergencyStopLocked },
      session.ref,
      { ...live, now: utc(nowMs) },
    );
    if (assessment.interruptSession) {
      const interruption: Interruption = {
        kind: "policy",
        outcome: "interrupted",
        reason: `policy.${assessment.reason}: ${assessment.detail}`,
        next: ["revoked", "sandbox_unavailable", "not_consented", "unknown_condition"].includes(
          assessment.reason,
        )
          ? "blocked"
          : "hibernating",
      };
      if (assessment.checkpointAllowed) this.#interruptWithCheckpoint(session, interruption);
      else this.#interrupt(session, interruption);
      return;
    }
    if (nowMs >= session.deadlineMs) {
      this.#interrupt(session, DEADLINE_INTERRUPTION);
    } else if (nowMs >= session.deadlineMs - this.#options.checkpointGraceMs) {
      this.#interruptWithCheckpoint(session, DEADLINE_INTERRUPTION);
    }
  }

  /** Interruption immédiate : plus aucune action, terminaison de l'arborescence. */
  #interrupt(session: ActiveSession, interruption: Interruption): void {
    if (session.finishing) return;
    if (session.interruption === null || interruption.kind === "stop") {
      if (session.interruption?.kind !== "stop") session.interruption = interruption;
    }
    session.halted = true;
    this.#terminate(session);
  }

  /**
   * Interruption avec checkpoint borné : plus aucune action, checkpoint demandé si
   * l'enveloppe restante le permet (tokens de checkpoint et temps avant l'échéance),
   * puis terminaison au plus tard à l'expiration du délai de grâce.
   */
  #interruptWithCheckpoint(session: ActiveSession, interruption: Interruption): void {
    if (session.finishing || session.interruption !== null) return;
    session.interruption = interruption;
    session.halted = true;
    this.#enterCheckpointing(session);
    const remainingTokens = session.maxTokens - session.tokens;
    const remainingMs = session.deadlineMs - this.#nowMs();
    const handle = session.handle;
    if (
      handle === null ||
      !canRequestCheckpoint(this.adapter) ||
      remainingTokens <= 0 ||
      remainingTokens <
        Math.min(session.revision.groups.budget.checkpointTokens, session.maxTokens) ||
      remainingMs <= 0
    ) {
      this.#terminate(session);
      return;
    }
    session.checkpointRequested = true;
    void this.adapter.requestCheckpoint(handle).catch(() => undefined);
    void sleep(Math.min(this.#options.checkpointGraceMs, remainingMs)).then(() => {
      this.#terminate(session);
    });
  }

  /** Le profil passe en `checkpointing` à l'initiative du runner (jamais après un arrêt). */
  #enterCheckpointing(session: ActiveSession): void {
    session.selfCheckpointing = true;
    try {
      this.#uow.transaction((tx) => {
        const profile = tx.profiles.get(session.ref.profileId);
        if (profile?.state !== "running") return;
        const at = utc(this.#nowMs());
        const reason = `checkpoint demandé : ${session.interruption?.reason ?? "interruption"}`;
        tx.profiles.transition(profile.id, {
          from: "running",
          to: "checkpointing",
          reason,
          at,
          sessionId: session.ref.sessionId,
        });
        this.#recordState(profile, "checkpointing", reason, at, session.ref.sessionId);
      });
    } catch {
      // Persistance impossible : la session sera quand même terminée.
    }
  }

  #terminate(session: ActiveSession): void {
    if (session.terminating !== null || session.process === null) return;
    session.terminating = session.process.terminateTree(this.#options.terminationTimeoutMs);
  }

  // ── Fin de session ─────────────────────────────────────────────────────────────

  async #finish(session: ActiveSession, exit: ContainedExit | null): Promise<SessionResult> {
    session.finishing = true;
    const sessionId = session.ref.sessionId;
    const termination = session.termination;
    const unconfirmed = termination !== null && !termination.confirmed;
    const reconciled =
      unconfirmed || this.#probe === null
        ? null
        : await this.adapter.reconcile(sessionId).catch(() => null);
    const nowMs = this.#nowMs();
    const at = utc(nowMs);

    let outcome: SessionOutcome;
    let reason: string;
    let next: ProfileState | null;
    const interruption = session.interruption;
    let profileNow: ProfileRecord | null;
    try {
      profileNow = this.#uow.profiles.get(session.ref.profileId);
    } catch {
      profileNow = null;
    }
    const stopped =
      interruption?.kind === "stop" ||
      this.#stopFlag.exists() ||
      profileNow === null ||
      profileNow.emergencyStopLocked ||
      profileNow.state === "stopped";
    if (unconfirmed) {
      outcome = "orphaned";
      reason = `termination_unconfirmed: ${termination.detail ?? ""}`;
      next = "blocked";
    } else if (stopped) {
      outcome = "interrupted";
      reason = "kill_switch";
      next = null;
    } else if (interruption !== null) {
      outcome = interruption.outcome;
      reason = interruption.reason;
      next = interruption.next;
    } else if (session.ended !== null && exit?.mainExitCode === 0) {
      outcome = "completed";
      reason = session.ended;
      next = "hibernating";
    } else {
      outcome = "failed";
      reason = `process.exited_without_end: code=${String(exit?.mainExitCode ?? "inconnu")}`;
      next = "hibernating";
    }

    const simulated = this.#probe?.simulated === true;
    const provenance: UsageProvenance =
      reconciled?.status === "confirmed"
        ? simulated
          ? "simulated"
          : reconciled.provenance
        : "unknown";
    const usage =
      reconciled?.status === "confirmed"
        ? this.#finalUsage(session, reconciled.usage, provenance, nowMs)
        : null;

    try {
      return this.#uow.transaction((tx) => {
        const reservation =
          usage === null
            ? tx.ledger.markUncertain(session.reservation.id, at)
            : tx.ledger.reconcile(session.reservation.id, usage, at);
        tx.sessions.close(sessionId, outcome, reason, at);
        const base = {
          at,
          profileId: session.ref.profileId,
          sessionId,
          policyRevisionId: session.ref.policyRevisionId,
        };
        this.#journal.record({
          ...base,
          type: usage === null ? "budget_marked_uncertain" : "budget_reconciled",
          reason:
            usage === null
              ? "consommation non confirmée : réservation conservée à sa borne maximale"
              : `consommation rapprochée (${provenance})`,
          metadata: {
            reservationId: reservation.id,
            status: reservation.status,
            tokens: session.tokens,
            provenance,
          },
        });
        const profileState = this.#settleProfile(tx, session, next, at);
        this.#journal.record({
          ...base,
          type: "session_ended",
          reason: `${outcome}: ${reason}`,
          metadata: {
            outcome,
            simulated,
            tokens: session.tokens,
            provenance,
            checkpointCandidates: session.checkpointCandidates,
            checkpointRequested: session.checkpointRequested,
            terminationMs:
              termination === null ? null : Math.round(termination.elapsedMs * 1000) / 1000,
            terminationVia: termination?.via ?? null,
            mainExitCode: exit?.mainExitCode ?? null,
          },
        });
        return {
          sessionId,
          outcome,
          reason,
          profileState,
          reservationStatus: reservation.status,
          tokens: session.tokens,
          provenance,
          termination,
          checkpointCandidates: session.checkpointCandidates,
        };
      });
    } catch (error) {
      return {
        sessionId,
        outcome,
        reason,
        profileState: null,
        reservationStatus: null,
        tokens: session.tokens,
        provenance: "unknown",
        termination,
        checkpointCandidates: session.checkpointCandidates,
        persistenceError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Usage à transmettre au rapprochement, en plus des incréments déjà enregistrés :
   * le complément de tokens confirmé, une session et la durée si elles sont réservées.
   * Une unité réservée sans usage serait imputée à sa borne, provenance inconnue.
   */
  #finalUsage(
    session: ActiveSession,
    confirmed: readonly BudgetQuantity[],
    provenance: UsageProvenance,
    nowMs: number,
  ): UsageRecord[] {
    const records: UsageRecord[] = [];
    const recordedAt = utc(Math.max(nowMs, session.lastUsageMs + 1));
    const push = (quantity: BudgetQuantity): void => {
      records.push({ reservationId: session.reservation.id, quantity, provenance, recordedAt });
    };
    const confirmedTokens = confirmed.reduce(
      (sum, q) => sum + (q.unit === "tokens" ? q.amount : 0),
      0,
    );
    const delta = confirmedTokens - session.tokens;
    if (delta > 0 || session.tokens === 0) push({ unit: "tokens", amount: Math.max(0, delta) });
    if (delta > 0) session.tokens = confirmedTokens;
    for (const max of session.reservation.maxima) {
      if (max.unit === "sessions") push({ unit: "sessions", amount: 1 });
      if (max.unit === "duration_ms") {
        push({ unit: "duration_ms", amount: Math.max(0, Math.ceil(nowMs - session.startedAtMs)) });
      }
    }
    return records;
  }

  /** État final du profil ; l'arrêt d'urgence prime, puis la pause demandée. */
  #settleProfile(
    tx: UnitOfWork,
    session: ActiveSession,
    next: ProfileState | null,
    at: UtcTimestamp,
  ): ProfileState | null {
    const profile = tx.profiles.get(session.ref.profileId);
    if (profile === null) return null;
    if (next === null || profile.state === "stopped" || profile.emergencyStopLocked) {
      return profile.state;
    }
    const paused =
      session.interruption?.kind === "pause" ||
      pauseRequestedSince(tx, profile.id, session.startSequence);
    const target = paused ? STATE_AFTER_PAUSE : next;
    return this.#moveProfile(tx, profile, target, at, session.ref.sessionId);
  }

  #moveProfile(
    tx: UnitOfWork,
    profile: ProfileRecord,
    target: ProfileState,
    at: UtcTimestamp,
    sessionId: SessionId,
  ): ProfileState {
    let current = profile;
    const step = (to: ProfileState, reason: string): void => {
      tx.profiles.transition(current.id, { from: current.state, to, reason, at, sessionId });
      this.#recordState(current, to, reason, at, sessionId);
      current = { ...current, state: to, stateReason: reason };
    };
    if (current.state === "running" && target !== "blocked") {
      step("checkpointing", "fin de session : checkpoint");
    }
    if (current.state !== target && isProfileTransitionAllowed(current.state, target)) {
      step(target, `fin de session : ${target}`);
    }
    return current.state;
  }

  #recordState(
    profile: ProfileRecord,
    to: ProfileState,
    reason: string,
    at: UtcTimestamp,
    sessionId?: SessionId,
  ): void {
    this.#journal.record({
      type: "profile_state_changed",
      at,
      profileId: profile.id,
      ...(sessionId === undefined ? {} : { sessionId }),
      reason,
      metadata: { from: profile.state, to },
    });
  }

  // ── Contrôles humains ──────────────────────────────────────────────────────────

  /**
   * Kill switch : persiste `stopped` verrouillé (ou, à défaut, le marqueur de secours),
   * bloque toute nouvelle action, puis termine l'arborescence sans attendre le modèle.
   * La terminaison a lieu même si la persistance a échoué.
   */
  async stop(reason = STOP_REASON): Promise<StopReport> {
    const begin = performance.now();
    const persistence = persistEmergencyStop(
      { uow: this.#uow, profileId: this.#profileId, now: this.#now },
      this.#stopFlag,
      reason,
    );
    const session = this.#active;
    let termination: TreeTermination | null = null;
    if (session !== null) {
      this.#interrupt(session, STOP_INTERRUPTION);
      if (session.terminating !== null) termination = await session.terminating;
    }
    const namedTerminations: { sessionId: SessionId; result: NamedTermination }[] = [];
    let open: readonly { id: SessionId }[];
    try {
      open = this.#uow.sessions.listOpen(this.#profileId);
    } catch {
      open = [];
    }
    for (const record of open) {
      if (record.id === session?.ref.sessionId) continue;
      namedTerminations.push({
        sessionId: record.id,
        result: this.#supervisor.terminate(
          this.#profileId,
          record.id,
          this.#options.terminationTimeoutMs,
        ),
      });
    }
    return { persistence, termination, namedTerminations, elapsedMs: performance.now() - begin };
  }

  /** Pause : plus aucun réveil ; une session active reçoit une demande de checkpoint. */
  pause(): PauseResult {
    const result = requestPause({ uow: this.#uow, profileId: this.#profileId, now: this.#now });
    const session = this.#active;
    if (session !== null) this.#tick(session);
    return result;
  }

  resume(): ResumeResult {
    return requestResume({ uow: this.#uow, profileId: this.#profileId, now: this.#now });
  }

  // ── Réconciliation au démarrage ────────────────────────────────────────────────

  /**
   * À appeler au démarrage du daemon, avant tout lancement. Applique un arrêt d'urgence
   * resté en marqueur de secours, puis rend `orphaned` chaque session ouverte que ce
   * runner ne mène pas : un job encore présent est terminé, la réservation reste
   * incertaine à sa borne maximale, et rien n'est relancé ni rejoué.
   */
  reconcileAtStartup(): StartupReport {
    let emergencyStopRecovered = false;
    if (this.#stopFlag.exists()) {
      const persisted = persistEmergencyStop(
        { uow: this.#uow, profileId: this.#profileId, now: this.#now },
        this.#stopFlag,
        "récupération : arrêt d'urgence non persisté avant le redémarrage",
      );
      if (persisted.persisted) {
        this.#stopFlag.clear();
        emergencyStopRecovered = true;
      }
    }
    const orphans: OrphanReport[] = [];
    for (const record of this.#uow.sessions.listOpen(this.#profileId)) {
      if (record.id === this.#active?.ref.sessionId) continue;
      const query = this.#supervisor.query(this.#profileId, record.id);
      const termination =
        query.found === false
          ? null
          : this.#supervisor.terminate(
              this.#profileId,
              record.id,
              this.#options.terminationTimeoutMs,
            );
      const at = utc(this.#nowMs());
      const reservationStatus = this.#uow.transaction((tx) => {
        const reservation = tx.ledger.getReservation(record.reservationId);
        const kept =
          reservation === null ? null : tx.ledger.markUncertain(record.reservationId, at).status;
        const reason =
          query.found === true
            ? "processus sans runner au démarrage : terminé"
            : "aucun processus confirmé au démarrage";
        tx.sessions.close(record.id, "orphaned", reason, at);
        const base = {
          at,
          profileId: this.#profileId,
          sessionId: record.id,
          policyRevisionId: record.policyRevisionId,
        };
        this.#journal.record({
          ...base,
          type: "orphan_reconciled",
          reason,
          metadata: {
            processFound: query.found,
            terminated: termination?.confirmed ?? null,
            reservationStatus: kept,
            replayed: false,
          },
        });
        if (kept !== null && kept !== "reconciled") {
          this.#journal.record({
            ...base,
            type: "budget_marked_uncertain",
            reason: "session orpheline : réservation conservée à sa borne maximale",
            metadata: { reservationId: record.reservationId, status: kept },
          });
        }
        const profile = tx.profiles.get(this.#profileId);
        if (
          profile !== null &&
          (profile.state === "running" || profile.state === "checkpointing")
        ) {
          const startedSeq = tx.journal
            .list(this.#profileId)
            .find(
              (event) => event.type === "session_started" && event.sessionId === record.id,
            )?.sequence;
          const paused =
            profile.state === "checkpointing" &&
            pauseRequestedSince(tx, this.#profileId, startedSeq ?? 0);
          this.#moveProfile(tx, profile, paused ? "paused" : "blocked", at, record.id);
        }
        return kept;
      });
      orphans.push({
        sessionId: record.id,
        processFound: query.found,
        termination,
        reservationStatus,
      });
    }
    return { emergencyStopRecovered, orphans };
  }
}

const STOP_INTERRUPTION: Interruption = {
  kind: "stop",
  outcome: "interrupted",
  reason: "kill_switch",
  next: "blocked",
};

const DEADLINE_INTERRUPTION: Interruption = {
  kind: "deadline",
  outcome: "interrupted",
  reason: "schedule.max_session_duration_reached",
  next: "hibernating",
};
