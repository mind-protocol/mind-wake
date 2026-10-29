/**
 * Scheduler (SPEC §5) : décide, sans appel modèle, si un réveil est permis, réserve
 * l'enveloppe dans la même transaction que la création de session et le passage en
 * `running`, puis confie le lancement au port `SessionLauncher`.
 *
 * Règles :
 * - Toutes les conditions de SPEC §5.1 passent par `decideLaunch` ; un fait absent, en
 *   erreur ou hors délai reste inconnu, donc refusé, avec motif journalisé.
 * - Évaluation seulement en `ready` ou `hibernating` ; `disabled`, `paused`, `blocked`,
 *   `stopped`, `running` et `checkpointing` ne déclenchent rien.
 * - En `hibernating`, rien avant l'échéance persistée ; à l'échéance, une seule
 *   évaluation (pas de rattrapage des réveils manqués pendant une veille). Un réveil
 *   demandé par l'agent (`wakeRequests`) peut avancer cette évaluation, jamais l'accorder.
 * - Refus en `ready` : attente temporaire → `hibernating`, intervention requise →
 *   `blocked`, arrêt verrouillé → `stopped`. Refus en `hibernating` : on y reste, et
 *   le motif n'est journalisé que s'il change (scheduler calme).
 * - Échéances persistées en UTC ; backoff aussi gardé sur l'horloge monotone tant que
 *   le processus vit : un saut d'horloge murale vers l'avant ne l'abrège pas.
 */

import { randomUUID } from "node:crypto";
import type {
  BudgetAvailability,
  BudgetPeriod,
  BudgetPeriodDefinition,
  BudgetQuantity,
  PeriodLimit,
  PolicyDecision,
  PolicyRevision,
  ProfileId,
  ProfileRecord,
  ProfileState,
  ProviderQuotaSnapshot,
  ReservationId,
  SessionId,
  UnitOfWork,
  UtcTimestamp,
} from "../contracts/index.js";
import { prepareJournalEvent } from "../journal/index.js";
import {
  decideLaunch,
  decisionJournalEvent,
  resolvePolicy,
  planPacing,
  type BillingFacts,
  type LaunchFacts,
  type PacingEstimate,
  type PrioritySignal,
} from "../policy/index.js";
import {
  DEFAULT_BACKOFF,
  assertBackoffPolicy,
  decideAfterFailure,
  type BackoffPolicy,
  type SessionFailure,
} from "./backoff.js";
import type { SchedulerClock } from "./clock.js";
import type { InstanceLock } from "./instance-lock.js";
import { transitionProfile } from "./lifecycle.js";
import type {
  LaunchEnvironment,
  LaunchTicket,
  SessionLauncher,
  SessionReport,
  UserPrioritySignal,
  WakeRequestSource,
} from "./ports.js";
import type { SchedulerState, SchedulerStateRepository } from "./state.js";
import { isWindowOpen, nextWindowOpening } from "./windows.js";

/** Extension du ledger SQLite (S3) : périodes que la session peut traverser. */
export interface CoveringLedger {
  ensurePeriodsCovering(
    profileId: ProfileId,
    definition: BudgetPeriodDefinition,
    at: UtcTimestamp,
    maxDurationMs: number,
    limits: readonly PeriodLimit[],
  ): readonly BudgetPeriod[];
}

