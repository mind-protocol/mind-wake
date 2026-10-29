/**
 * Concurrence et crash entre processus réels : chaque enfant ouvre sa propre connexion
 * SQLite sur le même fichier, comme deux daemons ou un daemon et une CLI.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChildArgs } from "../../test/fixtures/store-ledger/ledger-child.js";
import {
  DAY_PARIS,
  PROFILE,
  authorize,
  createProfile,
  tempDir,
  ts,
  type TempDir,
} from "../../test/fixtures/store-ledger/setup.js";
import type { BudgetPeriodId, ReservationId, SessionId } from "../contracts/index.js";
import { openStore } from "../store/index.js";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures/store-ledger/", import.meta.url));
const HOOKS = pathToFileURL(join(FIXTURES, "ts-hooks.ts")).href;
const CHILD = join(FIXTURES, "ledger-child.ts");
const AT = "2026-10-29T12:00:00.000Z";

let dir: TempDir;
let periodId: BudgetPeriodId;

beforeEach(() => {
  dir = tempDir();
  const store = openStore(dir.dbPath);
  createProfile(store.uow);
  authorize(store.uow, "rev-1", { tokensPerPeriod: 100_000, userReserveTokens: 0 });
  periodId = store.uow.ledger.ensurePeriod(PROFILE, DAY_PARIS, ts(AT), [
    { unit: "tokens", cap: 100_000, userReserve: 0 },
    { unit: "sessions", cap: 3, userReserve: 0 },
  ]).id;
  store.close();
});

afterEach(() => {
  dir.remove();
});

interface Running {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
}

function startChild(args: Omit<ChildArgs, "dbPath" | "periodId" | "at">): Running {
  const full: ChildArgs = { ...args, dbPath: dir.dbPath, periodId, at: AT };
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--import", HOOKS, CHILD, JSON.stringify(full)],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }>((resolve) => {
    child.on("exit", (code, signal) => {
      resolve({ code, signal, stderr });
    });
  });
  return { child, exited };
}

async function waitFor(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`attente de ${path} expirée`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function expectCleanExit(running: Running): Promise<void> {
  const { code, stderr } = await running.exited;
  expect(stderr).toBe("");
  expect(code).toBe(0);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("concurrence entre processus", () => {
  it("laisse passer une seule de quatre réservations simultanées", async () => {
    const barrier = join(dir.path, "go");
    const children = [0, 1, 2, 3].map((i) =>
      startChild({
        mode: "race-reserve",
        barrier,
        result: join(dir.path, `result-${String(i)}.json`),
      }),
    );
    writeFileSync(barrier, "");
    await Promise.all(children.map(expectCleanExit));
    const results = [0, 1, 2, 3].map((i) => readJson(join(dir.path, `result-${String(i)}.json`)));
    expect(results.filter((r) => (r as { status: string }).status === "reserved")).toHaveLength(1);
    expect(
      results.filter((r) => (r as { reason?: string }).reason === "session_already_active"),
    ).toHaveLength(3);

    const store = openStore(dir.dbPath);
    try {
      expect(store.uow.ledger.listUnreconciled(PROFILE)).toHaveLength(1);
      expect(store.uow.ledger.availability(periodId, "sessions").openReservations).toBe(1);
    } finally {
      store.close();
    }
  }, 60_000);

  it("ne dépasse jamais le plafond de sessions sous réservations et rapprochements concurrents", async () => {
    const barrier = join(dir.path, "go");
    const children = [0, 1, 2, 3].map((i) =>
      startChild({ mode: "race-loop", barrier, result: join(dir.path, `loop-${String(i)}.json`) }),
    );
    writeFileSync(barrier, "");
    await Promise.all(children.map(expectCleanExit));
    const successes = [0, 1, 2, 3]
      .map(
        (i) =>
          (readJson(join(dir.path, `loop-${String(i)}.json`)) as { successes: number }).successes,
      )
      .reduce((a, b) => a + b, 0);
    expect(successes).toBe(3);

    const store = openStore(dir.dbPath);
    try {
      expect(store.uow.ledger.availability(periodId, "sessions")).toMatchObject({
        reconciled: 3,
        openReservations: 0,
        available: 0,
      });
      expect(store.uow.ledger.availability(periodId, "tokens").reconciled).toBe(1_200);
    } finally {
      store.close();
    }
  }, 60_000);
});

describe("crash pendant une transaction", () => {
  function integrityOk(): void {
    const store = openStore(dir.dbPath);
    try {
      expect(store.db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(store.db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      store.close();
    }
  }

  it("annule une réservation interrompue par la mort du processus, sans remise à zéro", async () => {
    // Usage déjà rapproché avant le crash : il doit survivre.
    const setup = openStore(dir.dbPath);
    setup.uow.ledger.reserve({
      id: "before" as ReservationId,
      sessionId: "session-before" as SessionId,
      profileId: PROFILE,
      periodIds: [periodId],
      maxima: [{ unit: "sessions", amount: 1 }],
      at: ts(AT),
    });
    setup.uow.ledger.reconcile("before" as ReservationId, [], ts(AT));
    setup.close();

    const marker = join(dir.path, "inside");
    const running = startChild({ mode: "crash-in-reserve", marker });
    await waitFor(marker);
    running.child.kill("SIGKILL");
    const { code } = await running.exited;
    expect(code).not.toBe(0);

    integrityOk();
    const store = openStore(dir.dbPath, { busyTimeoutMs: 1_000 });
    try {
      expect(store.uow.ledger.listUnreconciled(PROFILE)).toEqual([]);
      expect(store.uow.ledger.availability(periodId, "sessions")).toMatchObject({
        reconciled: 1,
        openReservations: 0,
        available: 2,
      });
      // Le verrou du processus mort est libéré : une nouvelle réservation passe.
      expect(
        store.uow.ledger.reserve({
          id: "after" as ReservationId,
          sessionId: "session-after" as SessionId,
          profileId: PROFILE,
          periodIds: [periodId],
          maxima: [{ unit: "sessions", amount: 1 }],
          at: ts(AT),
        }).status,
      ).toBe("reserved");
    } finally {
      store.close();
    }
  }, 60_000);

  it("garde la réservation ouverte à sa borne si le rapprochement est interrompu", async () => {
    const setup = openStore(dir.dbPath);
    setup.uow.ledger.reserve({
      id: "r1" as ReservationId,
      sessionId: "session-r1" as SessionId,
      profileId: PROFILE,
      periodIds: [periodId],
      maxima: [{ unit: "tokens", amount: 5_000 }],
      at: ts(AT),
    });
    setup.close();

    const marker = join(dir.path, "inside");
    const running = startChild({ mode: "crash-in-reconcile", marker, reservationId: "r1" });
    await waitFor(marker);
    running.child.kill("SIGKILL");
    await running.exited;

    integrityOk();
    const store = openStore(dir.dbPath);
    try {
      expect(store.uow.ledger.getReservation("r1" as ReservationId)?.status).toBe("open");
      expect(store.uow.ledger.listUsage("r1" as ReservationId)).toEqual([]);
      expect(store.uow.ledger.availability(periodId, "tokens")).toMatchObject({
        reconciled: 0,
        openReservations: 5_000,
      });
      // Réconciliation de l'orpheline : incertaine, puis rapprochement fiable unique.
      store.uow.ledger.markUncertain("r1" as ReservationId, ts(AT));
      store.uow.ledger.reconcile(
        "r1" as ReservationId,
        [
          {
            reservationId: "r1" as ReservationId,
            quantity: { unit: "tokens", amount: 10 },
            provenance: "measured",
            recordedAt: ts(AT),
          },
        ],
        ts(AT),
      );
      expect(store.uow.ledger.availability(periodId, "tokens")).toMatchObject({
        reconciled: 10,
        openReservations: 0,
      });
    } finally {
      store.close();
    }
  }, 60_000);
});
