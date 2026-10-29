/**
 * Recettes avec de vrais processus : P03 (réservations concurrentes), P06 (réponse et
 * clôture concurrentes), P08 (crashs aux frontières) et P13 (deux workers, worker
 * périmé). Chaque enfant a ses propres connexions SQLite ; un crash est un SIGKILL
 * envoyé de l'extérieur pendant que l'enfant est bloqué au point visé.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ledgerIsBalanced,
  openAdviceDatabase,
  type ContractId,
  type MandateId,
  type WorkerReport,
} from "../../../services/advice/session/index.js";
import type { ChildArgs } from "./fixtures/child.js";
import {
  completeExchange,
  drain,
  exchangeEvents,
  harness,
  iso,
  mandateFor,
  openSession,
  POOL,
  tempDir,
  type Clock,
  type Harness,
  type TempDir,
} from "./support.js";

const HOOKS = pathToFileURL(
  fileURLToPath(new URL("../../fixtures/store-ledger/ts-hooks.ts", import.meta.url)),
).href;
const CHILD = fileURLToPath(new URL("./fixtures/child.ts", import.meta.url));

/** Horloge réelle : les enfants utilisent `Date.now()`. */
function realClock(offsetMs = 0): Clock {
  const c: Clock = { t: 0, now: () => Date.now() + offsetMs, advance: () => undefined };
  return c;
}

const NOW = Date.now();
const realMandate = (overrides: Parameters<typeof mandateFor>[0] = {}) =>
  mandateFor({
    validFrom: iso(NOW - 3_600_000),
    expiresAt: iso(NOW + 30 * 86_400_000),
    ...overrides,
  });
const deadline = () => ({ activationDeadline: iso(Date.now() + 3_600_000) });

let dir: TempDir | undefined;
const open: Harness[] = [];

afterEach(() => {
  for (const h of open.splice(0)) h.close();
  dir?.remove();
  dir = undefined;
});

function setup(options: Parameters<typeof harness>[0] = {}): Harness {
  dir ??= tempDir();
  const h = harness({ dir, clock: realClock(), mandates: [realMandate()], ...options });
  open.push(h);
  return h;
}

/** Réouvre la base avec une horloge décalée (bail du processus tué expiré). */
function reopen(offsetMs: number): Harness {
  if (dir === undefined) throw new Error("setup() requis");
  const h = harness({ dir, clock: realClock(offsetMs), fund: null });
  open.push(h);
  return h;
}

interface Running {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; stderr: string }>;
}

function startChild(args: Omit<ChildArgs, "dbPath" | "railPath">): Running {
  if (dir === undefined) throw new Error("setup() requis");
  const full: ChildArgs = { ...args, dbPath: dir.dbPath, railPath: dir.railPath };
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--import", HOOKS, CHILD, JSON.stringify(full)],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on("exit", (code) => {
      resolve({ code, stderr });
    });
  });
  return { child, exited };
}