export interface SchedulerOptions {
  readonly profileId: ProfileId;
  readonly uow: UnitOfWork & { readonly ledger: UnitOfWork["ledger"] & CoveringLedger };
  readonly state: SchedulerStateRepository;
  readonly clock: SchedulerClock;
  readonly environment: LaunchEnvironment;
  readonly priority: UserPrioritySignal;
  readonly launcher: SessionLauncher;
  /** Réveils demandés par l'agent : échéances candidates seulement. */
  readonly wakeRequests?: WakeRequestSource;
  /** Verrou d'instance du profil, déjà acquis. */
  readonly lock: InstanceLock;
  readonly backoff?: BackoffPolicy;
  /** Réévaluation des conditions non temporelles et veille maximale entre deux tours. */
  readonly recheckIntervalMs?: number;
  /** Délai maximal d'un fait (adapter, sandbox, signal) avant de le tenir pour inconnu. */
  readonly factTimeoutMs?: number;
  readonly newId?: () => string;
  /** Attente entre deux tours de `run` ; injectable pour les tests. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type TickResult =
  | { readonly kind: "inactive"; readonly state: ProfileState; readonly detail: string }
  | { readonly kind: "sleeping"; readonly nextWakeAt: UtcTimestamp }
  | {
      readonly kind: "denied";
      readonly state: ProfileState;
      readonly decision: Extract<PolicyDecision, { verdict: "deny" }>;
      readonly nextWakeAt: UtcTimestamp | null;
    }
  | { readonly kind: "launched"; readonly ticket: LaunchTicket };

type Denial = Extract<PolicyDecision, { verdict: "deny" }>;

interface GatheredFacts {
  readonly adapter: LaunchFacts["adapter"];
  readonly sandboxOperational: boolean | undefined;
  readonly billing: BillingFacts | undefined;
  readonly quotaSnapshots: readonly ProviderQuotaSnapshot[] | undefined;
  readonly quotaPacing: readonly PacingEstimate[] | undefined;
  readonly userPriority: PrioritySignal | undefined;
}

interface BudgetFacts {
  readonly periods: readonly BudgetPeriod[];
  readonly availability: NonNullable<LaunchFacts["budget"]>;
  readonly limits: readonly PeriodLimit[];
}

/** Refus qui signalent une attente temporaire : hibernation plutôt que blocage. */
const TEMPORARY_DENIALS = new Set<Denial["reason"]>([
  "outside_window",
  "user_priority",
  "backoff_active",
  "budget_exhausted",
  "unknown_condition",
  "session_already_active",
  "paused",
]);

const DEFAULT_RECHECK_MS = 60_000;
const DEFAULT_FACT_TIMEOUT_MS = 5_000;
const MIN_WAKE_DELAY_MS = 1_000;

function iso(ms: number): UtcTimestamp {
  return new Date(ms).toISOString() as UtcTimestamp;
}

function parseTs(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Clé stable d'un refus : motif et code de détail, sans le contexte numérique variable. */
function denialKey(decision: Denial): string {
  return `${decision.reason}/${decision.detail.split(":")[0] ?? ""}`;
}

async function guarded<T>(
  read: (() => Promise<T>) | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  if (read === undefined) return undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Le plus contraint de plusieurs instantanés : un inconnu l'emporte sur tout. */
/** Réévaluation maximale d'un pilotage en attente (le réveil peut avancer). */
export const PACING_RECHECK_MS = 15 * 60_000;

/** Intervalle minimal entre sessions ; aucun quand la garde de quota pilote la voie. */
function minIntervalFor(revision: PolicyRevision): number {
  return revision.groups.budget.subscriptionQuota?.enabled === true
    ? 0
    : revision.groups.schedule.minIntervalBetweenSessionsMs;
}

/** Remise à zéro de la fenêtre nommée dans le détail du refus (`…: <fenêtre> used_bp=…`). */
function windowReset(
  snapshots: readonly ProviderQuotaSnapshot[] | undefined,
  detail: string,
): number | null {
  const key = /^[^:]+: (\S+)/.exec(detail)?.[1];
  const snapshot = snapshots?.find((q) => q.windowKey === key);
  return snapshot === undefined ? null : parseTs(snapshot.resetsAt);
}

function tightest(list: readonly BudgetAvailability[]): BudgetAvailability | undefined {
  let worst: BudgetAvailability | undefined;
  for (const item of list) {
    if (item.available === null) return item;
    if (worst?.available == null || item.available < worst.available) worst = item;
  }
  return worst;
}

export class Scheduler {
  readonly #o: SchedulerOptions;
  readonly #backoff: BackoffPolicy;
  readonly #recheckMs: number;
  readonly #factTimeoutMs: number;
  readonly #newId: () => string;
  /** Échéance monotone du backoff ou de l'intervalle minimal posée par ce processus. */
  #monotonicHold: number | null = null;
  #inFlight: Promise<void> | null = null;

  constructor(options: SchedulerOptions) {
    this.#o = options;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
    assertBackoffPolicy(this.#backoff);
    this.#recheckMs = options.recheckIntervalMs ?? DEFAULT_RECHECK_MS;
    this.#factTimeoutMs = options.factTimeoutMs ?? DEFAULT_FACT_TIMEOUT_MS;
    this.#newId = options.newId ?? randomUUID;
    if (!Number.isSafeInteger(this.#recheckMs) || this.#recheckMs < MIN_WAKE_DELAY_MS) {
      throw new RangeError(`intervalle de réévaluation invalide : ${String(this.#recheckMs)}`);
    }
  }

  /** Session lancée par ce processus et pas encore rapportée. */
  get sessionInFlight(): Promise<void> | null {
    return this.#inFlight;
  }

  /**
   * Après (re)démarrage : si une session est restée ouverte ou si le profil est resté
   * en `running`/`checkpointing`, la réconciliation est confiée au runner. Aucun
   * lancement n'a lieu tant qu'une session reste ouverte.
   */
  async recover(): Promise<boolean> {
    this.#o.lock.assertHeld();
    const { uow, profileId } = this.#o;
    const profile = this.#profile();
    const open = uow.sessions.listOpen(profileId);
    if (open.length === 0 && profile.state !== "running" && profile.state !== "checkpointing") {
      return false;
    }
    const at = iso(this.#o.clock.now());
    uow.journal.append(
      prepareJournalEvent({
        type: "orphan_reconciled",
        at,
        profileId,
        reason: "redémarrage du scheduler : sessions sans processus confirmé confiées au runner",
        metadata: {
          phase: "requested",
          state: profile.state,
          openSessions: open.map((s) => s.id),
        },
      }),
    );
    await this.#o.launcher.reconcileOrphans(profileId);
    return true;
  }

  /** Un tour d'évaluation. N'appelle aucun modèle ; lance au plus une session. */
  async tick(): Promise<TickResult> {
    this.#o.lock.assertHeld();
    const nowMs = this.#o.clock.now();
    const profile = this.#profile();
    if (this.#inFlight !== null) {
      return { kind: "inactive", state: profile.state, detail: "session.in_flight" };
    }
    if (profile.state !== "ready" && profile.state !== "hibernating") {
      return { kind: "inactive", state: profile.state, detail: `profile.state: ${profile.state}` };
    }
    const wake = parseTs(profile.nextWakeAt);
    if (profile.state === "hibernating" && wake !== null && wake > nowMs) {
      // Une demande de l'agent peut seulement avancer l'évaluation ; tout reste vérifié.
      const source = this.#o.wakeRequests;
      const requested =
        source === undefined
          ? undefined
          : await guarded(() => source.nextRequestedWake(nowMs), this.#factTimeoutMs);
      if (typeof requested !== "number" || !Number.isFinite(requested) || requested > nowMs) {
        const next =
          typeof requested === "number" && Number.isFinite(requested)
            ? Math.min(wake, Math.max(requested, nowMs))
            : wake;
        return { kind: "sleeping", nextWakeAt: iso(next) };
      }
    }

    const facts = await this.#gatherFacts();
    const result = this.#o.uow.transaction(() => this.#decide(this.#o.clock.now(), facts));
    if (result.kind === "launched") this.#startSession(result.ticket);
    return result;
  }

  /** Boucle du daemon : réévalue à l'échéance, au plus tard après `recheckIntervalMs`. */
  async run(signal: AbortSignal): Promise<void> {
    const sleep = this.#o.sleep ?? defaultSleep;
    await this.recover();
    while (!signal.aborted) {
      const result = await this.tick();
      await sleep(this.#delayAfter(result), signal);
    }
    if (this.#inFlight !== null) await this.#inFlight;
  }

  #delayAfter(result: TickResult): number {
    const now = this.#o.clock.now();
    const next =
      result.kind === "sleeping"
        ? parseTs(result.nextWakeAt)
        : result.kind === "denied"
          ? parseTs(result.nextWakeAt)
          : null;
    // Plafond : une veille du poste ou un réglage d'horloge est remarqué en un tour.
    if (next === null) return this.#recheckMs;
    return Math.min(Math.max(next - now, MIN_WAKE_DELAY_MS), this.#recheckMs);
  }

  #profile(): ProfileRecord {
    const profile = this.#o.uow.profiles.get(this.#o.profileId);
    if (profile === null) throw new Error(`scheduler : profil ${this.#o.profileId} inconnu`);
    return profile;
  }

  async #gatherFacts(): Promise<GatheredFacts> {
    const { environment, priority } = this.#o;
    const t = this.#factTimeoutMs;
    const [adapter, sandboxOperational, billing, quotaSnapshots, userPriority] = await Promise.all([
      guarded(() => environment.adapter(), t),
      guarded(() => environment.sandboxOperational(), t),
      guarded(() => environment.billing(), t),
      guarded(
        environment.quotaSnapshots === undefined
          ? undefined
          : () => environment.quotaSnapshots?.() ?? Promise.resolve(undefined),
        t,
      ),
      guarded(() => priority.read(), t),
    ]);
    const quotaPacing = await guarded(
      environment.pacingEstimates === undefined
        ? undefined
        : () => environment.pacingEstimates?.() ?? Promise.resolve(undefined),
      t,
    );
    return { adapter, sandboxOperational, billing, quotaSnapshots, quotaPacing, userPriority };
  }

  /** Corps transactionnel d'un tour : relit tout, décide, réserve ou consigne le refus. */
  #decide(nowMs: number, facts: GatheredFacts): TickResult {
    const { uow, profileId, state: stateRepo } = this.#o;
    this.#o.lock.assertHeld();
    const at = iso(nowMs);
    const profile = this.#profile();
    if (profile.state !== "ready" && profile.state !== "hibernating") {
      return { kind: "inactive", state: profile.state, detail: `profile.state: ${profile.state}` };
    }
    const resolution = resolvePolicy(uow.policies, profileId);
    const revision = resolution.status === "active" ? resolution.revision : null;
    const sched = stateRepo.get(profileId);
    const budget = revision === null ? undefined : this.#budget(revision, at, facts.billing);

    const launchFacts: LaunchFacts = {
      // `hibernating → ready` exige les contrôles : on évalue le profil comme s'il était
      // prêt, et la transition n'a lieu que si tout est accordé.
      profile: { state: "ready", emergencyStopLocked: profile.emergencyStopLocked },
      now: at,
      ...(facts.adapter === undefined ? {} : { adapter: facts.adapter }),
      ...(facts.billing === undefined ? {} : { billing: facts.billing }),
      ...(facts.quotaSnapshots === undefined ? {} : { quotaSnapshots: facts.quotaSnapshots }),
      ...(facts.quotaPacing === undefined ? {} : { quotaPacing: facts.quotaPacing }),
      ...(facts.sandboxOperational === undefined
        ? {}
        : { sandboxOperational: facts.sandboxOperational }),
      ...(facts.userPriority === undefined ? {} : { userPriority: facts.userPriority }),
      ...this.#windowFact(revision, nowMs),
      ...this.#backoffFact(sched, revision, nowMs),
      openSessionCount: uow.sessions.listOpen(profileId).length,
      ...(budget === undefined ? {} : { budget: budget.availability }),
    };
    const decision = decideLaunch(uow.policies, profileId, launchFacts);
    if (decision.verdict === "deny" || revision === null || budget === undefined) {
      const denial: Denial =
        decision.verdict === "deny"
          ? decision
          : {
              verdict: "deny",
              revisionId: decision.revisionId,
              reason: "unknown_condition",
              detail: "scheduler.inconsistent_facts",
            };
      return this.#deny(profile, sched, denial, revision, budget, nowMs, facts);
    }

    const sessionId = this.#newId() as SessionId;
    const reservationId = this.#newId() as ReservationId;
    const maxima = this.#maxima(revision, facts.billing);
    const reserved = uow.ledger.reserve({
      id: reservationId,
      sessionId,
      profileId,
      periodIds: budget.periods.map((p) => p.id),
      maxima,
      at,
    });
    if (reserved.status === "denied") {
      const denial: Denial = {
        verdict: "deny",
        revisionId: revision.id,
        reason: reserved.reason,
        detail: `ledger.${reserved.reason}: ${reserved.detail}`,
      };
      return this.#deny(profile, sched, denial, revision, budget, nowMs, facts);
    }
    return this.#launch(profile, sched, revision, sessionId, reservationId, maxima, at);
  }

  #windowFact(revision: PolicyRevision | null, nowMs: number): { windowOpen?: boolean } {
    if (revision === null) return {};
    const { weeklyWindows, timeZone } = revision.groups.schedule;
    try {
      return { windowOpen: isWindowOpen(weeklyWindows, timeZone, nowMs) };
    } catch {
      return {};
    }
  }

  /** Fin d'attente : backoff persisté et intervalle minimal depuis la dernière session. */
  #holdUntil(sched: SchedulerState, revision: PolicyRevision | null): number | null | undefined {
    const backoff = parseTs(sched.backoffUntil);
    const ended = parseTs(sched.lastSessionEndedAt);
    if (
      (sched.backoffUntil !== null && backoff === null) ||
      (sched.lastSessionEndedAt !== null && ended === null)
    ) {
      return undefined;
    }
    // Pilotage du quota : sessions enchaînées sans délai minimal jusqu'à la cible.
    const interval = ended === null || revision === null ? null : ended + minIntervalFor(revision);
    if (backoff === null) return interval;
    return interval === null ? backoff : Math.max(backoff, interval);
  }

  #backoffFact(
    sched: SchedulerState,
    revision: PolicyRevision | null,
    nowMs: number,
  ): { backoffExpired?: boolean } {
    const until = this.#holdUntil(sched, revision);
    if (until === undefined) return {};
    const wallOk = until === null || nowMs >= until;
    const monoOk = this.#monotonicHold === null || this.#o.clock.monotonic() >= this.#monotonicHold;
    return { backoffExpired: wallOk && monoOk };
  }

  #limits(revision: PolicyRevision, billing: BillingFacts | undefined): readonly PeriodLimit[] {
    const b = revision.groups.budget;
    const limits: PeriodLimit[] = [
      { unit: "tokens", cap: b.tokensPerPeriod, userReserve: b.userReserveTokens },
      { unit: "sessions", cap: b.sessionsPerPeriod, userReserve: 0 },
    ];
    if (b.paidApi.authorized && billing?.kind === "paid_api") {
      limits.push({
        unit: "money",
        cap: b.paidApi.perPeriodCapMinor,
        userReserve: 0,
        currency: b.paidApi.currency,
      });
    }
    return limits;
  }

  #maxima(revision: PolicyRevision, billing: BillingFacts | undefined): readonly BudgetQuantity[] {
    // Voie abonnement : la garde de quota borne la session (ADR-005), aucune enveloppe de
    // tokens propre à Wake n'est réservée ; les points de base ne deviennent pas des tokens.
    const maxima: BudgetQuantity[] =
      billing?.kind === "subscription_quota"
        ? [{ unit: "sessions", amount: 1 }]
        : [
            { unit: "tokens", amount: revision.groups.budget.tokensPerSession },
            { unit: "sessions", amount: 1 },
          ];
    if (billing?.kind === "paid_api" && billing.maxSessionCostMinor !== null) {
      maxima.push({
        unit: "money",
        amountMinor: billing.maxSessionCostMinor,
        currency: billing.currency,
      });
    }
    return maxima;
  }

  /**
   * Périodes couvrant la durée maximale de session et disponibilités les plus
   * contraintes. Toute erreur du ledger laisse le budget inconnu.
   */
  #budget(
    revision: PolicyRevision,
    at: UtcTimestamp,
    billing: BillingFacts | undefined,
  ): BudgetFacts | undefined {
    const { uow, profileId } = this.#o;
    const limits = this.#limits(revision, billing);
    try {
      const periods = uow.ledger.ensurePeriodsCovering(
        profileId,
        revision.groups.budget.period,
        at,
        revision.groups.schedule.maxSessionDurationMs,
        limits,
      );
      const of = (unit: "tokens" | "sessions" | "money"): BudgetAvailability | undefined =>
        tightest(periods.map((p) => uow.ledger.availability(p.id, unit)));
      const money = limits.some((l) => l.unit === "money") ? of("money") : undefined;
      const tokens = of("tokens");
      const sessions = of("sessions");
      return {
        periods,
        limits,
        availability: {
          ...(tokens === undefined ? {} : { tokens }),
          ...(sessions === undefined ? {} : { sessions }),
          ...(money === undefined ? {} : { money }),
        },
      };
    } catch {
      return undefined;
    }
  }

