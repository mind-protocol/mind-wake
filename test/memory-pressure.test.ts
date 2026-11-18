/**
 * Incident du 17 nov. 2026 (salle 6, « Emploi remote ») : mémoire du poste épuisée, SQLite rend
 * « out of memory » dans un tour de room à plusieurs agents, l'erreur remonte hors de tout
 * try/catch et `forks run` s'arrête (« Erreur : out of memory » dans forks.log) : toutes les rooms
 * tombent. Ces tests figent le correctif commun : l'erreur reste dans la room, la mémoire basse
 * diffère les lancements (rooms : borné ; jobs de fond : en file).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundJobs } from "../src/daemon/background-jobs.js";
import { saveForkAssignment } from "../src/daemon/fork-assignment.js";
import {
  forkDir,
  OUT_OF_MEMORY_BACKOFF_MS,
  runForks,
  sendToFork,
  setForkEnabled,
} from "../src/daemon/forks.js";
import { isOutOfMemoryError, MemoryGate, readMemory } from "../src/daemon/memory-pressure.js";
import { SecondThreadStore } from "../src/daemon/second-thread.js";

const MB = 1024 * 1024;
const GB16 = () => 16 * 1024 * MB;

describe("memory-pressure", () => {
  it("reconnaît les erreurs d'allocation (SQLite, libuv, V8) et pas les autres", () => {
    expect(isOutOfMemoryError(new Error("out of memory"))).toBe(true);
    expect(isOutOfMemoryError(Object.assign(new Error("x"), { code: "SQLITE_NOMEM" }))).toBe(true);
    expect(isOutOfMemoryError(new Error("spawn ENOMEM"))).toBe(true);
    expect(isOutOfMemoryError(new RangeError("Array buffer allocation failed"))).toBe(true);
    expect(isOutOfMemoryError(new Error("database is locked"))).toBe(false);
    expect(isOutOfMemoryError("Prompt is too long")).toBe(false);
  });

  it("mesure la mémoire ; seuil plafonné à un dixième de la mémoire totale ; sonde muette = pas de blocage", () => {
    expect(readMemory(1024, () => 370 * MB, GB16)).toEqual({
      freeMb: 370,
      totalMb: 16384,
      low: true,
    });
    expect(readMemory(1024, () => 4096 * MB, GB16).low).toBe(false);
    // Machine de 2 Go : seuil effectif 205 Mo, 300 Mo libres ne bloquent pas.
    expect(
      readMemory(
        1024,
        () => 300 * MB,
        () => 2048 * MB,
      ).low,
    ).toBe(false);
    expect(
      readMemory(
        1024,
        () => {
          throw new Error("sonde");
        },
        GB16,
      ).low,
    ).toBe(false);
  });

  it("MemoryGate : attente bornée, une note par épisode, reprise annoncée", () => {
    let free = 200 * MB;
    let now = 0;
    const gate = new MemoryGate({
      maxWaitMs: 90_000,
      probe: () => free,
      total: GB16,
      now: () => now,
    });
    const a = gate.check();
    expect(a.wait).toBe(true);
    expect(a.note).toMatch(/mémoire basse \(200 Mo/);
    now = 30_000;
    expect(gate.check()).toMatchObject({ wait: true, note: null });
    now = 95_000;
    const late = gate.check();
    expect(late.wait).toBe(false);
    expect(late.note).toMatch(/sans attendre davantage/);
    // Nouvel épisode puis retour de la mémoire.
    now = 100_000;
    expect(gate.check().wait).toBe(true);
    free = 4096 * MB;
    expect(gate.check()).toMatchObject({
      wait: false,
      note: expect.stringMatching(/mémoire revenue/) as unknown,
    });
    expect(gate.check().note).toBeNull();
  });
});

describe("worker des rooms sous pression mémoire", () => {
  let dir: string;
  let workspace: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-memory-"));
    workspace = path.join(dir, "workspace");
    fs.mkdirSync(path.join(workspace, "agents", "a"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "agents", "b"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "ROOM.md"), "Room commune.");
    fs.writeFileSync(path.join(workspace, "agents", "a", "SYSTEM.md"), "Agent A.");
    fs.writeFileSync(path.join(workspace, "agents", "b", "SYSTEM.md"), "Agent B.");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const assignMultiAgentRoom = () => {
    saveForkAssignment(forkDir(dir, 6), {
      instructions: path.join(workspace, "ROOM.md"),
      engine: "claude",
      workspace,
      inbox: "explicit",
      agents: [
        {
          id: "a",
          name: "Agent A",
          instructions: path.join(workspace, "agents", "a"),
          writable: ["agents/a"],
          tools: "none",
        },
        {
          id: "b",
          name: "Agent B",
          instructions: path.join(workspace, "agents", "b"),
          writable: ["agents/b"],
          tools: "none",
        },
      ],
    });
    setForkEnabled(dir, 6, true);
  };
  const lastTurn = () => {
    const store = new SecondThreadStore(forkDir(dir, 6));
    try {
      return store.lastTurn();
    } finally {
      store.close();
    }
  };

  it("« out of memory » dans un tour multi-agents : le tour finit en erreur, le worker ne tombe pas", async () => {
    assignMultiAgentRoom();
    sendToFork(dir, 6, "Bonjour à tous", "key-memory-oom");
    // La base refuse d'écrire, comme le 17 nov. 2026 : toute écriture d'entrée échoue.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- rappelé avec `call(this, …)`.
    const add = SecondThreadStore.prototype.add;
    vi.spyOn(SecondThreadStore.prototype, "add").mockImplementation(function (
      this: SecondThreadStore,
      role,
      ...rest
    ) {
      if (role === "agent" || role === "event") throw new Error("out of memory");
      return add.call(this, role, ...rest);
    });
    const sleeps: number[] = [];
    const log: string[] = [];
    await expect(
      runForks({
        dataDir: dir,
        workspace,
        profile: () => "run",
        claudeProfile: () => "run",
        maxTurns: 1,
        telegramInbound: false,
        telegramReply: async () => undefined,
        freeMemory: () => 8 * 1024 * MB,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        log: (line) => log.push(line),
        claudeTurn: async () => ({
          outcome: "completed",
          text: "Réponse",
          tokens: 1,
          accepted: true,
          detail: null,
          retryAtMs: null,
          sessionId: "s",
        }),
      }),
    ).resolves.toBeUndefined();
    expect(log.some((l) => /Fork 6 : out of memory/.test(l))).toBe(true);
    expect(sleeps).toContain(OUT_OF_MEMORY_BACKOFF_MS);
    expect(lastTurn()?.outcome).toBe("error");
  }, 60_000);

  it("mémoire basse : le tour attend que la mémoire revienne, puis répond", async () => {
    assignMultiAgentRoom();
    sendToFork(dir, 6, "Bonjour à tous", "key-memory-low");
    const readings = [200, 200, 8192];
    const log: string[] = [];
    let called = 0;
    await runForks({
      dataDir: dir,
      workspace,
      profile: () => "run",
      claudeProfile: () => "run",
      maxTurns: 1,
      telegramInbound: false,
      telegramReply: async () => undefined,
      freeMemory: () => (readings.length > 1 ? readings.shift()! : readings[0]!) * MB,
      sleep: async () => {
        await new Promise((r) => setImmediate(r));
      },
      log: (line) => log.push(line),
      claudeTurn: async () => {
        called++;
        return {
          outcome: "completed",
          text: "SILENCE",
          tokens: 1,
          accepted: true,
          detail: null,
          retryAtMs: null,
          sessionId: "s",
        };
      },
    });
    expect(log.filter((l) => /Room 6 : mémoire basse/.test(l))).toHaveLength(1);
    expect(log.some((l) => /Room 6 : mémoire revenue/.test(l))).toBe(true);
    expect(called).toBeGreaterThan(0);
  }, 60_000);
});

describe("jobs de fond sous pression mémoire", () => {
  let dir: string;
  let manager: BackgroundJobs | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-memory-"));
    fs.mkdirSync(path.join(dir, "workspace", "jobs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "workspace", "jobs", "test.mjs"), "");
  });
  afterEach(async () => {
    await manager?.close();
    manager = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mémoire basse : le job reste en file, rien n'est lancé, une note au journal", async () => {
    const log: string[] = [];
    manager = new BackgroundJobs(dir, () => true, undefined, {
      log: (l) => log.push(l),
      memory: {
        check: () => ({
          wait: true,
          note: "mémoire basse (200 Mo disponibles sur 16384 Mo) : lancement différé.",
          reading: { freeMb: 200, totalMb: 16384, low: true },
        }),
      },
    });
    const job = manager.store.submit("lourd", "jobs/test.mjs", [], "job-memory-1");
    await manager.tick();
    expect(manager.store.get(job.id).status).toBe("queued");
    expect(manager.running.size).toBe(0);
    expect(log.some((l) => /jobs : mémoire basse/.test(l))).toBe(true);
  });
});
