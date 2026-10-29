/**
 * Mise en place commune des recettes du service de séances SIMULÉ : fonds fictifs,
 * horloge maîtrisée, base et rail simulé dans un dossier temporaire.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdviceSessionService,
  buildMandate,
  openAdviceDatabase,
  SimulatedSettlementRail,
  type AdviceDatabase,
  type ContractId,
  type ContractOffer,
  type CrashPoint,
  type MandateId,
  type PaymentMandate,
  type PoolId,
  type PrincipalId,
  type SimulatedRailOptions,
  type UtcTimestamp,
} from "../../../services/advice/session/index.js";

export const T0 = Date.parse("2026-10-29T12:00:00.000Z");
export const PAYER = "owner-1" as PrincipalId;
export const POOL = "pool-1" as PoolId;
export const MANDATE = "mandate-1" as MandateId;
export const GUIDE = "guide-1" as PrincipalId;
export const AGENT = "agent-1";
export const TERMS = "guide-terms-1";

export const iso = (ms: number): UtcTimestamp => new Date(ms).toISOString() as UtcTimestamp;

export interface Clock {
  t: number;
  readonly now: () => number;
  advance(ms: number): void;
}

export function clock(start = T0): Clock {
  const c: Clock = {
    t: start,
    now: () => c.t,
    advance(ms) {
      c.t += ms;
    },
  };
  return c;
}

export interface TempDir {
  readonly path: string;
  readonly dbPath: string;
  readonly railPath: string;
  remove(): void;
}

export function tempDir(): TempDir {
  const path = mkdtempSync(join(tmpdir(), "advice-session-"));
  return {
    path,
    dbPath: join(path, "advice.sqlite"),
    railPath: join(path, "rail-simulated.sqlite"),
    remove: () => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

export function mandateFor(
  overrides: Partial<Parameters<typeof buildMandate>[0]> = {},
): PaymentMandate {
  return buildMandate({
    mandateId: MANDATE,
    version: 1,
    payerPrincipalId: PAYER,
    agentId: AGENT,
    poolId: POOL,
    guideRule: { kind: "any_guide_with_terms" },
    perExchangeCap: "10",
    perSessionCap: "50",
    perPeriodCap: "1000",
    periodMs: 24 * 3_600_000,
    maxOpenReservations: 10,
    validFrom: iso(T0 - 3_600_000),
    expiresAt: iso(T0 + 30 * 24 * 3_600_000),
    ...overrides,
  });
}

export function offerFor(id: string, overrides: Partial<ContractOffer> = {}): ContractOffer {
  return {
    contractId: id,
    agentId: AGENT,
    guidePrincipalId: GUIDE,
    recipientBindingVersion: "binding-1",
    guideTermsVersion: TERMS,
    topic: "petits systèmes émergents",
    contextVersion: "ctx-1",
    unitPrice: "2",
    activationDeadline: iso(T0 + 3_600_000),
    inactivityTimeoutMs: 30 * 60_000,
    closeGraceMs: 60_000,
    ...overrides,
  };
}

export interface Harness {
  readonly dir: TempDir;
  readonly db: AdviceDatabase;
  readonly rail: SimulatedSettlementRail;
  readonly service: AdviceSessionService;
  readonly clock: Clock;
  close(): void;
}

export function harness(
  options: {
    dir?: TempDir;
    clock?: Clock;
    rail?: Omit<SimulatedRailOptions, "now">;
    hooks?: { reached(point: CrashPoint): void };
    leaseMs?: number;
    fund?: bigint | null;
    mandates?: readonly PaymentMandate[];
  } = {},
): Harness {
  const dir = options.dir ?? tempDir();
  const c = options.clock ?? clock();
  const db = openAdviceDatabase(dir.dbPath);
  const rail = new SimulatedSettlementRail(dir.railPath, { ...options.rail, now: c.now });
  const service = new AdviceSessionService({
    db,
    rail,
    now: c.now,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
  });
  if (options.fund !== null) {
    service.createPool(POOL, PAYER);
    service.fundPool(POOL, options.fund ?? 100n, "initial");
    for (const mandate of options.mandates ?? [mandateFor()]) service.registerMandate(mandate);
  }
  return {
    dir,
    db,
    rail,
    service,
    clock: c,
    close: () => {
      db.close();
      rail.close();
    },
  };
}

/** Offre, acceptation, réservation et activation d'une séance standard (5 × 2). */
export function openSession(
  service: AdviceSessionService,
  id: string,
  overrides: Partial<ContractOffer> = {},
  mandateId: MandateId = MANDATE,
): ContractId {
  const contract = service.offer(`req-${id}`, offerFor(id, overrides), {
    mandateId,
    version: 1,
  });
  service.accept(contract.contractId, contract.guidePrincipalId, TERMS);
  service.reserve(contract.contractId);
  service.activate(contract.contractId);
  return contract.contractId;
}

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${String((counter += 1))}`;

/** Événements d'un échange complet et payable. */
export function exchangeEvents(contractId: string, exchangeId: string, guide: string = GUIDE) {
  return [
    {
      kind: "agent_point",
      producer: "agent_runtime",
      eventId: nextId("ev"),
      contractId,
      exchangeId,
      messageId: `${exchangeId}-q`,
    },
    {
      kind: "human_contribution",
      producer: "channel",
      eventId: nextId("ev"),
      contractId,
      exchangeId,
      messageId: `${exchangeId}-h`,
      authorPrincipalId: guide,
      provenance: "human_explicit",
    },
    {
      kind: "agent_reply",
      producer: "agent_runtime",
      eventId: nextId("ev"),
      contractId,
      exchangeId,
      messageId: `${exchangeId}-r`,
      part: { index: 0, final: true },
      substantive: true,
    },
    {
      kind: "agent_checkpoint",
      producer: "agent_runtime",
      eventId: nextId("ev"),
      contractId,
      exchangeId,
      checkpointRef: `${exchangeId}-ckpt`,
    },
  ] as const;
}

export function completeExchange(
  service: AdviceSessionService,
  contractId: string,
  exchangeId: string,
  guide: string = GUIDE,
): void {
  for (const event of exchangeEvents(contractId, exchangeId, guide)) {
    const outcome = service.ingest(event);
    if (outcome.status !== "applied") {
      throw new Error(`échange ${exchangeId} non appliqué : ${JSON.stringify(outcome)}`);
    }
  }
}

/** Fait tourner les workers jusqu'à stabilité (borne de sécurité). */
export async function drain(service: AdviceSessionService, workerId = "worker-a"): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    const report = await service.runWorker(workerId);
    if (report.handled.length === 0) return;
  }
}
