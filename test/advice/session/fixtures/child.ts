/**
 * Processus enfant des recettes multi-processus du service de séances SIMULÉ. Lancé par
 * `node --import ts-hooks.ts child.ts '<json>'` ; chaque processus ouvre ses propres
 * connexions SQLite (service et rail simulé), comme deux workers ou un worker et l'API.
 *
 * `crashAt` : au point indiqué, écrit le marqueur puis se bloque jusqu'à être tué.
 * `pauseAt` : au point indiqué, écrit le marqueur puis attend le fichier `resume`.
 */

import { existsSync, writeFileSync } from "node:fs";
import {
  AdviceSessionService,
  openAdviceDatabase,
  SimulatedSettlementRail,
  type ContractId,
  type CrashPoint,
} from "../../../../services/advice/session/index.js";

export interface ChildArgs {
  readonly mode: "reserve" | "ingest" | "close" | "prepare" | "worker";
  readonly dbPath: string;
  readonly railPath: string;
  readonly contractId?: string;
  readonly events?: readonly unknown[];
  readonly workerId?: string;
  readonly passes?: number;
  readonly leaseMs?: number;
  readonly barrier?: string;
  readonly marker?: string;
  readonly resume?: string;
  readonly result?: string;
  readonly crashAt?: CrashPoint;
  readonly pauseAt?: CrashPoint;
}

const args = JSON.parse(process.argv[2] ?? "{}") as ChildArgs;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number): void => {
  Atomics.wait(sleeper, 0, 0, ms);
};

function waitForFile(path: string | undefined): void {
  if (path === undefined) return;
  while (!existsSync(path)) sleep(2);
}

const db = openAdviceDatabase(args.dbPath);
const rail = new SimulatedSettlementRail(args.railPath);
const service = new AdviceSessionService({
  db,
  rail,
  ...(args.leaseMs === undefined ? {} : { leaseMs: args.leaseMs }),
  hooks: {
    reached(point) {
      if (point === args.crashAt) {
        if (args.marker !== undefined) writeFileSync(args.marker, String(process.pid));
        for (;;) sleep(1_000);
      }
      if (point === args.pauseAt) {
        if (args.marker !== undefined) writeFileSync(args.marker, String(process.pid));
        waitForFile(args.resume);
      }
    },
  },
});

function writeResult(value: unknown): void {
  if (args.result !== undefined) writeFileSync(args.result, JSON.stringify(value));
}

function code(error: unknown): string {
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : String(error);
}

const contractId = (args.contractId ?? "") as ContractId;
waitForFile(args.barrier);

switch (args.mode) {
  case "reserve":
    try {
      service.reserve(contractId);
      writeResult({ status: "reserved" });
    } catch (error) {
      writeResult({ status: "refused", code: code(error) });
    }
    break;
  case "ingest":
    writeResult((args.events ?? []).map((event) => service.ingest(event)));
    break;
  case "close":
    writeResult(service.close(contractId, "guide_stop"));
    break;
  case "prepare":
    writeResult(service.prepareSettlement(contractId));
    break;
  case "worker": {
    const reports = [];
    for (let i = 0; i < (args.passes ?? 1); i += 1) {
      reports.push(await service.runWorker(args.workerId ?? "child-worker"));
    }
    writeResult(reports);
    break;
  }
}

db.close();
rail.close();
