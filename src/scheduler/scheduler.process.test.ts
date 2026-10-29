/**
 * Preuves entre processus réels : verrou d'instance par profil, absence de double
 * lancement entre deux schedulers, redémarrage après la mort brutale d'un scheduler.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChildArgs } from "../../test/fixtures/scheduler/scheduler-child.js";
import {
  PROFILE,
  THURSDAY_10H_PARIS,
  bench,
  seedProfile,
} from "../../test/fixtures/scheduler/setup.js";
import { tempDir, type TempDir } from "../../test/fixtures/store-ledger/setup.js";
import { openStore } from "../store/index.js";
import { FakeClock } from "./clock.js";
import { InstanceLockError, acquireInstanceLock } from "./instance-lock.js";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures/", import.meta.url));
const HOOKS = pathToFileURL(join(FIXTURES, "store-ledger", "ts-hooks.ts")).href;
const CHILD = join(FIXTURES, "scheduler", "scheduler-child.ts");

let dir: TempDir;
const children: ChildProcess[] = [];

interface Running {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; stderr: string }>;
}

function start(args: Omit<ChildArgs, "dbPath" | "wallMs">): Running {
  const full: ChildArgs = { ...args, dbPath: dir.dbPath, wallMs: THURSDAY_10H_PARIS };
  const child = spawn(
    process.execPath,
    // `transform-types` : le journal (S5) utilise des propriétés de paramètre, que le
    // simple retrait de types de Node ne sait pas exécuter.
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-transform-types",
      "--import",
      HOOKS,
      CHILD,
      JSON.stringify(full),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  children.push(child);
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

async function waitFor(path: string, timeoutMs = 20_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`attente de ${path} expirée`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Le fichier peut être vu avant la fin de l'écriture : relire jusqu'à un JSON valide.
  for (;;) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function kill(running: Running): Promise<void> {
  running.child.kill("SIGKILL");
  await running.exited;
}

beforeEach(() => {
  dir = tempDir();
  const store = openStore(dir.dbPath);
  seedProfile(store.uow);
  store.close();
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
  dir.remove();
});

describe("scheduler entre processus réels", () => {
  it("un seul détenteur du verrou d'instance ; libéré à la mort du processus", async () => {
    const lockPath = join(dir.path, "profile.lock");
    const holder = start({
      mode: "hold-lock",
      lockPath,
      marker: join(dir.path, "holder.json"),
      idPrefix: "a",
    });
    await waitFor(join(dir.path, "holder.json"));

    expect(() => acquireInstanceLock(lockPath)).toThrow(InstanceLockError);
    const contender = start({
      mode: "tick",
      lockPath,
      marker: join(dir.path, "contender.json"),
      idPrefix: "b",
    });
    expect(await waitFor(join(dir.path, "contender.json"))).toEqual({ lockError: "held" });
    expect((await contender.exited).code).toBe(0);

    await kill(holder);
    const lock = acquireInstanceLock(lockPath);
    lock.release();
  }, 60_000);

  it("deux schedulers lancés ensemble sur la même base : une seule session", async () => {
    const go = join(dir.path, "go");
    const runs = ["a", "b"].map((id) =>
      start({
        mode: "tick",
        lockPath: join(dir.path, `${id}.lock`), // verrou volontairement distinct
        marker: join(dir.path, `${id}.json`),
        go,
        idPrefix: id,
      }),
    );
    // Attendre que les deux aient ouvert la base et pris leur verrou, puis libérer.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    writeFileSync(go, "");
    const results = await Promise.all(
      ["a", "b"].map((id) => waitFor(join(dir.path, `${id}.json`))),
    );
    for (const run of runs) {
      const { code, stderr } = await run.exited;
      expect(stderr).toBe("");
      expect(code).toBe(0);
    }
    expect(results.filter((r) => (r as { kind: string }).kind === "launched")).toHaveLength(1);

    const store = openStore(dir.dbPath);
    try {
      expect(store.uow.sessions.listOpen(PROFILE)).toHaveLength(1);
      const open = store.db
        .prepare("SELECT count(*) AS n FROM reservations WHERE status = 'open'")
        .get() as { n: number };
      expect(open.n).toBe(1);
    } finally {
      store.close();
    }
  }, 60_000);

  it("redémarrage après la mort brutale du scheduler : réconciliation, pas de relance", async () => {
    const lockPath = join(dir.path, "profile.lock");
    const crashed = start({
      mode: "tick-and-hang",
      lockPath,
      marker: join(dir.path, "first.json"),
      idPrefix: "a",
    });
    expect(await waitFor(join(dir.path, "first.json"))).toEqual({ kind: "launched" });
    expect(() => acquireInstanceLock(lockPath)).toThrow(InstanceLockError);
    await kill(crashed);

    const store = openStore(dir.dbPath);
    const b = bench(store, lockPath, {
      clock: new FakeClock(THURSDAY_10H_PARIS + 60_000),
      idPrefix: "r",
    });
    try {
      expect(store.uow.profiles.get(PROFILE)?.state).toBe("running");
      expect(await b.scheduler.recover()).toBe(true);
      expect(b.launcher.reconcileCalls).toBe(1);
      b.freshPriority();
      expect(await b.scheduler.tick()).toMatchObject({ kind: "inactive", state: "running" });
      expect(b.launcher.tickets).toHaveLength(0);
      expect(store.uow.sessions.listOpen(PROFILE)).toHaveLength(1);
    } finally {
      b.close();
      store.close();
    }
  }, 60_000);
});
