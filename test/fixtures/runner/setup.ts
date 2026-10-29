/**
 * Banc du runner : base SQLite réelle, profil activé sur une policy consentie, période
 * et réservation du ledger, décision `decideLaunch` réelle, adapter factice et vrais
 * processus enfants. Partagé par les tests et par le daemon enfant (`daemon-child.ts`).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAdapter, type FakeScenario } from "../../../src/adapters/fake/index.js";
import type {
  AdapterId,
  AgentId,
  BudgetGroup,
  ConsentId,
  FilesAndToolsGroup,
  IanaTimeZone,
  PolicyDecision,
  PolicyGroups,
  PolicyRevisionId,
  ProfileId,
  ReservationId,
  SessionId,
  UnitOfWork,
  UtcTimestamp,
} from "../../../src/contracts/index.js";
import { POLICY_SCHEMA_VERSION } from "../../../src/contracts/index.js";
import { decideLaunch, type SessionChecks } from "../../../src/policy/index.js";
import {
  ProcessTreeSupervisor,
  SessionRunner,
  StopFlag,
  type LaunchGrant,
  type RunnerOptions,
} from "../../../src/runner/index.js";
import { openStore, type Store } from "../../../src/store/index.js";

export const PROFILE = "default" as ProfileId;
export const REVISION = "rev-runner-1" as PolicyRevisionId;
const PARIS = "Europe/Paris" as IanaTimeZone;

/** Lanceur compilé une fois pour toute la suite, hors des dossiers de test supprimés. */
export const SHARED_RUNTIME_DIR = join(tmpdir(), "mind-wake-test-runtime");

export interface PolicyOverrides {
  readonly budget?: Partial<BudgetGroup>;
  readonly filesAndTools?: Partial<FilesAndToolsGroup>;
  readonly maxSessionDurationMs?: number;
}

export function policyGroups(overrides: PolicyOverrides = {}): PolicyGroups {
  return {
    identity: { profileId: PROFILE, agentId: "default" as AgentId },
    runtime: { adapterId: "fake" as AdapterId, provider: "none", model: "none", authMode: "none" },
    schedule: {
      timeZone: PARIS,
      weeklyWindows: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
        day: day as 0 | 1 | 2 | 3 | 4 | 5 | 6,
        start: "00:00",
        end: "24:00",
      })),
      minIntervalBetweenSessionsMs: 0,
      maxSessionDurationMs: overrides.maxSessionDurationMs ?? 120_000,
    },
    humanPriority: {
      activitySignal: "idle",
      idleThresholdMs: 60_000,
      maxSignalAgeMs: 60_000,
      maxInterruptLatencyMs: 1_000,
      maxTerminationLatencyMs: 1_000,
    },
    budget: {
      period: { kind: "day", timeZone: PARIS },
      tokensPerSession: 3_000,
      tokensPerPeriod: 10_000,
      sessionsPerPeriod: 5,
      userReserveTokens: 2_000,
      checkpointTokens: 100,
      paidApi: { authorized: false },
      ...overrides.budget,
    },
    filesAndTools: {
      readRoots: ["notes"],
      writeRoots: ["notes"],
      allowedExecutables: [],
      maxProcesses: 16,
      maxStorageBytes: 1_000_000,
      ...overrides.filesAndTools,
    },
    network: { explorationDestinations: [], providerTransportDestinations: [] },
    data: {
      eventRetentionDays: 30,
      localStorageCapBytes: 1_000_000,
      purge: "manual",
      exportPaths: [],
    },
  };
}

function utcNow(): UtcTimestamp {
  return new Date().toISOString() as UtcTimestamp;
}

/** Profil `ready` sur une révision consentie. */
export function prepareProfile(uow: UnitOfWork, overrides: PolicyOverrides = {}): void {
  const at = utcNow();
  uow.profiles.create({
    id: PROFILE,
    agentId: "default" as AgentId,
    state: "disabled",
    activePolicyRevisionId: null,
    nextWakeAt: null,
    emergencyStopLocked: false,
    stateReason: "créé par le banc",
    updatedAt: at,
  });
  uow.policies.appendRevision({
    schemaVersion: POLICY_SCHEMA_VERSION,
    id: REVISION,
    profileId: PROFILE,
    previousRevisionId: null,
    createdAt: at,
    groups: policyGroups(overrides),
  });
  uow.policies.recordConsent({
    id: "consent-runner-1" as ConsentId,
    revisionId: REVISION,
    grantedAt: at,
    channel: "local_cli",
    proof: "banc de test",
  });
  uow.profiles.transition(PROFILE, {
    from: "disabled",
    to: "ready",
    reason: "activation (banc)",
    at,
  });
  uow.profiles.setNextWake(PROFILE, utcNow());
}