  /** Prochain instant où les conditions temporelles peuvent redevenir favorables. */
  #nextWake(
    decision: Denial,
    sched: SchedulerState,
    revision: PolicyRevision | null,
    budget: BudgetFacts | undefined,
    nowMs: number,
    facts: Pick<GatheredFacts, "quotaSnapshots" | "quotaPacing"> | undefined,
  ): number {
    const recheck = nowMs + this.#recheckMs;
    if (revision === null) return recheck;
    let candidate: number | null;
    const guard = revision.groups.budget.subscriptionQuota;
    const quota = decision.detail.startsWith("subscription.");
    switch (decision.reason) {
      case "outside_window":
        // Remise à zéro trop lointaine : réveil quand la plus lointaine entre dans le délai.
        candidate = nowMs;
        if (quota && guard?.enabled === true) {
          // Pilotage : réveil à l'heure calculée, réévalué au plus tard après
          // `PACING_RECHECK_MS` (débit, interruption, usage humain changent la projection).
          const plan = planPacing(guard, facts?.quotaSnapshots ?? [], nowMs, facts?.quotaPacing);
          candidate = plan === null ? null : Math.min(plan.wakeAtMs, nowMs + PACING_RECHECK_MS);
        }
        break;
      case "backoff_active":
        candidate = this.#holdUntil(sched, revision) ?? null;
        break;
      case "budget_exhausted":
        // Seuil de départ atteint : rien avant la remise à zéro de la fenêtre.
        candidate = quota
          ? windowReset(facts?.quotaSnapshots, decision.detail)
          : budget === undefined
            ? null
            : parseTs(budget.periods[0]?.endsAt ?? null);
        break;
      default:
        return recheck;
    }
    if (candidate === null) return recheck;
    const { weeklyWindows, timeZone } = revision.groups.schedule;
    try {
      const opening = nextWindowOpening(weeklyWindows, timeZone, Math.max(candidate, nowMs));
      return Math.max(opening ?? recheck, nowMs + MIN_WAKE_DELAY_MS);
    } catch {
      return recheck;
    }
  }

  #deny(
    profile: ProfileRecord,
    sched: SchedulerState,
    decision: Denial,
    revision: PolicyRevision | null,
    budget: BudgetFacts | undefined,
    nowMs: number,
    facts?: Pick<GatheredFacts, "quotaSnapshots" | "quotaPacing">,
  ): TickResult {
    const { uow, profileId, state: stateRepo } = this.#o;
    const at = iso(nowMs);
    const key = denialKey(decision);
    const reason = `${decision.reason}: ${decision.detail}`;
    const target: ProfileState =
      decision.reason === "stopped"
        ? "stopped"
        : TEMPORARY_DENIALS.has(decision.reason)
          ? "hibernating"
          : "blocked";

    let state = profile.state;
    if (profile.state === "ready" || (target === "stopped" && profile.state === "hibernating")) {
      transitionProfile(uow, {
        profileId,
        from: profile.state,
        to: target,
        reason,
        at,
        metadata: { by: "scheduler", denyReason: decision.reason },
      });
      state = target;
    }
    if (state !== profile.state || key !== sched.lastDenial) {
      uow.journal.append(
        prepareJournalEvent(
          decisionJournalEvent(decision, { profileId, at, action: { kind: "launch_session" } }),
        ),
      );
    }
    const nextWakeAt =
      state === "hibernating"
        ? iso(this.#nextWake(decision, sched, revision, budget, nowMs, facts))
        : null;
    uow.profiles.setNextWake(profileId, nextWakeAt);
    stateRepo.save({ ...sched, lastDenial: key }, at);
    return { kind: "denied", state, decision, nextWakeAt };
  }

  #launch(
    profile: ProfileRecord,
    sched: SchedulerState,
    revision: PolicyRevision,
    sessionId: SessionId,
    reservationId: ReservationId,
    maxima: readonly BudgetQuantity[],
    at: UtcTimestamp,
  ): TickResult {
    const { uow, profileId, state: stateRepo } = this.#o;
    const maxDurationMs = revision.groups.schedule.maxSessionDurationMs;
    uow.sessions.create({
      id: sessionId,
      profileId,
      experimentId: uow.experiments.getActive(profileId)?.id ?? null,
      adapterId: revision.groups.runtime.adapterId,
      policyRevisionId: revision.id,
      reservationId,
      startedAt: at,
      endedAt: null,
      outcome: null,
      outcomeReason: null,
    });
    uow.journal.append(
      prepareJournalEvent({
        type: "budget_reserved",
        at,
        profileId,
        sessionId,
        policyRevisionId: revision.id,
        reason: "enveloppe de session réservée avant lancement",
        metadata: {
          reservationId,
          maxima: maxima.map((q) =>
            q.unit === "money"
              ? { unit: q.unit, amountMinor: q.amountMinor, currency: q.currency }
              : { unit: q.unit, amount: q.amount },
          ),
        },
      }),
    );
    if (profile.state === "hibernating") {
      transitionProfile(uow, {
        profileId,
        from: "hibernating",
        to: "ready",
        reason: "conditions de réveil revérifiées",
        at,
        metadata: { by: "scheduler" },
      });
    }
    transitionProfile(uow, {
      profileId,
      from: "ready",
      to: "running",
      reason: "launch.allowed",
      at,
      sessionId,
      metadata: { by: "scheduler", reservationId },
    });
    uow.profiles.setNextWake(profileId, null);
    stateRepo.save({ ...sched, lastDenial: null }, at);
    return {
      kind: "launched",
      ticket: {
        profileId,
        sessionId,
        reservationId,
        policyRevisionId: revision.id,
        maxima,
        launchedAt: at,
        deadline: iso(Date.parse(at) + maxDurationMs),
        maxDurationMs,
      },
    };
  }

  #startSession(ticket: LaunchTicket): void {
    let launched: Promise<SessionReport>;
    try {
      launched = this.#o.launcher.launch(ticket);
    } catch (error) {
      launched = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.#inFlight = launched
      .then(
        (report) => {
          this.#settleSafely(ticket, report);
        },
        () => {
          this.#settleSafely(ticket, null);
        },
      )
      .finally(() => {
        this.#inFlight = null;
      });
  }

  /** Une erreur de clôture ne doit pas tuer le daemon : elle est journalisée. */
  #settleSafely(ticket: LaunchTicket, report: SessionReport | null): void {
    try {
      this.#settle(ticket, report);
    } catch (error) {
      try {
        this.#o.uow.journal.append(
          prepareJournalEvent({
            type: "error",
            at: iso(this.#o.clock.now()),
            profileId: this.#o.profileId,
            sessionId: ticket.sessionId,
            reason: "scheduler : clôture de session non enregistrée",
            metadata: { by: "scheduler", error: error instanceof Error ? error.name : "unknown" },
          }),
        );
      } catch {
        // Base indisponible : le prochain démarrage passera par `recover`.
      }
    }
  }

  /**
   * Fin de session : met à jour le backoff et choisit l'état de sortie quand le runner
   * a laissé le profil en `checkpointing`. `report === null` : lanceur en échec, état
   * incertain.
   */
  #settle(ticket: LaunchTicket, report: SessionReport | null): void {
    const { uow, profileId, state: stateRepo, clock } = this.#o;
    const nowMs = clock.now();
    const at = iso(nowMs);
    uow.transaction(() => {
      const profile = this.#profile();
      const sched = stateRepo.get(profileId);
      const failure: SessionFailure | undefined =
        report === null
          ? { kind: "transient", detail: "launcher.rejected" }
          : (report.failure ??
            (report.outcome === "failed" || report.outcome === "orphaned"
              ? { kind: "transient", detail: `outcome.${report.outcome}` }
              : undefined));

      let next: SchedulerState = { ...sched, lastSessionEndedAt: at, lastDenial: null };
      let target: "hibernating" | "blocked" = "hibernating";
      let reason = `session.${report?.outcome ?? "unknown"}`;
      let holdMs = 0;
      if (failure === undefined) {
        next = { ...next, consecutiveFailures: 0, backoffUntil: null };
      } else {
        const decision = decideAfterFailure(this.#backoff, sched.consecutiveFailures, failure);
        reason = decision.detail;
        if (failure.kind === "rate_limited") {
          uow.journal.append(
            prepareJournalEvent({
              type: "rate_limited",
              at,
              profileId,
              sessionId: ticket.sessionId,
              reason: decision.detail,
              metadata: {
                retryAfterMs: failure.retryAfterMs,
                consecutiveFailures: decision.consecutiveFailures,
              },
            }),
          );
        }
        if (decision.action === "wait") {
          holdMs = decision.delayMs;
          next = {
            ...next,
            consecutiveFailures: decision.consecutiveFailures,
            backoffUntil: iso(nowMs + decision.delayMs),
          };
        } else {
          target = "blocked";
          next = { ...next, consecutiveFailures: decision.consecutiveFailures, backoffUntil: null };
        }
      }
      const revision = resolvePolicy(uow.policies, profileId);
      const interval = revision.status === "active" ? minIntervalFor(revision.revision) : 0;
      this.#monotonicHold = clock.monotonic() + Math.max(holdMs, interval);

      if (report === null && profile.state === "running") {
        transitionProfile(uow, {
          profileId,
          from: "running",
          to: "blocked",
          reason: "état incertain : lanceur en échec, session laissée à la réconciliation",
          at,
          sessionId: ticket.sessionId,
          metadata: { by: "scheduler" },
        });
      } else if (profile.state === "checkpointing") {
        transitionProfile(uow, {
          profileId,
          from: "checkpointing",
          to: target,
          reason,
          at,
          sessionId: ticket.sessionId,
          metadata: { by: "scheduler" },
        });
      } else if (profile.state === "running") {
        transitionProfile(uow, {
          profileId,
          from: "running",
          to: "blocked",
          reason: "runner.contract: profil laissé en running après la fin de session",
          at,
          sessionId: ticket.sessionId,
          metadata: { by: "scheduler" },
        });
      } else if (target === "blocked" && profile.state === "hibernating") {
        // `hibernating → blocked` n'existe pas : le blocage requis reste visible, et le
        // backoff le plus long empêche tout relancement automatique.
        uow.journal.append(
          prepareJournalEvent({
            type: "error",
            at,
            profileId,
            sessionId: ticket.sessionId,
            reason: `blocage requis (${reason}) mais profil déjà en hibernating`,
            metadata: { by: "scheduler" },
          }),
        );
        next = { ...next, backoffUntil: iso(nowMs + this.#backoff.maxDelayMs) };
      }
      const after = this.#profile();
      if (after.state === "hibernating") {
        const hold = this.#holdUntil(next, revision.status === "active" ? revision.revision : null);
        uow.profiles.setNextWake(profileId, iso(Math.max(hold ?? nowMs, nowMs)));
      }
      stateRepo.save(next, at);
    });
  }
}
