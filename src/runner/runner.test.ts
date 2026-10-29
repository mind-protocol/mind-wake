/**
 * Runner avec vrais processus enfants et petits-enfants, base SQLite réelle et
 * adapter factice. Délai de terminaison documenté : 1 s (ADR-003), mesuré ici.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeScenario } from "../adapters/fake/index.js";
import type { JournalEvent, UnitOfWork } from "../contracts/index.js";
import { decideLaunch, revokePermissions } from "../policy/index.js";
import {
  allowDecision,
  grantLaunch,
  isAlive,
  openBench,
  PROFILE,
  readPids,
  REVISION,
  tempDir,
  waitFor,
  type Bench,
} from "../../test/fixtures/runner/setup.js";
import { DEFAULT_TERMINATION_TIMEOUT_MS } from "./process-tree.js";
import { RunnerError } from "./runner.js";

const PROCESS_TIMEOUT = 30_000;
const FIXTURES = join(import.meta.dirname, "..", "..", "test", "fixtures");
const HOOKS = pathToFileURL(join(FIXTURES, "store-ledger", "ts-hooks.ts")).href;

let dir: ReturnType<typeof tempDir>;
let bench: Bench;

beforeEach(() => {
  dir = tempDir();
  bench = openBench(dir.path, {});
});

afterEach(() => {
  bench.close();
  dir.remove();
});

function types(uow: UnitOfWork): string[] {
  return uow.journal.list(PROFILE).map((e) => e.type);
}

function events(uow: UnitOfWork, type: string): JournalEvent[] {
  return uow.journal.list(PROFILE).filter((e) => e.type === type);
}

describe("lancement sur réservation", () => {
  it(
    "scénario succès : décision par action, usage simulé rapproché, profil en hibernation",
    async () => {
      const runner = bench.runner(fakeScenario("success"));
      const grant = await grantLaunch(bench.uow, runner);
      expect(grant.decision.verdict).toBe("allow");
      const running = await runner.launch(grant);
      expect(bench.uow.profiles.get(PROFILE)?.state).toBe("running");
      const result = await running.done;

      expect(result.outcome).toBe("completed");
      expect(result.tokens).toBe(150);
      expect(result.provenance).toBe("simulated");
      expect(result.checkpointCandidates).toBe(1);
      expect(result.reservationStatus).toBe("reconciled");
      expect(result.profileState).toBe("hibernating");
      const allowed = events(bench.uow, "action_allowed");
      expect(allowed).toHaveLength(1);
      expect(allowed[0]?.metadata["kind"]).toBe("file_write");
      expect(bench.uow.sessions.get(grant.sessionId)?.outcome).toBe("completed");
      const period = bench.uow.ledger.ensurePeriod(
        PROFILE,
        { kind: "day", timeZone: "Europe/Paris" as never },
        new Date().toISOString() as never,
        [
          { unit: "tokens", cap: 10_000, userReserve: 2_000 },
          { unit: "sessions", cap: 5, userReserve: 0 },
        ],
      );
      const tokens = bench.uow.ledger.availability(period.id, "tokens");
      expect(tokens.reconciled).toBe(150);
      expect(tokens.reconciledByProvenance?.simulated).toBe(150);
      expect(tokens.reconciledByProvenance?.measured).toBe(0);
      const started = events(bench.uow, "session_started")[0];
      expect(started?.metadata["simulated"]).toBe(true);
    },
    PROCESS_TIMEOUT,
  );

  it(
    "une action hors permissions est refusée et journalisée, la session continue",
    async () => {
      bench.close();
      dir.remove();
      dir = tempDir();
      bench = openBench(dir.path, { filesAndTools: { writeRoots: [] } });
      const runner = bench.runner(fakeScenario("success"));
      const result = await (await runner.launch(await grantLaunch(bench.uow, runner))).done;
      expect(result.outcome).toBe("completed");
      const denied = events(bench.uow, "action_denied");
      expect(denied).toHaveLength(1);
      expect(denied[0]?.reason).toBe("permission_not_granted");
      expect(denied[0]?.metadata["detail"]).toBe("file_write.outside_roots");
    },
    PROCESS_TIMEOUT,
  );

  it("refuse une décision négative, une réservation absente ou un profil non prêt", async () => {
    const runner = bench.runner(fakeScenario("success"));
    const grant = await grantLaunch(bench.uow, runner);
    await expect(
      runner.launch({
        ...grant,
        decision: { verdict: "deny", revisionId: REVISION, reason: "paused", detail: "x" },
      }),
    ).rejects.toMatchObject({ code: "launch_not_allowed" });
    await expect(
      runner.launch({ ...grant, reservationId: "absente" as never }),
    ).rejects.toMatchObject({ code: "reservation_not_open" });
    runner.pause();
    await expect(runner.launch(grant)).rejects.toBeInstanceOf(RunnerError);
    expect(bench.uow.sessions.listOpen(PROFILE)).toHaveLength(0);
  });
});

describe("kill switch", () => {
  it(
    "persiste stopped verrouillé, termine enfants et petits-enfants sous 1 s, puis redémarrage sans réveil",
    async () => {
      const pidFile = join(dir.path, "pids.txt");
      const runner = bench.runner(fakeScenario("stubborn", { pidFile }));
      const grant = await grantLaunch(bench.uow, runner);
      const running = await runner.launch(grant);
      // Agent + 2 enfants + 2 petits-enfants.
      await waitFor(() => readPids(pidFile).length >= 5);
      const pids = readPids(pidFile);
      expect(pids.every(isAlive)).toBe(true);

      const report = await runner.stop();
      expect(report.persistence.persisted).toBe(true);
      expect(report.termination?.confirmed).toBe(true);
      expect(report.termination?.elapsedMs).toBeLessThan(DEFAULT_TERMINATION_TIMEOUT_MS);
      expect(report.elapsedMs).toBeLessThan(DEFAULT_TERMINATION_TIMEOUT_MS);
      expect(pids.filter(isAlive)).toEqual([]);
      console.info(
        `[mesure] kill switch en processus : décision→arborescence terminée ${report.termination?.elapsedMs.toFixed(1) ?? "?"} ms (noyau ${String(report.termination?.kernelMs)} ms), total persistance comprise ${report.elapsedMs.toFixed(1)} ms`,
      );

      const result = await running.done;
      expect(result.outcome).toBe("interrupted");
      expect(result.reason).toBe("kill_switch");
      const profile = bench.uow.profiles.get(PROFILE);
      expect(profile?.state).toBe("stopped");
      expect(profile?.emergencyStopLocked).toBe(true);
      expect(profile?.nextWakeAt).toBeNull();
      const log = types(bench.uow);
      expect(log.indexOf("kill_switch_triggered")).toBeLessThan(log.indexOf("session_ended"));

      // Redémarrage : nouveau runner, nouvel adapter, même base.
      const restarted = bench.runner(fakeScenario("success"));
      const startup = restarted.reconcileAtStartup();
      expect(startup.orphans).toEqual([]);
      expect(bench.uow.profiles.get(PROFILE)?.state).toBe("stopped");
      const relaunch = decideLaunch(bench.uow.policies, PROFILE, {
        profile: { state: "stopped", emergencyStopLocked: true },
      });
      expect(relaunch).toMatchObject({ verdict: "deny", reason: "stopped" });
      await expect(
        restarted.launch({ ...grant, sessionId: "autre" as never, decision: allowDecision() }),
      ).rejects.toMatchObject({ code: "profile_not_ready" });
      expect(restarted.resume()).toMatchObject({
        status: "refused",
        reason: "emergency_stop_locked",
      });
      expect(bench.uow.sessions.listOpen(PROFILE)).toHaveLength(0);
      expect(events(bench.uow, "session_started")).toHaveLength(1);
    },
    PROCESS_TIMEOUT,
  );

  it(
    "termine même si la persistance échoue, puis impose une récupération conservatrice",
    async () => {
      const pidFile = join(dir.path, "pids.txt");
      let failing = false;
      const fail = (): never => {
        throw new Error("disque plein (simulé)");
      };
      const guard = <T extends object>(repo: T): T =>
        new Proxy(repo, {
          get(target, prop, receiver) {
            const value: unknown = Reflect.get(target, prop, receiver);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) =>
              failing ? fail() : (value as (...a: unknown[]) => unknown).apply(target, args);
          },
        });
      const inner = bench.uow;
      const flaky: UnitOfWork = {
        profiles: guard(inner.profiles),
        policies: inner.policies,
        experiments: inner.experiments,
        sessions: guard(inner.sessions),
        ledger: guard(inner.ledger),
        journal: guard(inner.journal),
        checkpoints: inner.checkpoints,
        transaction: (fn) => (failing ? fail() : inner.transaction(() => fn(flaky))),
      };
      const runner = bench.runner(fakeScenario("stubborn", { pidFile }), {}, flaky);
      const grant = await grantLaunch(bench.uow, runner);
      const running = await runner.launch(grant);
      await waitFor(() => readPids(pidFile).length >= 5);
      const pids = readPids(pidFile);

      failing = true;
      const report = await runner.stop();
      expect(report.persistence.persisted).toBe(false);
      expect(report.persistence.flagWritten).toBe(true);
      expect(report.termination?.confirmed).toBe(true);
      expect(pids.filter(isAlive)).toEqual([]);
      const result = await running.done;
      expect(result.persistenceError).toBeDefined();
      expect(bench.stopFlag.exists()).toBe(true);

      // Redémarrage : la base est de nouveau accessible.
      failing = false;
      const restarted = bench.runner(fakeScenario("success"));
      await expect(restarted.launch({ ...grant, decision: allowDecision() })).rejects.toMatchObject(
        { code: "emergency_stop_pending" },
      );
      const startup = restarted.reconcileAtStartup();
      expect(startup.emergencyStopRecovered).toBe(true);
      expect(startup.orphans).toHaveLength(1);
      expect(startup.orphans[0]?.reservationStatus).toBe("uncertain");
      expect(bench.stopFlag.exists()).toBe(false);
      const profile = bench.uow.profiles.get(PROFILE);
      expect(profile?.state).toBe("stopped");
      expect(profile?.emergencyStopLocked).toBe(true);
      expect(bench.uow.sessions.get(grant.sessionId)?.outcome).toBe("orphaned");
      expect(bench.uow.ledger.getReservation(grant.reservationId)?.status).toBe("uncertain");
    },
    PROCESS_TIMEOUT,
  );

  it(
    "mesure répétée : cinq arrêts d'urgence d'une arborescence de cinq processus",
    async () => {
      const samples: number[] = [];
      const kernel: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const round = tempDir();
        const local = openBench(round.path, {});
        try {
          const pidFile = join(round.path, "pids.txt");
          const runner = local.runner(fakeScenario("stubborn", { pidFile }));
          const running = await runner.launch(await grantLaunch(local.uow, runner));
          await waitFor(() => readPids(pidFile).length >= 5);
          const pids = readPids(pidFile);
          const report = await runner.stop();
          expect(report.termination?.confirmed).toBe(true);
          expect(pids.filter(isAlive)).toEqual([]);
          samples.push(report.termination?.elapsedMs ?? Number.NaN);
          kernel.push(report.termination?.kernelMs ?? Number.NaN);
          await running.done;
        } finally {
          local.close();
          round.remove();
        }
      }
      const sorted = [...samples].sort((a, b) => a - b);
      console.info(
        `[mesure] kill switch ×5 : médiane ${sorted[2]?.toFixed(1) ?? "?"} ms, max ${sorted[4]?.toFixed(1) ?? "?"} ms ; noyau ${kernel.map((k) => k.toFixed(1)).join(", ")} ms`,
      );
      expect(Math.max(...samples)).toBeLessThan(DEFAULT_TERMINATION_TIMEOUT_MS);
    },
    PROCESS_TIMEOUT * 3,
  );
});

describe("interruptions pendant la session", () => {
  it(
    "révocation de permission pendant une session active : interruption sans checkpoint",
    async () => {
      const pidFile = join(dir.path, "pids.txt");
      const runner = bench.runner(fakeScenario("slow", { pidFile }));
      const running = await runner.launch(await grantLaunch(bench.uow, runner));
      await waitFor(() => events(bench.uow, "action_allowed").length >= 2);
      const pids = readPids(pidFile);
      const revoked = revokePermissions(
        { policies: bench.uow.policies, journal: bench.uow.journal },
        { profileId: PROFILE, at: new Date().toISOString() as never, reason: "révocation humaine" },
      );
      expect(revoked.status).toBe("revoked");
      const result = await running.done;
      expect(result.outcome).toBe("interrupted");
      expect(result.reason).toMatch(/^policy\.revoked/);
      expect(result.checkpointCandidates).toBe(0);
      expect(result.profileState).toBe("blocked");
      expect(pids.filter(isAlive)).toEqual([]);
      const log = types(bench.uow);
      // Aucune action accordée après la révocation.
      const after = log.slice(log.indexOf("permission_revoked"));
      expect(after).not.toContain("action_allowed");
    },
    PROCESS_TIMEOUT,
  );

  it(
    "pause : plus de réveil, checkpoint demandé, profil en pause ; reprise explicite",
    async () => {
      const runner = bench.runner(fakeScenario("slow"));
      const running = await runner.launch(await grantLaunch(bench.uow, runner));
      await waitFor(() => events(bench.uow, "action_allowed").length >= 1);
      expect(runner.pause().status).toBe("pause_requested");
      expect(bench.uow.profiles.get(PROFILE)?.nextWakeAt).toBeNull();
      const result = await running.done;
      expect(result.outcome).toBe("interrupted");
      expect(result.reason).toBe("user.pause");
      expect(result.checkpointCandidates).toBe(1);
      expect(result.profileState).toBe("paused");
      expect(result.reservationStatus).toBe("reconciled");
      expect(runner.resume()).toMatchObject({ status: "resumed", state: "ready" });
    },
    PROCESS_TIMEOUT,
  );

  it(
    "pause d'un agent qui ignore la demande : terminé à l'expiration du délai de grâce",
    async () => {
      const pidFile = join(dir.path, "pids.txt");
      const runner = bench.runner(fakeScenario("stubborn", { pidFile }), {
        checkpointGraceMs: 300,
      });
      const running = await runner.launch(await grantLaunch(bench.uow, runner));
      await waitFor(() => readPids(pidFile).length >= 5);
      const begin = Date.now();
      runner.pause();
      const result = await running.done;
      expect(Date.now() - begin).toBeLessThan(300 + DEFAULT_TERMINATION_TIMEOUT_MS + 500);
      expect(result.reason).toBe("user.pause");
      expect(result.checkpointCandidates).toBe(0);
      expect(result.profileState).toBe("paused");
      expect(readPids(pidFile).filter(isAlive)).toEqual([]);
    },
    PROCESS_TIMEOUT,
  );

  it(
    "approche du plafond de tokens : checkpoint demandé dans l'enveloppe restante",
    async () => {
      const runner = bench.runner(fakeScenario("slow"));
      const running = await runner.launch(await grantLaunch(bench.uow, runner, 150));
      const result = await running.done;
      expect(result.reason).toBe("budget.checkpoint_reserve_reached");
      expect(result.tokens).toBeGreaterThanOrEqual(50);
      expect(result.tokens).toBeLessThan(150);
      expect(result.checkpointCandidates).toBe(1);
      expect(result.profileState).toBe("hibernating");
    },
    PROCESS_TIMEOUT,
  );
});

describe("scénarios de l'adapter factice", () => {
  it(
    "limitation fournisseur : interruption et hibernation, aucune nouvelle tentative",
    async () => {
      const runner = bench.runner(fakeScenario("rate_limited"));
      const result = await (await runner.launch(await grantLaunch(bench.uow, runner))).done;
      expect(result.outcome).toBe("interrupted");
      expect(result.reason).toBe("provider.rate_limited");
      expect(result.profileState).toBe("hibernating");
      expect(events(bench.uow, "rate_limited")[0]?.metadata["retryAfterMs"]).toBe(60_000);
      expect(events(bench.uow, "session_started")).toHaveLength(1);
    },
    PROCESS_TIMEOUT,
  );

  it(
    "erreur d'authentification : échec et profil bloqué",
    async () => {
      const runner = bench.runner(fakeScenario("auth_error"));
      const result = await (await runner.launch(await grantLaunch(bench.uow, runner))).done;
      expect(result.outcome).toBe("failed");
      expect(result.reason).toBe("adapter.auth_failed");
      expect(result.profileState).toBe("blocked");
    },
    PROCESS_TIMEOUT,
  );

  it(
    "crash de l'agent : échec, descendance terminée, usage simulé rapproché",
    async () => {
      const pidFile = join(dir.path, "pids.txt");
      const runner = bench.runner(fakeScenario("crash", { pidFile }));
      const result = await (await runner.launch(await grantLaunch(bench.uow, runner))).done;
      expect(result.outcome).toBe("failed");
      expect(result.reason).toBe("process.exited_without_end: code=70");
      expect(result.reservationStatus).toBe("reconciled");
      expect(result.tokens).toBe(50);
      const pids = readPids(pidFile);
      expect(pids.length).toBeGreaterThanOrEqual(3);
      await waitFor(() => pids.every((pid) => !isAlive(pid)), 2_000);
    },
    PROCESS_TIMEOUT,
  );
});

describe("crash du daemon et réconciliation au démarrage", () => {
  it(
    "daemon tué pendant la session : descendance terminée, session orpheline, réservation incertaine, rien de rejoué",
    async () => {
      const pidFile = join(dir.path, "pids.txt");
      const scenario = fakeScenario("slow", { pidFile });
      const preparer = bench.runner(scenario);
      const grant = await grantLaunch(bench.uow, preparer);
      const encode = (value: unknown): string =>
        Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
      const child = spawn(
        process.execPath,
        [
          // Le journal (S5) emploie des propriétés de paramètres : transformation requise.
          "--experimental-transform-types",
          "--import",
          HOOKS,
          join(FIXTURES, "runner", "daemon-child.ts"),
          dir.path,
          encode(scenario),
          encode(grant),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      await waitFor(() => output.includes("launched") && readPids(pidFile).length >= 3, 20_000);
      const pids = readPids(pidFile);
      expect(pids.every(isAlive)).toBe(true);

      const killedAt = performance.now();
      child.kill("SIGKILL");
      await waitFor(() => pids.every((pid) => !isAlive(pid)), 5_000, 2);
      const gone = performance.now() - killedAt;
      console.info(
        `[mesure] daemon tué : arborescence terminée en ${gone.toFixed(1)} ms (fin du canal de contrôle du lanceur)`,
      );
      expect(gone).toBeLessThan(DEFAULT_TERMINATION_TIMEOUT_MS);
      expect(bench.uow.sessions.listOpen(PROFILE)).toHaveLength(1);

      const restarted = bench.runner(fakeScenario("success"));
      const startup = restarted.reconcileAtStartup();
      expect(startup.orphans).toHaveLength(1);
      expect(startup.orphans[0]?.processFound).toBe(false);
      expect(startup.orphans[0]?.reservationStatus).toBe("uncertain");
      expect(bench.uow.sessions.get(grant.sessionId)).toMatchObject({ outcome: "orphaned" });
      expect(bench.uow.ledger.getReservation(grant.reservationId)?.status).toBe("uncertain");
      expect(bench.uow.profiles.get(PROFILE)?.state).toBe("blocked");
      expect(events(bench.uow, "orphan_reconciled")[0]?.metadata["replayed"]).toBe(false);
      expect(events(bench.uow, "session_started")).toHaveLength(1);
      expect(restarted.activeSessionId).toBeNull();
      // Une seconde réconciliation ne change rien.
      expect(restarted.reconcileAtStartup().orphans).toEqual([]);
    },
    PROCESS_TIMEOUT,
  );
});