export function favorableChecks(): Omit<SessionChecks, "now"> {
  return {
    userPriority: { favorable: true, observedAt: utcNow() },
    sandboxOperational: true,
    onSubscription: false,
  };
}

let counter = 0;

/**
 * Ce que ferait le scheduler : `decideLaunch` sur les faits courants, puis réservation
 * atomique de l'enveloppe de session. Renvoie l'autorisation transmise au runner.
 */
export async function grantLaunch(
  uow: UnitOfWork,
  runner: SessionRunner,
  maxTokens = 3_000,
): Promise<LaunchGrant> {
  counter += 1;
  const sessionId =
    `session-${String(process.pid)}-${String(Date.now())}-${String(counter)}` as SessionId;
  const reservationId = `reservation-${sessionId}` as ReservationId;
  const at = utcNow();
  const revision = uow.policies.getRevision(REVISION);
  if (revision === null) throw new Error("révision absente");
  const period = uow.ledger.ensurePeriod(PROFILE, revision.groups.budget.period, at, [
    { unit: "tokens", cap: 10_000, userReserve: 2_000 },
    { unit: "sessions", cap: 5, userReserve: 0 },
  ]);
  const profile = uow.profiles.get(PROFILE);
  if (profile === null) throw new Error("profil absent");
  const decision = decideLaunch(uow.policies, PROFILE, {
    profile: { state: profile.state, emergencyStopLocked: profile.emergencyStopLocked },
    adapter: {
      probe: await runner.adapter.probe(),
      capabilities: await runner.adapter.capabilities(),
      runtime: revision.groups.runtime,
    },
    now: at,
    billing: { kind: "no_charge" },
    sandboxOperational: true,
    windowOpen: true,
    userPriority: { favorable: true, observedAt: at },
    backoffExpired: true,
    openSessionCount: uow.sessions.listOpen(PROFILE).length,
    budget: {
      tokens: uow.ledger.availability(period.id, "tokens"),
      sessions: uow.ledger.availability(period.id, "sessions"),
    },
  });
  if (decision.verdict === "allow") {
    const reserved = uow.ledger.reserve({
      id: reservationId,
      sessionId,
      profileId: PROFILE,
      periodIds: [period.id],
      maxima: [
        { unit: "tokens", amount: maxTokens },
        { unit: "sessions", amount: 1 },
      ],
      at,
    });
    if (reserved.status !== "reserved") throw new Error(`réservation refusée : ${reserved.detail}`);
  }
  return {
    profileId: PROFILE,
    sessionId,
    experimentId: null,
    reservationId,
    decision,
    context: "contexte borné de test",
    maxInputTokens: 1_000,
  };
}

export function allowDecision(): PolicyDecision {
  return { verdict: "allow", revisionId: REVISION, reason: "launch.allowed" };
}

export interface Bench {
  readonly dir: string;
  readonly store: Store;
  readonly uow: UnitOfWork;
  readonly stopFlag: StopFlag;
  readonly supervisor: ProcessTreeSupervisor;
  runner(scenario: FakeScenario, options?: Partial<RunnerOptions>, uow?: UnitOfWork): SessionRunner;
  close(): void;
}

export function openBench(dir: string, init?: PolicyOverrides): Bench {
  const store = openStore(join(dir, "control.sqlite"));
  if (init !== undefined) prepareProfile(store.uow, init);
  const stopFlag = new StopFlag(dir);
  const supervisor = new ProcessTreeSupervisor(SHARED_RUNTIME_DIR);
  return {
    dir,
    store,
    uow: store.uow,
    stopFlag,
    supervisor,
    runner: (scenario, options, uow) =>
      new SessionRunner({
        uow: uow ?? store.uow,
        profileId: PROFILE,
        supervisor,
        stopFlag,
        adapter: (host) => new FakeAdapter({ host, scenario }),
        liveChecks: favorableChecks,
        ...(options === undefined ? {} : { options }),
      }),
    close: () => {
      store.close();
    },
  };
}

export function tempDir(): { path: string; remove(): void } {
  const path = mkdtempSync(join(tmpdir(), "mind-wake-runner-"));
  return {
    path,
    remove: () => {
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

export function readPids(file: string): number[] {
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => /^\d+$/.test(line))
      .map(Number);
  } catch {
    return [];
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(
  condition: () => boolean,
  timeoutMs = 10_000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition non atteinte dans le délai");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
