/** Banc du scheduler (S6) : store SQLite réel, faits et lanceur factices, horloge simulée. */

import type {
  AdapterCapabilities,
  ConsentId,
  HumanPriorityGroup,
  PolicyGroups,
  PolicyRevisionId,
  ProbeResult,
  ProfileState,
  ProviderQuotaSnapshot,
  ScheduleGroup,
  UnitOfWork,
  UtcTimestamp,
  WeeklyWindow,
} from "../../../src/contracts/index.js";
import { POLICY_SCHEMA_VERSION } from "../../../src/contracts/index.js";
import type { BillingFacts, LaunchFacts, PacingEstimate } from "../../../src/policy/index.js";
import {
  FakeClock,
  ManualPrioritySignal,
  Scheduler,
  SqliteSchedulerStateRepository,
  acquireInstanceLock,
  transitionProfile,
  type BackoffPolicy,
  type InstanceLock,
  type LaunchEnvironment,
  type LaunchTicket,
  type SchedulerOptions,
  type SessionLauncher,
  type SessionReport,
} from "../../../src/scheduler/index.js";
import type { Store } from "../../../src/store/index.js";
import { PROFILE, policyGroups } from "../store-ledger/setup.js";

export { PROFILE };

/** Jeudi 29 octobre 2026, 10:00 à Paris (UTC+1 depuis le 25 octobre). */
export const THURSDAY_10H_PARIS = Date.parse("2026-10-29T09:00:00.000Z");

export const EVERY_DAY_9_TO_17: readonly WeeklyWindow[] = ([0, 1, 2, 3, 4, 5, 6] as const).map(
  (day) => ({ day, start: "09:00", end: "17:00" }),
);

export function iso(ms: number): UtcTimestamp {
  return new Date(ms).toISOString() as UtcTimestamp;
}

export interface SeedOptions {
  readonly state?: ProfileState;
  readonly emergencyStopLocked?: boolean;
  readonly schedule?: Partial<ScheduleGroup>;
  readonly humanPriority?: Partial<HumanPriorityGroup>;
  readonly budget?: Partial<PolicyGroups["budget"]>;
  readonly consented?: boolean;
}

/** Groupes de policy du banc : fenêtres quotidiennes, aucune dépense. */
export function schedulerPolicy(options: SeedOptions = {}): PolicyGroups {
  const base = policyGroups({
    tokensPerSession: 3_000,
    tokensPerPeriod: 10_000,
    sessionsPerPeriod: 3,
    userReserveTokens: 2_000,
    paidApi: { authorized: false },
    ...options.budget,
  });
  return {
    ...base,
    schedule: {
      ...base.schedule,
      weeklyWindows: EVERY_DAY_9_TO_17,
      minIntervalBetweenSessionsMs: 0,
      ...options.schedule,
    },
    humanPriority: { ...base.humanPriority, maxSignalAgeMs: 10_000, ...options.humanPriority },
  };
}

/** Profil activé (comme après `disabled → ready` par la CLI) et révision consentie. */
export function seedProfile(uow: UnitOfWork, options: SeedOptions = {}): PolicyRevisionId {
  const revisionId = "rev-1" as PolicyRevisionId;
  uow.transaction((tx) => {
    tx.profiles.create({
      id: PROFILE,
      agentId: "agent-1" as PolicyGroups["identity"]["agentId"],
      state: options.state ?? "ready",
      activePolicyRevisionId: null,
      nextWakeAt: null,
      emergencyStopLocked: options.emergencyStopLocked ?? false,
      stateReason: "banc",
      updatedAt: iso(THURSDAY_10H_PARIS - 3_600_000),
    });
    tx.policies.appendRevision({
      schemaVersion: POLICY_SCHEMA_VERSION,
      id: revisionId,
      profileId: PROFILE,
      previousRevisionId: null,
      createdAt: iso(THURSDAY_10H_PARIS - 3_600_000),
      groups: schedulerPolicy(options),
    });
    if (options.consented !== false) {
      tx.policies.recordConsent({
        id: "consent-rev-1" as ConsentId,
        revisionId,
        grantedAt: iso(THURSDAY_10H_PARIS - 3_600_000),
        channel: "local_cli",
        proof: "test",
      });
    }
  });
  return revisionId;
}

export const FAKE_PROBE: ProbeResult = {
  adapterId: "fake" as ProbeResult["adapterId"],
  version: "0.0.0",
  executionMechanism: "simulated",
  available: true,
  simulated: true,
};

export const FAKE_CAPABILITIES: AdapterCapabilities = {
  tokenCounting: "exact",
  countedCategories: ["input", "output"],
  tokenCapEnforcement: "native",
  providerQuotaReading: "none",
  cancellation: "graceful",
  residualUsageBound: null,
  isolationCompatible: true,
  userPrioritySignal: true,
  resumeModes: ["fresh_process_from_memory"],
};

/** Environnement de lancement factice ; chaque fait peut être rendu absent ou en erreur. */
export class FakeEnvironment implements LaunchEnvironment {
  adapterFacts: LaunchFacts["adapter"] | "error" | "hang" = {
    probe: FAKE_PROBE,
    capabilities: FAKE_CAPABILITIES,
    runtime: schedulerPolicy().runtime,
  };
  sandbox: boolean | undefined = true;
  billingFacts: BillingFacts | undefined = { kind: "no_charge" };
  /** Lectures de jauge rendues par `quotaSnapshots` ; `undefined` = aucune lecture. */
  quota: (() => readonly ProviderQuotaSnapshot[] | undefined) | undefined;
  /** Estimations du pilotage (débit mesuré, marge) rendues par `pacingEstimates`. */
  estimates: readonly PacingEstimate[] | undefined;
  calls = 0;