async function waitFor(path: string, timeoutMs = 20_000): Promise<void> {
  const limit = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > limit) throw new Error(`attente de ${path} expirée`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function cleanExit(running: Running): Promise<void> {
  const { code, stderr } = await running.exited;
  expect(stderr).toBe("");
  expect(code).toBe(0);
}

async function crash(running: Running, marker: string): Promise<void> {
  await waitFor(marker);
  running.child.kill("SIGKILL");
  const { code } = await running.exited;
  expect(code).not.toBe(0);
}

function path(name: string): string {
  if (dir === undefined) throw new Error("setup() requis");
  return join(dir.path, name);
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function integrityOk(): void {
  if (dir === undefined) throw new Error("setup() requis");
  const db = openAdviceDatabase(dir.dbPath);
  try {
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(ledgerIsBalanced(db)).toBe(true);
  } finally {
    db.close();
  }
}

/** Séance close et approuvée : trois échanges acquis, 6 unités fictives dues. */
function approvedSession(h: Harness, id: string): ContractId {
  const contractId = openSession(h.service, id, deadline());
  for (const x of ["x1", "x2", "x3"]) completeExchange(h.service, contractId, x);
  h.service.close(contractId, "guide_stop");
  h.service.approve(contractId);
  return contractId;
}

function expectSettledOnce(h: Harness, id: ContractId): void {
  expect(h.rail.effects()).toEqual([expect.objectContaining({ key: `stl-${id}`, amount: "6" })]);
  expect(h.service.status(id)).toMatchObject({
    state: "settled",
    settlement: { state: "finalized" },
    reservation: { state: "consumed" },
  });
  expect(h.service.poolBalances(POOL)).toEqual({
    available: 94n,
    reserved: 0n,
    due: 0n,
    settling: 0n,
  });
}

describe("P03 — réservations simultanées au-delà de l'enveloppe", () => {
  it("quatre processus : seules les réservations intégralement couvertes passent", async () => {
    const mandates = [1, 2, 3, 4].map((i) =>
      realMandate({ mandateId: `mandate-${String(i)}`, agentId: `agent-${String(i)}` }),
    );
    const h = setup({ fund: 25n, mandates });
    const ids = [1, 2, 3, 4].map((i) => {
      const contract = h.service.offer(
        `req-${String(i)}`,
        {
          contractId: `c-${String(i)}`,
          agentId: `agent-${String(i)}`,
          guidePrincipalId: `guide-${String(i)}`,
          recipientBindingVersion: "binding-1",
          guideTermsVersion: "terms-1",
          topic: "conseil",
          contextVersion: "ctx-1",
          unitPrice: "2",
          ...deadline(),
          inactivityTimeoutMs: 600_000,
          closeGraceMs: 60_000,
        },
        { mandateId: `mandate-${String(i)}` as MandateId, version: 1 },
      );
      h.service.accept(contract.contractId, contract.guidePrincipalId, "terms-1");
      return contract.contractId;
    });
    const barrier = path("go");
    const children = ids.map((contractId, i) =>
      startChild({ mode: "reserve", contractId, barrier, result: path(`r-${String(i)}.json`) }),
    );
    writeFileSync(barrier, "");
    await Promise.all(children.map(cleanExit));
    const results = ids.map(
      (_, i) => readJson(path(`r-${String(i)}.json`)) as { status: string; code?: string },
    );
    expect(results.filter((r) => r.status === "reserved")).toHaveLength(2);
    expect(results.filter((r) => r.code === "insufficient_fictive_funds")).toHaveLength(2);
    integrityOk();
    expect(h.service.poolBalances(POOL)).toEqual({
      available: 5n,
      reserved: 20n,
      due: 0n,
      settling: 0n,
    });
  }, 60_000);
});

describe("P06 — réponse et clôture concurrentes", () => {
  it("admission déterministe, compteur figé une fois, montant stable", async () => {
    const h = setup();
    for (const round of [1, 2, 3]) {
      const id = openSession(h.service, `c-race-${String(round)}`, deadline());
      completeExchange(h.service, id, "x1");
      const [point, ...rest] = exchangeEvents(id, "x2");
      h.service.ingest(point);
      const barrier = path(`go-${String(round)}`);
      const a = startChild({
        mode: "ingest",
        events: rest,
        barrier,
        result: path(`ingest-${String(round)}.json`),
      });
      const b = startChild({
        mode: "close",
        contractId: id,
        barrier,
        result: path(`close-${String(round)}.json`),
      });
      writeFileSync(barrier, "");
      await Promise.all([cleanExit(a), cleanExit(b)]);
      const outcomes = readJson(path(`ingest-${String(round)}.json`)) as { status: string }[];
      const contributionAdmitted = outcomes[0]?.status === "applied";
      const expected = contributionAdmitted ? 2 : 1;
      // Une contribution admise avant le watermark a sa réponse dans la grâce.
      expect(outcomes.map((o) => o.status)).toEqual(
        contributionAdmitted
          ? ["applied", "applied", "applied"]
          : ["refused", "refused", "refused"],
      );
      const first = h.service.approve(id);
      expect(first).toEqual({ earnedExchanges: expected, principalDue: BigInt(expected * 2) });
      expect(h.service.approve(id)).toEqual(first);
      expect(h.service.ingest({ ...rest[2], eventId: `late-${String(round)}` }).status).toBe(
        "refused",
      );
      expect(h.service.status(id).principalDue).toBe(BigInt(expected * 2));
      h.service.prepareSettlement(id);
    }
    await drain(h.service);
    expect(h.rail.effects()).toHaveLength(3);
    integrityOk();
  }, 90_000);
});

describe("P08 — crash avant/après écriture, outbox, émission et notification", () => {
  it("crash dans la transaction de préparation : rien d'écrit, reprise unique", async () => {
    const h = setup();
    const id = approvedSession(h, "c-crash-txn");
    const marker = path("inside");
    await crash(
      startChild({ mode: "prepare", contractId: id, crashAt: "prepare:in_txn", marker }),
      marker,
    );
    integrityOk();
    expect(h.service.status(id)).toMatchObject({ state: "approved", settlement: null });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 0 });
    expect(h.service.prepareSettlement(id).status).toBe("prepared");
    await drain(h.service);
    expectSettledOnce(h, id);
  }, 60_000);

  it("crash après écriture de l'intention et de l'outbox : émission unique au redémarrage", async () => {
    const h = setup();
    const id = approvedSession(h, "c-crash-outbox");
    const marker = path("after-commit");
    await crash(
      startChild({ mode: "prepare", contractId: id, crashAt: "prepare:after_commit", marker }),
      marker,
    );
    integrityOk();
    expect(h.service.status(id).settlement?.state).toBe("prepared");
    expect(h.service.prepareSettlement(id).status).toBe("already_prepared");
    await drain(h.service);
    expectSettledOnce(h, id);
  }, 60_000);

  it("crash avant émission : rapprochement (absence probante) puis émission unique", async () => {
    const h = setup();
    const id = approvedSession(h, "c-crash-before-submit");
    h.service.prepareSettlement(id);
    const marker = path("before-submit");
    await crash(
      startChild({ mode: "worker", crashAt: "worker:after_submission_pending", marker }),
      marker,
    );
    integrityOk();
    expect(h.service.status(id).settlement?.state).toBe("submission_pending");
    expect(h.rail.effects()).toEqual([]);
    // Le bail du processus tué expire ; un autre worker reprend.
    const later = reopen(60_000);
    await drain(later.service, "restart");
    expectSettledOnce(later, id);
  }, 60_000);

  it("crash après émission, avant écriture locale : effet retrouvé, aucun second ordre", async () => {
    const h = setup();
    const id = approvedSession(h, "c-crash-after-submit");
    h.service.prepareSettlement(id);
    const marker = path("after-submit");
    await crash(
      startChild({ mode: "worker", crashAt: "worker:after_rail_submit", marker }),
      marker,
    );
    integrityOk();
    expect(h.rail.effects()).toHaveLength(1);
    expect(h.service.status(id).settlement?.state).toBe("submission_pending");
    expect(h.service.poolBalances(POOL).due).toBe(6n);
    const later = reopen(60_000);
    await drain(later.service, "restart");
    expectSettledOnce(later, id);
    expect(
      later.db
        .prepare<[], { state: string }>("SELECT state FROM transfer_attempts ORDER BY attempt_id")
        .all()
        .map((r) => r.state),
    ).toEqual(["accepted"]);
  }, 60_000);

  it("crash après finalisation, avant notification : une seule notification", async () => {
    const h = setup();
    const id = approvedSession(h, "c-crash-finalized");
    h.service.prepareSettlement(id);
    const marker = path("finalized");
    await crash(startChild({ mode: "worker", crashAt: "worker:after_finalize", marker }), marker);
    integrityOk();
    expect(h.rail.notifications()).toEqual([]);
    const later = reopen(60_000);
    expectSettledOnce(later, id);
    await drain(later.service, "restart");
    expect(later.rail.notifications()).toHaveLength(1);
    expect(later.rail.effects()).toHaveLength(1);
  }, 60_000);

  it("crash après envoi de la notification, avant acquittement : dédupliquée", async () => {
    const h = setup();
    const id = approvedSession(h, "c-crash-notify");
    h.service.prepareSettlement(id);
    const marker = path("notified");
    await crash(
      startChild({ mode: "worker", passes: 2, crashAt: "notify:after_send", marker }),
      marker,
    );
    integrityOk();
    expect(h.rail.notifications()).toHaveLength(1);
    const later = reopen(60_000);
    const report = await later.service.runWorker("restart");
    expect(report.handled.map((x) => x.result)).toEqual(["notification_duplicate"]);
    expect(later.rail.notifications()).toHaveLength(1);
    expectSettledOnce(later, id);
  }, 60_000);
});

