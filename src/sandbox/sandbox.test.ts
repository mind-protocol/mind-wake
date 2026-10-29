/**
 * Tests de refus réels (A09) sur le poste : AppContainer sans capacité + Job Object, sans
 * droits administrateur. Chaque refus vient du système (code Windows rapporté par la
 * sonde native exécutée dans le conteneur). Profils AppContainer éphémères et ACE de test
 * sur des dossiers temporaires, retirés et vérifiés après chaque test, même en échec.
 */

import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isAlive, waitFor } from "../../test/fixtures/runner/setup.js";
import {
  ephemeralProfileName,
  runIsolationSelfTest,
  Sandbox,
  SandboxSpecError,
  type IsolationSelfTestReport,
  type SandboxedProcess,
} from "./index.js";

const WINDOWS = process.platform === "win32";
const TIMEOUT = 60_000;
/** Borne de terminaison proposée pour G1 (ADR-003). */
const BOUND_MS = 1_000;

describe.runIf(WINDOWS)("autotest de refus (A09)", () => {
  let report: IsolationSelfTestReport;
  let dnsControl: boolean;

  beforeAll(async () => {
    // Témoin hors conteneur : le nom se résout depuis le daemon (sinon poste hors ligne).
    dnsControl = await lookup("example.com").then(
      () => true,
      () => false,
    );
    report = await runIsolationSelfTest({
      externalNetwork: { tcp: "1.1.1.1:443", dnsName: "example.com" },
    });
  }, TIMEOUT);

  const check = (id: string) => {
    const found = report.checks.find((c) => c.id === id);
    if (found === undefined) throw new Error(`vérification absente : ${id}`);
    return found;
  };

  it("réussit sur ce poste, nettoyage compris", () => {
    expect(report.error).toBeUndefined();
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.cleanup).toEqual({ aclRemoved: true, profileRemoved: true, tempRemoved: true });
  });

  it("accorde la racine de travail et seulement elle", () => {
    expect(check("write_inside_root")).toMatchObject({ outcome: "allowed", code: 0 });
    expect(check("read_inside_root")).toMatchObject({ outcome: "allowed", code: 0 });
    for (const id of [
      "write_outside_root",
      "read_secret_outside_root",
      "list_outside_root",
      "write_user_temp",
    ]) {
      expect(check(id), id).toMatchObject({ outcome: "denied", code: 5 });
    }
    expect(check("outside_unchanged").passed).toBe(true);
  });

  it("refuse les sorties par jonction et hardlink", () => {
    for (const id of [
      "read_via_junction",
      "write_via_junction",
      "create_junction",
      "create_hardlink",
    ]) {
      expect(check(id), id).toMatchObject({ outcome: "denied", code: 5 });
    }
  });

  it("symlink préexistant : refusé, ou non démontrable sans privilège (documenté)", () => {
    const symlink = report.checks.find((c) => c.id === "read_via_symlink");
    if (symlink === undefined) {
      expect(report.notDemonstrated.join(" ")).toContain("symlink préexistant");
    } else {
      expect(symlink).toMatchObject({ outcome: "denied", code: 5 });
    }
  });

  it("refuse lecture et écriture de la base de contrôle SQLite", () => {
    expect(check("write_control_db")).toMatchObject({ outcome: "denied", code: 5 });
    expect(check("read_control_db")).toMatchObject({ outcome: "denied", code: 5 });
  });

  it("ferme le réseau : loopback, TCP externe, DNS, pipe étranger", () => {
    expect(check("tcp_loopback").outcome).toBe("denied");
    expect(check("loopback_connections_accepted").passed).toBe(true);
    expect(check("tcp_external")).toMatchObject({ outcome: "denied", code: 10013 });
    if (dnsControl) expect(check("dns_external").outcome).toBe("denied");
    expect(check("foreign_pipe")).toMatchObject({ outcome: "denied", code: 5 });
    expect(check("foreign_pipe_connections_accepted").passed).toBe(true);
  });

  it("laisse passer le seul canal broker, relayé hors du conteneur", () => {
    expect(check("broker_pipe")).toMatchObject({ outcome: "allowed", passed: true });
  });

  it("n'hérite d'aucun secret et ne peut ouvrir ni le daemon ni le registre utilisateur", () => {
    expect(check("parent_env_secret").outcome).toBe("denied");
    expect(check("open_daemon_process")).toMatchObject({ outcome: "denied", code: 5 });
    expect(check("registry_write")).toMatchObject({ outcome: "denied", code: 5 });
  });

  it("impose le job : pas de breakaway, limites de mémoire et de processus", () => {
    expect(check("job_breakaway")).toMatchObject({ outcome: "denied", code: 5 });
    expect(check("job_memory_limit")).toMatchObject({ outcome: "denied", code: 8 });
    expect(check("job_process_limit")).toMatchObject({ outcome: "denied", code: 1816 });
  });

  it("termine l'arborescence (enfant, petit-enfant) dans la borne, sans survivant", () => {
    expect(report.termination).toMatchObject({ confirmed: true, survivors: 0, treeSize: 3 });
    expect(report.termination?.elapsedMs).toBeLessThan(BOUND_MS);
  });
});

