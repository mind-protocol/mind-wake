/**
 * Porte F2 (SPEC §11) en processus réels, adapter factice SIMULÉ : démo à deux sessions
 * séparées par un redémarrage du daemon (A03), contrôles sur un daemon actif et kill
 * switch suivi d'un redémarrage (A06, A07), deux daemons concurrents (A05), crash du
 * daemon pendant une session et pendant un checkpoint (A08). Aucun appel modèle.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionId } from "../../src/contracts/index.js";
import { DaemonError, WakeDaemon, latestDaemonRun } from "../../src/daemon/index.js";
import { ProcessTreeSupervisor } from "../../src/runner/index.js";
import { acquireInstanceLock, instanceLockPath } from "../../src/scheduler/index.js";
import { SHARED_RUNTIME_DIR } from "../fixtures/runner/setup.js";
import {
  PROFILE,
  cli,
  countEvents,
  demoDir,
  killAllDaemons,
  profileState,
  readDb,
  seedSimulatedProfile,
  sleep,
  startDaemon,
  waitFor,
  type DemoDir,
} from "./harness.js";
import { RECHECK_MS, runSimulatedDemo } from "./scenario.js";

let dir: DemoDir;

beforeEach(() => {
  dir = demoDir();
});

afterEach(async () => {
  await killAllDaemons();
  dir.remove();
});

const DAEMON_ARGS = ["--simulated", "--recheck-ms", String(RECHECK_MS)];

describe("daemon run : refus au démarrage", () => {
  it("refuse sans --simulated : la policy désigne l'adapter factice", async () => {
    seedSimulatedProfile(dir.path);
    const run = await cli(dir.path, ["daemon", "run", "--json"]);
    expect(run.code).toBe(1);
    const out = JSON.parse(run.stdout) as {
      data: { started: boolean; refusal: { code: string } };
    };
    expect(out.data).toMatchObject({ started: false, refusal: { code: "runtime_mismatch" } });
    readDb(dir.path, (s) => {
      expect(profileState(s)).toBe("ready");
      expect(countEvents(s, "daemon_started")).toBe(0);
      expect(latestDaemonRun(s.db, PROFILE)).toBeNull();
    });
  }, 60_000);

  it("refuse sans profil, sur une policy non factice, ou si le verrou est pris", async () => {
    const base = { dataDir: dir.path, profileId: PROFILE, runtimeDir: SHARED_RUNTIME_DIR };
    const code = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn();
      } catch (error) {
        if (error instanceof DaemonError) return error.code;
        throw error;
      }
      return "opened";
    };
    expect(await code(() => WakeDaemon.open({ ...base, simulated: true }))).toBe("no_profile");
    seedSimulatedProfile(dir.path);
    const lock = acquireInstanceLock(instanceLockPath(dir.path, PROFILE));
    try {
      expect(await code(() => WakeDaemon.open({ ...base, simulated: true }))).toBe(
        "already_running",
      );
    } finally {
      lock.release();
    }
    const mismatched = demoDir("mind-wake-codex-");
    try {
      seedSimulatedProfile(mismatched.path, { runtimeAdapterId: "codex" });
      expect(
        await code(() => WakeDaemon.open({ ...base, dataDir: mismatched.path, simulated: true })),
      ).toBe("runtime_mismatch");
      // Mode réel : « codex » n'est pas enregistré dans ce build, aucun repli.
      expect(
        await code(() => WakeDaemon.open({ ...base, dataDir: mismatched.path, simulated: false })),
      ).toBe("real_adapter_missing");
    } finally {
      mismatched.remove();
    }
  }, 60_000);
});

describe("démo SIMULÉE à deux sessions, contrôles et kill switch (A03, A06, A07)", () => {
  it("reprend la même expérience après redémarrage, puis respecte priorité, pause et arrêt", async () => {
    seedSimulatedProfile(dir.path);
    const result = await runSimulatedDemo(dir.path);

    // A03 : deux sessions d'une même expérience, séparées par un redémarrage réel.
    const { report } = result;
    expect(report.simulated).toBe(true);
    expect(report.sessions.slice(0, 2).map((s) => s.outcome)).toEqual(["completed", "completed"]);
    expect(report.checkpoints.slice(0, 2).map((c) => c.sessionId)).toEqual([
      result.sessionA,
      result.sessionB,
    ]);
    expect(report.produced.artifacts.map((a) => a.path)).toEqual(
      expect.arrayContaining(["eca/rule30-w10.txt", "eca/rule30-w40.txt"]) as unknown,
    );
    expect(report.produced.observed.join("\n")).toMatch(/largeur=40 pas=256 : aucun état répété/);
    expect(report.failed.join("\n")).toMatch(/anneau de 10 cellules trop petit/);
    expect(report.hypothetical.length).toBeGreaterThan(0);
    expect(report.consumption.provenance).toBe("simulated");
    expect(result.reportText).toContain("SIMULÉS");
    readDb(dir.path, (s) => {
      const events = s.uow.journal.list(PROFILE);
      const chosen = events.filter((e) => e.type === "experiment_chosen");
      expect(chosen).toHaveLength(1);
      expect(chosen[0]?.sessionId).toBe(result.sessionA);
      const sessionB = s.uow.sessions.get(result.sessionB);
      expect(sessionB?.experimentId).toBe(result.experimentId);
      // Le daemon de la session B est un autre processus que celui de la session A.
      const pids = events
        .filter((e) => e.type === "daemon_started")
        .map((e) => (e.metadata as { pid: number }).pid);
      expect(new Set(pids.slice(0, 2)).size).toBe(2);
      // Aucune session en double : une réservation par session, aucune ouverte.
      expect(s.uow.sessions.listOpen(PROFILE)).toHaveLength(0);
      const reservations = s.db
        .prepare("SELECT status, count(*) AS n FROM reservations GROUP BY status")
        .all() as { status: string; n: number }[];
      expect(reservations.find((r) => r.status === "open")).toBeUndefined();
      const sessions = s.db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number };
      expect(sessions.n).toBe(countEvents(s, "budget_reserved"));
      for (const event of events.filter((e) => e.type === "session_ended")) {
        expect(event.metadata).toMatchObject({ simulated: true, provenance: "simulated" });
      }
    });

    // A06 / A07 : bornes documentées (ADR-003 : 1 s) et aucun réveil après l'arrêt.
    const m = result.measures;
    expect(m.userPriorityInDaemonMs).toBeLessThan(1_000);
    expect(m.pauseInDaemonMs).toBeLessThan(1_000);
    expect(m.stopInDaemonMs).toBeLessThan(1_000);
    expect(m.stopTreeTerminationMs ?? Infinity).toBeLessThan(1_000);
    expect(result.stopTerminationsConfirmed).toBe(true);
    expect(result.sessionsAfterStop).toBe(0);
    expect(result.finalState).toBe("stopped");
    expect(result.emergencyStopLocked).toBe(true);
    const resume = await cli(dir.path, ["resume", "--json"]);
    expect(resume.code).toBe(1);
    expect(resume.stdout).toContain("emergency_stop_locked");

    const status = await cli(dir.path, ["status", "--json"]);
    const data = (
      JSON.parse(status.stdout) as {
        data: {
          daemon: { state: string; mode: string };
          lastSession: { simulated: boolean };
          capabilities: { id: string; availability: string }[];
        };
      }
    ).data;
    // Le dernier daemon a été tué : exécution sans fin enregistrée.
    expect(data.daemon).toMatchObject({ state: "crashed", mode: "simulated" });
    expect(data.lastSession.simulated).toBe(true);
    const caps = Object.fromEntries(data.capabilities.map((c) => [c.id, c.availability]));
    expect(caps).toMatchObject({
      daemon: "simulated",
      simulated_adapter: "simulated",
      isolation: "blocked",
      runtime_adapter: "experimental",
    });
    console.info("Délais mesurés (ms) :", JSON.stringify(m));
  }, 240_000);
});

describe("deux daemons concurrents (A05)", () => {
  it("un seul prend le verrou ; l'autre refuse sans rien lancer", async () => {
    seedSimulatedProfile(dir.path, { minIntervalMs: 60_000 });
    const a = startDaemon(dir.path, DAEMON_ARGS, { MIND_WAKE_FAKE_SCENARIO: "slow" });
    const b = startDaemon(dir.path, DAEMON_ARGS, { MIND_WAKE_FAKE_SCENARIO: "slow" });
    const loser = await Promise.race([
      a.exited.then((r) => ({ who: "a", ...r })),
      b.exited.then((r) => ({ who: "b", ...r })),
    ]);
    expect(loser.code).toBe(1);
    expect(loser.stdout).toContain("already_running");
    await waitFor(dir.path, (s) => countEvents(s, "session_started") === 1, "une session");
    await sleep(RECHECK_MS * 2);
    readDb(dir.path, (s) => {
      expect(countEvents(s, "daemon_started")).toBe(1);
      expect(countEvents(s, "session_started")).toBe(1);
      expect(s.uow.sessions.listOpen(PROFILE)).toHaveLength(1);
      const open = s.db
        .prepare("SELECT count(*) AS n FROM reservations WHERE status = 'open'")
        .get() as { n: number };
      expect(open.n).toBe(1);
    });
  }, 120_000);
});

describe("crash du daemon (A08)", () => {
  async function crashDuring(
    scenario: string,
    reach: (dataDir: string) => Promise<void>,
  ): Promise<SessionId> {
    seedSimulatedProfile(dir.path);
    const daemon = startDaemon(dir.path, DAEMON_ARGS, { MIND_WAKE_FAKE_SCENARIO: scenario });
    await waitFor(dir.path, (s) => s.uow.sessions.listOpen(PROFILE).length === 1, "session");
    await reach(dir.path);
    const sessionId = readDb(dir.path, (s) => s.uow.sessions.listOpen(PROFILE)[0]?.id);
    if (sessionId === undefined) throw new Error("session déjà close");
    await daemon.kill();
    // Fin du canal de contrôle du lanceur : le Job Object de la session est terminé.
    const supervisor = new ProcessTreeSupervisor(SHARED_RUNTIME_DIR);
    let found: boolean | null = true;
    for (let i = 0; i < 100 && found !== false; i += 1) {
      found = supervisor.query(PROFILE, sessionId).found;
      if (found !== false) await sleep(20);
    }
    expect(found).toBe(false);
    readDb(dir.path, (s) => {
      expect(s.uow.sessions.listOpen(PROFILE)).toHaveLength(1);
      expect(latestDaemonRun(s.db, PROFILE)?.endedAt).toBeNull();
    });
    const status = await cli(dir.path, ["status", "--json"]);
    const daemonStatus = (JSON.parse(status.stdout) as { data: { daemon: { state: string } } }).data
      .daemon;
    expect(daemonStatus.state).toBe("crashed");
    return sessionId;
  }

  async function restartAndSettle(): Promise<void> {
    const restarted = startDaemon(dir.path, DAEMON_ARGS);
    await waitFor(dir.path, (s) => countEvents(s, "daemon_started") === 2, "redémarrage");
    await waitFor(dir.path, (s) => s.uow.sessions.listOpen(PROFILE).length === 0, "réconciliation");
    await sleep(RECHECK_MS * 2.5);
    await restarted.kill();
  }

  it("pendant une session : orpheline, réservation incertaine conservée, aucun relancement", async () => {
    const sessionId = await crashDuring("slow", async (d) => {
      await waitFor(d, (s) => countEvents(s, "usage_recorded") >= 2, "usage engagé");
    });
    await restartAndSettle();
    readDb(dir.path, (s) => {
      const session = s.uow.sessions.get(sessionId);
      expect(session?.outcome).toBe("orphaned");
      const reservation = s.uow.ledger.getReservation(session?.reservationId ?? ("" as never));
      expect(reservation?.status).toBe("uncertain");
      expect(profileState(s)).toBe("blocked");
      expect(countEvents(s, "session_started")).toBe(1);
      expect(
        s.uow.journal
          .list(PROFILE)
          .some(
            (e) =>
              e.type === "orphan_reconciled" &&
              (e.metadata as { replayed?: unknown }).replayed === false,
          ),
      ).toBe(true);
      const abandoned = s.uow.journal
        .list(PROFILE)
        .filter((e) => e.type === "daemon_started")
        .at(-1)?.metadata as { abandonedRuns: string[] };
      expect(abandoned.abandonedRuns).toHaveLength(1);
    });
  }, 120_000);

  it("pendant le checkpoint d'une pause : pause conservée, réservation incertaine", async () => {
    const sessionId = await crashDuring("stubborn", async (d) => {
      const pause = await cli(d, ["pause"]);
      expect(pause.code).toBe(0);
      await waitFor(d, (s) => profileState(s) === "checkpointing", "checkpointing");
    });
    await restartAndSettle();
    readDb(dir.path, (s) => {
      expect(s.uow.sessions.get(sessionId)?.outcome).toBe("orphaned");
      expect(profileState(s)).toBe("paused");
      const reservationId = s.uow.sessions.get(sessionId)?.reservationId;
      expect(s.uow.ledger.getReservation(reservationId ?? ("" as never))?.status).toBe("uncertain");
      expect(countEvents(s, "session_started")).toBe(1);
    });
  }, 120_000);
});
