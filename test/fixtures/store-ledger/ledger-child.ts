/**
 * Processus enfant des tests multi-processus du ledger. Lancé par
 * `node --import ts-hooks.ts ledger-child.ts '<json>'` ; chaque processus a sa propre
 * connexion SQLite, comme deux daemons ou un daemon et une CLI.
 */

import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import type {
  BudgetPeriodId,
  ReservationId,
  ReservationResult,
  SessionId,
} from "../../../src/contracts/index.js";
import { toUtcTimestamp } from "../../../src/ledger/index.js";
import { openStore } from "../../../src/store/index.js";
import { PROFILE } from "./setup.js";

export interface ChildArgs {
  readonly mode: "race-reserve" | "race-loop" | "crash-in-reserve" | "crash-in-reconcile";
  readonly dbPath: string;
  readonly periodId: string;
  readonly at: string;
  readonly barrier?: string;
  readonly marker?: string;
  readonly result?: string;
  readonly reservationId?: string;
}

const args = JSON.parse(process.argv[2] ?? "{}") as ChildArgs;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number): void => {
  Atomics.wait(sleeper, 0, 0, ms);
};

const store = openStore(args.dbPath);
const { uow } = store;
const at = toUtcTimestamp(Date.parse(args.at));

function waitForBarrier(): void {
  if (args.barrier === undefined) return;
  while (!existsSync(args.barrier)) sleep(2);
}

function reserveOnce(): ReservationResult {
  return uow.ledger.reserve({
    id: randomUUID() as ReservationId,
    sessionId: randomUUID() as SessionId,
    profileId: PROFILE,
    periodIds: [args.periodId as BudgetPeriodId],
    maxima: [
      { unit: "sessions", amount: 1 },
      { unit: "tokens", amount: 1_000 },
    ],
    at,
  });
}

function writeResult(value: unknown): void {
  if (args.result !== undefined) writeFileSync(args.result, JSON.stringify(value));
}

function isBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    String((error as { code?: unknown }).code).startsWith("SQLITE_BUSY")
  );
}

/** Bloque indéfiniment à l'intérieur de la transaction, jusqu'à être tué. */
function hangInsideTransaction(): never {
  if (args.marker !== undefined) writeFileSync(args.marker, String(process.pid));
  for (;;) sleep(1_000);
}

switch (args.mode) {
  case "race-reserve": {
    waitForBarrier();
    const result = reserveOnce();
    writeResult(result.status === "reserved" ? { status: "reserved" } : result);
    break;
  }
  case "race-loop": {
    waitForBarrier();
    let successes = 0;
    let busy = 0;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try {
        const result = reserveOnce();
        if (result.status === "reserved") {
          uow.ledger.reconcile(
            result.reservation.id,
            [
              {
                reservationId: result.reservation.id,
                quantity: { unit: "sessions", amount: 1 },
                provenance: "measured",
                recordedAt: at,
              },
              {
                reservationId: result.reservation.id,
                quantity: { unit: "tokens", amount: 400 },
                provenance: "measured",
                recordedAt: at,
              },
            ],
            at,
          );
          successes += 1;
        } else if (result.reason === "budget_exhausted") {
          break;
        } else {
          sleep(3);
        }
      } catch (error) {
        if (!isBusy(error)) throw error;
        busy += 1;
      }
    }
    writeResult({ successes, busy });
    break;
  }
  case "crash-in-reserve": {
    uow.transaction(() => {
      const result = reserveOnce();
      if (result.status !== "reserved") throw new Error(`réservation refusée : ${result.reason}`);
      hangInsideTransaction();
    });
    break;
  }
  case "crash-in-reconcile": {
    const reservationId = args.reservationId as ReservationId;
    uow.transaction(() => {
      uow.ledger.reconcile(
        reservationId,
        [
          {
            reservationId,
            quantity: { unit: "tokens", amount: 10 },
            provenance: "measured",
            recordedAt: at,
          },
        ],
        at,
      );
      hangInsideTransaction();
    });
    break;
  }
}

store.close();