describe.runIf(WINDOWS)("lanceur confiné", () => {
  let base: string;
  let root: string;
  let runtime: string;
  let control: string;
  let probe: string;
  let sandbox: Sandbox;
  const profiles: Sandbox[] = [];

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "mindwake-sandbox-test-"));
    root = path.join(base, "root");
    runtime = path.join(base, "runtime");
    control = path.join(base, "control");
    for (const dir of [root, runtime, control]) fs.mkdirSync(dir);
    const builder = new Sandbox(path.join(base, "build"), ephemeralProfileName("mindwake.test"));
    if (!builder.status.available) throw new Error(builder.status.reason);
    probe = path.join(runtime, "probe.exe");
    fs.copyFileSync(builder.status.launcherPath, probe);
  });

  afterEach(() => {
    // Nettoyage vérifié après chaque test, qu'il ait réussi ou échoué.
    for (const s of profiles.splice(0)) {
      s.revoke({ readWrite: [root], readOnly: [runtime] });
      expect(s.aclStatus({ readWrite: [root], readOnly: [runtime] })).toEqual([
        { path: root, exists: true, granted: false },
        { path: runtime, exists: true, granted: false },
      ]);
      expect(s.deleteProfile()).toMatchObject({
        exists: false,
        registryMapping: false,
        folder: false,
      });
    }
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    expect(fs.existsSync(base)).toBe(false);
  });

  function fresh(): Sandbox {
    sandbox = new Sandbox(path.join(base, "build"), ephemeralProfileName("mindwake.test"));
    profiles.push(sandbox);
    sandbox.ensureProfile();
    return sandbox;
  }

  function launchTree(s: Sandbox, tail: string): SandboxedProcess {
    return s.launch({
      jobName: `Local\\mindwake-test-${randomBytes(8).toString("hex")}`,
      executable: probe,
      args: ["probe", "spawn:tree", tail],
      readWriteRoots: [root],
      readOnlyRoots: [runtime],
      protectedPaths: [control],
      maxWallMs: 30_000,
    });
  }

  async function treePids(proc: SandboxedProcess): Promise<number[]> {
    const pids = [await proc.started()];
    while (pids.length < 3) {
      const line = await proc.readLine();
      if (line === null) break;
      const match = /"op":"(?:spawn|grandchild)".*"pid":(\d+)/.exec(line);
      if (match !== null) pids.push(Number(match[1]));
    }
    return pids;
  }

  it(
    "kill switch ×5 : arborescence terminée dans la borne, délais mesurés",
    async () => {
      const s = fresh();
      const elapsed: number[] = [];
      const kernel: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const proc = launchTree(s, "sleep:60000");
        const pids = await treePids(proc);
        expect(pids.filter(isAlive)).toHaveLength(3);
        const result = await proc.terminateTree(BOUND_MS);
        expect(result).toMatchObject({ confirmed: true, via: "kill_command" });
        elapsed.push(result.elapsedMs);
        if (result.kernelMs !== null) kernel.push(result.kernelMs);
        expect(pids.filter(isAlive)).toEqual([]);
        expect((await proc.exited).aclRevoked).toBe(true);
      }
      expect(Math.max(...elapsed)).toBeLessThan(BOUND_MS);
      console.info(
        `terminaison ×5 : ${elapsed.map((ms) => ms.toFixed(1)).join(", ")} ms ; noyau ${kernel.map((ms) => ms.toFixed(1)).join(", ")} ms`,
      );
    },
    TIMEOUT,
  );

  it(
    "fin du processus principal : ses descendants sont terminés",
    async () => {
      const proc = launchTree(fresh(), "sleep:300");
      const pids = await treePids(proc);
      const exit = await proc.exited;
      expect(exit.killReason).toBe("main-exited");
      await waitFor(() => pids.every((pid) => !isAlive(pid)), 2_000);
    },
    TIMEOUT,
  );

  it(
    "lanceur tué brutalement : le noyau termine le job, le filet retire les ACE",
    async () => {
      const s = fresh();
      const proc = launchTree(s, "sleep:60000");
      const pids = await treePids(proc);
      const begin = performance.now();
      proc.killLauncher();
      await waitFor(() => pids.every((pid) => !isAlive(pid)), BOUND_MS, 1);
      const ms = performance.now() - begin;
      const exit = await proc.exited;
      expect(exit.killReason).toBe("launcher_lost");
      expect(exit.aclRevoked).toBe(true);
      expect(s.aclStatus({ readWrite: [root], readOnly: [runtime] }).some((a) => a.granted)).toBe(
        false,
      );
      console.info(`lanceur tué : arborescence disparue en ${ms.toFixed(1)} ms`);
    },
    TIMEOUT,
  );

  it(
    "échec au lancement (exécutable illisible) : ACE retirées quand même",
    async () => {
      const s = fresh();
      const missing = path.join(runtime, "absent.exe");
      const proc = s.launch({
        jobName: `Local\\mindwake-test-${randomBytes(8).toString("hex")}`,
        executable: missing,
        args: [],
        readWriteRoots: [root],
        readOnlyRoots: [runtime],
        protectedPaths: [control],
      });
      await expect(proc.started()).rejects.toThrow(/CreateProcess 2/);
      expect((await proc.exited).aclRevoked).toBe(true);
    },
    TIMEOUT,
  );

  it("refuse une racine qui contient la base de contrôle, avant tout appel système", () => {
    const s = new Sandbox(path.join(base, "build"), ephemeralProfileName("mindwake.test"));
    const db = path.join(control, "wake.sqlite");
    new Database(db).close();
    expect(() =>
      s.launch({
        jobName: "Local\\mindwake-test-refused",
        executable: probe,
        args: [],
        readWriteRoots: [base],
        readOnlyRoots: [runtime],
        protectedPaths: [db],
      }),
    ).toThrow(SandboxSpecError);
    expect(s.profileStatus().exists).toBe(false);
  });

  it(
    "autotest en échec (borne impossible) : nettoyage complet quand même",
    async () => {
      const before = new Set(fs.readdirSync(os.tmpdir()));
      const failed = await runIsolationSelfTest({ terminationBoundMs: 0 });
      expect(failed.passed).toBe(false);
      expect(failed.checks.find((c) => c.id === "grandchild_survives_kill")?.passed).toBe(false);
      expect(failed.cleanup).toEqual({ aclRemoved: true, profileRemoved: true, tempRemoved: true });
      const leaked = fs
        .readdirSync(os.tmpdir())
        .filter((name) => name.startsWith("mindwake-selftest-") && !before.has(name));
      expect(leaked).toEqual([]);
      const leftover = new Sandbox(path.join(base, "build"), failed.profile ?? "x");
      expect(leftover.profileStatus().exists).toBe(false);
    },
    TIMEOUT,
  );
});

describe("hors Windows", () => {
  it("l'autotest échoue sans rien créer", async () => {
    const report = await runIsolationSelfTest({ platform: "linux" });
    expect(report).toMatchObject({ passed: false, checks: [], cleanup: null });
  });

  it("le lanceur se déclare indisponible", () => {
    const s = new Sandbox(os.tmpdir(), ephemeralProfileName(), "linux");
    expect(s.available).toBe(false);
    expect(s.health().operational).toBe(false);
  });
});