  adapter(): Promise<LaunchFacts["adapter"]> {
    this.calls++;
    if (this.adapterFacts === "error") return Promise.reject(new Error("probe en échec"));
    if (this.adapterFacts === "hang") return new Promise(() => undefined);
    return Promise.resolve(this.adapterFacts);
  }

  sandboxOperational(): Promise<boolean | undefined> {
    return Promise.resolve(this.sandbox);
  }

  billing(): Promise<BillingFacts | undefined> {
    return Promise.resolve(this.billingFacts);
  }

  quotaSnapshots(): Promise<readonly ProviderQuotaSnapshot[] | undefined> {
    return Promise.resolve(this.quota?.());
  }

  pacingEstimates(): Promise<readonly PacingEstimate[] | undefined> {
    return Promise.resolve(this.estimates);
  }
}

interface Pending {
  readonly ticket: LaunchTicket;
  resolve(report: SessionReport): void;
  reject(error: Error): void;
}

/**
 * Lanceur factice tenant le rôle du runner (S7) : il ne lance rien et laisse le test
 * décider de la fin de session.
 */
export class FakeLauncher implements SessionLauncher {
  readonly pending: Pending[] = [];
  readonly tickets: LaunchTicket[] = [];
  reconcileCalls = 0;
  onReconcile: (() => void) | undefined;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: FakeClock,
  ) {}

  launch(ticket: LaunchTicket): Promise<SessionReport> {
    this.tickets.push(ticket);
    return new Promise((resolve, reject) => {
      this.pending.push({ ticket, resolve, reject });
    });
  }

  reconcileOrphans(): Promise<void> {
    this.reconcileCalls++;
    this.onReconcile?.();
    return Promise.resolve();
  }

  /**
   * Fin de session comme le ferait le runner : `running → checkpointing` (ou l'état
   * demandé), session close, réservation rapprochée en usage simulé.
   */
  finish(
    report: Omit<SessionReport, "sessionId">,
    leaveIn: ProfileState = "checkpointing",
  ): Pending {
    const pending = this.pending.shift();
    if (pending === undefined) throw new Error("aucune session en cours");
    const at = iso(this.clock.now());
    const { ticket } = pending;
    this.uow.transaction((tx) => {
      if (leaveIn !== "running") {
        transitionProfile(tx, {
          profileId: ticket.profileId,
          from: "running",
          to: leaveIn,
          reason: "fin de session (banc)",
          at,
          sessionId: ticket.sessionId,
        });
      }
      tx.sessions.close(ticket.sessionId, report.outcome, "banc", at);
      tx.ledger.reconcile(
        ticket.reservationId,
        ticket.maxima.map((quantity) => ({
          reservationId: ticket.reservationId,
          quantity: quantity.unit === "tokens" ? { unit: "tokens", amount: 100 } : quantity,
          provenance: "simulated",
          recordedAt: at,
        })),
        at,
      );
    });
    pending.resolve({ ...report, sessionId: ticket.sessionId });
    return pending;
  }
}

export interface Bench {
  readonly store: Store;
  readonly clock: FakeClock;
  readonly environment: FakeEnvironment;
  readonly priority: ManualPrioritySignal;
  readonly launcher: FakeLauncher;
  readonly lock: InstanceLock;
  readonly scheduler: Scheduler;
  /** Signal de priorité favorable observé maintenant. */
  freshPriority(): void;
  /** Événements du journal du profil, filtrés par type. */
  events(type?: string): readonly { type: string; reason: string; metadata: unknown }[];
  close(): void;
}

export function bench(
  store: Store,
  lockPath: string,
  options: {
    readonly clock?: FakeClock;
    readonly backoff?: BackoffPolicy;
    /** Préfixe des identifiants générés : distinct pour deux schedulers sur une base. */
    readonly idPrefix?: string;
    readonly overrides?: Partial<SchedulerOptions>;
  } = {},
): Bench {
  const clock = options.clock ?? new FakeClock(THURSDAY_10H_PARIS);
  const environment = new FakeEnvironment();
  const priority = new ManualPrioritySignal();
  const launcher = new FakeLauncher(store.uow, clock);
  const lock = acquireInstanceLock(lockPath);
  let n = 0;
  const scheduler = new Scheduler({
    profileId: PROFILE,
    uow: store.uow,
    state: new SqliteSchedulerStateRepository(store.db),
    clock,
    environment,
    priority,
    launcher,
    lock,
    recheckIntervalMs: 60_000,
    factTimeoutMs: 50,
    newId: () => `${options.idPrefix ?? "s"}-${String(++n)}`,
    ...(options.backoff === undefined ? {} : { backoff: options.backoff }),
    ...options.overrides,
  });
  return {
    store,
    clock,
    environment,
    priority,
    launcher,
    lock,
    scheduler,
    freshPriority: () => {
      priority.set(true, clock.now());
    },
    events: (type?: string) =>
      store.uow.journal
        .list(PROFILE)
        .filter((e) => type === undefined || e.type === type)
        .map((e) => ({ type: e.type, reason: e.reason, metadata: e.metadata })),
    close: () => {
      lock.release();
    },
  };
}
