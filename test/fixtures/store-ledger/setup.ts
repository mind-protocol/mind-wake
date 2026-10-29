/** Données de test partagées par les tests du store et du ledger. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdapterId,
  AgentId,
  BudgetGroup,
  BudgetPeriodDefinition,
  ConsentId,
  IanaTimeZone,
  PeriodLimit,
  PolicyGroups,
  PolicyRevisionId,
  ProfileId,
  UnitOfWork,
  UtcTimestamp,
} from "../../../src/contracts/index.js";
import { POLICY_SCHEMA_VERSION } from "../../../src/contracts/index.js";

export const PROFILE = "profile-1" as ProfileId;
export const PARIS = "Europe/Paris" as IanaTimeZone;
export const DAY_PARIS: BudgetPeriodDefinition = { kind: "day", timeZone: PARIS };

export const LIMITS: readonly PeriodLimit[] = [
  { unit: "tokens", cap: 10_000, userReserve: 2_000 },
  { unit: "sessions", cap: 3, userReserve: 0 },
  { unit: "money", cap: 500, userReserve: 0, currency: "EUR" },
];

export function ts(value: string): UtcTimestamp {
  return new Date(value).toISOString() as UtcTimestamp;
}

export function createProfile(uow: UnitOfWork, id: ProfileId = PROFILE): void {
  uow.profiles.create({
    id,
    agentId: "agent-1" as AgentId,
    state: "disabled",
    activePolicyRevisionId: null,
    nextWakeAt: null,
    emergencyStopLocked: false,
    stateReason: "création",
    updatedAt: ts("2026-10-29T08:00:00Z"),
  });
}

/** Groupes de policy complets ; le budget par défaut autorise exactement `LIMITS`. */
export function policyGroups(budget: Partial<BudgetGroup> = {}): PolicyGroups {
  return {
    identity: { profileId: PROFILE, agentId: "agent-1" as AgentId },
    runtime: { adapterId: "fake" as AdapterId, provider: "none", model: "none", authMode: "none" },
    schedule: {
      timeZone: PARIS,
      weeklyWindows: [{ day: 1, start: "09:00", end: "17:00" }],
      minIntervalBetweenSessionsMs: 60_000,
      maxSessionDurationMs: 600_000,
    },
    humanPriority: {
      activitySignal: "idle",
      idleThresholdMs: 60_000,
      maxSignalAgeMs: 10_000,
      maxInterruptLatencyMs: 5_000,
      maxTerminationLatencyMs: 10_000,
    },
    budget: {
      period: DAY_PARIS,
      tokensPerSession: 3_000,
      tokensPerPeriod: 10_000,
      sessionsPerPeriod: 3,
      userReserveTokens: 2_000,
      checkpointTokens: 500,
      paidApi: {
        authorized: true,
        provider: "test",
        currency: "EUR",
        perSessionCapMinor: 500,
        perPeriodCapMinor: 500,
      },
      ...budget,
    },
    filesAndTools: {
      readRoots: [],
      writeRoots: [],
      allowedExecutables: [],
      maxProcesses: 4,
      maxStorageBytes: 1_000_000,
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

/**
 * Ajoute une révision en fin de chaîne pour `PROFILE`, consentie par défaut. Le ledger
 * refuse tout plafond non nul sans révision consentie et effective.
 */
export function authorize(
  uow: UnitOfWork,
  id: string,
  budget: Partial<BudgetGroup> = {},
  consented = true,
): PolicyRevisionId {
  const previous = uow.policies.listRevisions(PROFILE).at(-1)?.id ?? null;
  const revisionId = id as PolicyRevisionId;
  uow.policies.appendRevision({
    schemaVersion: POLICY_SCHEMA_VERSION,
    id: revisionId,
    profileId: PROFILE,
    previousRevisionId: previous,
    createdAt: ts("2026-10-29T08:00:00Z"),
    groups: policyGroups(budget),
  });
  if (consented) {
    uow.policies.recordConsent({
      id: `consent-${id}` as ConsentId,
      revisionId,
      grantedAt: ts("2026-10-29T08:00:00Z"),
      channel: "local_cli",
      proof: "test",
    });
  }
  return revisionId;
}

export interface TempDir {
  readonly path: string;
  readonly dbPath: string;
  remove(): void;
}

export function tempDir(): TempDir {
  const path = mkdtempSync(join(tmpdir(), "mind-wake-store-"));
  return {
    path,
    dbPath: join(path, "control.sqlite"),
    remove: () => {
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