describe("P13 — deux workers et reprise d'un worker périmé", () => {
  it("deux workers simultanés : une seule émission", async () => {
    const h = setup();
    const id = approvedSession(h, "c-two-workers");
    h.service.prepareSettlement(id);
    const barrier = path("go");
    const workers = ["w-a", "w-b"].map((workerId) =>
      startChild({ mode: "worker", workerId, barrier, result: path(`${workerId}.json`) }),
    );
    writeFileSync(barrier, "");
    await Promise.all(workers.map(cleanExit));
    const results = ["w-a", "w-b"].flatMap((w) =>
      (readJson(path(`${w}.json`)) as WorkerReport[]).flatMap((r) =>
        r.handled.map((x) => x.result),
      ),
    );
    expect(results.filter((r) => r === "finalized")).toHaveLength(1);
    integrityOk();
    expectSettledOnce(h, id);
  }, 60_000);

  it("worker périmé après bail : ses écritures sont refusées par fencing", async () => {
    const h = setup();
    const id = approvedSession(h, "c-stale-lease");
    h.service.prepareSettlement(id);
    const marker = path("paused");
    const resume = path("resume");
    const stale = startChild({
      mode: "worker",
      workerId: "w-stale",
      leaseMs: 300,
      pauseAt: "worker:after_lease",
      marker,
      resume,
      result: path("stale.json"),
    });
    await waitFor(marker);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await drain(h.service, "w-fresh");
    expectSettledOnce(h, id);
    writeFileSync(resume, "");
    await cleanExit(stale);
    expect((readJson(path("stale.json")) as WorkerReport[])[0]?.handled).toEqual([
      expect.objectContaining({ result: "stale_lease" }),
    ]);
    integrityOk();
    expectSettledOnce(h, id);
  }, 60_000);

  it("worker périmé juste avant d'émettre : le rail refuse son jeton, aucun doublon", async () => {
    const h = setup();
    const id = approvedSession(h, "c-stale-submit");
    h.service.prepareSettlement(id);
    const marker = path("paused");
    const resume = path("resume");
    const stale = startChild({
      mode: "worker",
      workerId: "w-stale",
      leaseMs: 300,
      pauseAt: "worker:after_submission_pending",
      marker,
      resume,
      result: path("stale.json"),
    });
    await waitFor(marker);
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Le nouveau worker rapproche (absence probante) et émet avec un jeton plus récent.
    await drain(h.service, "w-fresh");
    expectSettledOnce(h, id);
    writeFileSync(resume, "");
    await cleanExit(stale);
    expect((readJson(path("stale.json")) as WorkerReport[])[0]?.handled).toEqual([
      expect.objectContaining({ result: "stale_lease" }),
    ]);
    integrityOk();
    expectSettledOnce(h, id);
  }, 60_000);
});
