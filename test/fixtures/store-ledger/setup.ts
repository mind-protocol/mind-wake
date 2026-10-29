/** Données de test partagées par les tests du store et du ledger. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentId,
  BudgetPeriodDefinition,
  IanaTimeZone,
  PeriodLimit,
  ProfileId,
  UtcTimestamp,
} from "../../../src/contracts/index.js";
import type { UnitOfWork } from "../../../src/contracts/index.js";

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
