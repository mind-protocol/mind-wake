/**
 * Commandes `pause`, `resume` et `stop` sur une base SQLite réelle. `stop` est aussi
 * exécuté dans un processus séparé pendant qu'un runner mène une session : il termine
 * l'arborescence par le nom de son job, sans l'aide du runner.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeScenario } from "../adapters/fake/index.js";
import {
  grantLaunch,
  isAlive,
  openBench,
  PROFILE,
  readPids,
  tempDir,
  waitFor,
  type Bench,
} from "../../test/fixtures/runner/setup.js";
import { DEFAULT_TERMINATION_TIMEOUT_MS } from "../runner/process-tree.js";
import { processContext, type CliContext } from "./context.js";
import { EXIT_FAILURE, EXIT_OK } from "./output.js";
import { runCli, USAGE } from "./run.js";

const ROOT = join(import.meta.dirname, "..", "..");
const HOOKS = pathToFileURL(join(ROOT, "test", "fixtures", "store-ledger", "ts-hooks.ts")).href;

let dir: ReturnType<typeof tempDir>;

beforeEach(() => {
  dir = tempDir();
});

afterEach(() => {
  dir.remove();
});

function context(): { ctx: CliContext; out: string[] } {
  const out: string[] = [];
  const ctx: CliContext = {
    ...processContext(),
    env: {},
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
  };
  return { ctx, out };
}

async function cli(...args: string[]): Promise<{ code: number; text: string; json: unknown }> {
  const { ctx, out } = context();
  const code = await runCli([...args, "--data-dir", dir.path], ctx);
  const text = out.join("");
  let json: unknown = null;
  if (args.includes("--json")) json = JSON.parse(text);
  return { code, text, json };
}

function withBench<T>(fn: (bench: Bench) => T): T {
  const bench = openBench(dir.path);
  try {
    return fn(bench);
  } finally {
    bench.close();
  }
}

describe("sans profil", () => {
  it("pause, resume et stop sont sans effet et ne créent aucune base", async () => {
    for (const command of ["pause", "resume", "stop"]) {
      const { code, text } = await cli(command);
      expect(code).toBe(EXIT_FAILURE);
      expect(text).toContain("mind-wake init");
    }
    expect(existsSync(join(dir.path, "control.sqlite"))).toBe(false);
  });

  it("l'aide liste les trois contrôles", () => {
    expect(USAGE).toMatch(/pause/);
    expect(USAGE).toMatch(/resume/);
    expect(USAGE).toMatch(/stop/);
  });
});

describe("aucune commande n'active l'exploration", () => {
  it("un profil désactivé reste désactivé après pause et resume", async () => {
    expect((await cli("init")).code).toBe(EXIT_OK);
    const paused = await cli("pause", "--json");
    expect(paused.code).toBe(EXIT_FAILURE);
    expect(paused.json).toMatchObject({
      ok: false,
      data: { status: "refused", state: "disabled" },
    });
    const resumed = await cli("resume", "--json");
    expect(resumed.json).toMatchObject({ data: { status: "refused", reason: "not_paused" } });
    withBench((bench) => {
      expect(bench.uow.profiles.get(PROFILE)?.state).toBe("disabled");
    });
  });

  it("stop verrouille même un profil désactivé ; resume est ensuite refusée", async () => {
    await cli("init");
    const stopped = await cli("stop", "--json");
    expect(stopped.code).toBe(EXIT_OK);
    expect(stopped.json).toMatchObject({
      schema: "mind-wake.cli",
      command: "stop",
      ok: true,
      data: { persisted: true, locked: true, previousState: "disabled", terminations: [] },
    });
    const resumed = await cli("resume");
    expect(resumed.code).toBe(EXIT_FAILURE);
    expect(resumed.text).toContain("emergency_stop_locked");
    withBench((bench) => {
      const profile = bench.uow.profiles.get(PROFILE);
      expect(profile?.state).toBe("disabled");
      expect(profile?.emergencyStopLocked).toBe(true);
    });
  });
});

describe("pause et reprise sans session", () => {
  it("pause supprime le prochain réveil ; resume revérifie la policy et rend le profil prêt", async () => {
    openBench(dir.path, {}).close();
    const paused = await cli("pause");
    expect(paused.code).toBe(EXIT_OK);
    expect(paused.text).toContain("Pause appliquée");
    withBench((b) => {
      const profile = b.uow.profiles.get(PROFILE);
      expect(profile?.state).toBe("paused");
      expect(profile?.nextWakeAt).toBeNull();
    });
    expect((await cli("pause", "--json")).json).toMatchObject({
      data: { status: "already_paused" },
    });
    const resumed = await cli("resume", "--json");
    expect(resumed.code).toBe(EXIT_OK);
    expect(resumed.json).toMatchObject({ ok: true, data: { status: "resumed", state: "ready" } });
    withBench((b) => {
      const types = b.uow.journal.list(PROFILE).map((e) => e.type);
      expect(types).toContain("pause_requested");
      expect(types.filter((t) => t === "profile_state_changed").length).toBe(2);
    });
  });
});

describe("réactivation après arrêt d'urgence", () => {
  it("stop verrouille ; resume reste refusée ; reactivate lève le verrou et rend le profil prêt", async () => {
    openBench(dir.path, {}).close();
    expect((await cli("stop")).code).toBe(EXIT_OK);
    expect((await cli("resume")).code).toBe(EXIT_FAILURE);
    const reactivated = await cli("reactivate", "--json");
    expect(reactivated.code).toBe(EXIT_OK);
    expect(reactivated.json).toMatchObject({
      ok: true,
      data: { status: "reactivated", state: "ready" },
    });
    withBench((b) => {
      const profile = b.uow.profiles.get(PROFILE);
      expect(profile?.state).toBe("ready");
      expect(profile?.emergencyStopLocked).toBe(false);
    });
    expect(existsSync(join(dir.path, "emergency-stop.flag"))).toBe(false);
    expect((await cli("reactivate", "--json")).json).toMatchObject({
      data: { status: "not_stopped" },
    });
  });
});

describe("stop depuis un autre processus pendant une session", () => {
  it("termine l'arborescence par le nom du job ; le runner clôt la session en kill_switch", async () => {
    const bench = openBench(dir.path, {});
    try {
      const pidFile = join(dir.path, "pids.txt");
      // Runner inerte (watchdog très lent) : seule la CLI peut terminer l'arborescence.
      const runner = bench.runner(fakeScenario("stubborn", { pidFile }), {
        watchdogIntervalMs: 600_000,
      });
      const running = await runner.launch(await grantLaunch(bench.uow, runner));
      await waitFor(() => readPids(pidFile).length >= 5);
      const pids = readPids(pidFile);

      const child = spawn(
        process.execPath,
        [
          "--experimental-transform-types",
          "--import",
          HOOKS,
          join(ROOT, "src", "cli", "main.ts"),
          "stop",
          "--json",
          "--data-dir",
          dir.path,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      expect(code).toBe(EXIT_OK);
      const envelope = JSON.parse(output) as {
        data: {
          persisted: boolean;
          terminations: { confirmed: boolean; processFound: boolean; elapsedMs: number }[];
        };
      };
      expect(envelope.data.persisted).toBe(true);
      expect(envelope.data.terminations).toHaveLength(1);
      const termination = envelope.data.terminations[0];
      expect(termination?.processFound).toBe(true);
      expect(termination?.confirmed).toBe(true);
      expect(termination?.elapsedMs).toBeLessThan(DEFAULT_TERMINATION_TIMEOUT_MS);
      expect(pids.filter(isAlive)).toEqual([]);
      console.info(
        `[mesure] stop CLI (autre processus) : terminaison par nom ${String(termination?.elapsedMs)} ms, lanceur compris`,
      );

      const result = await running.done;
      expect(result.outcome).toBe("interrupted");
      expect(result.reason).toBe("kill_switch");
      expect(bench.uow.profiles.get(PROFILE)).toMatchObject({
        state: "stopped",
        emergencyStopLocked: true,
        nextWakeAt: null,
      });
    } finally {
      bench.close();
    }
  }, 60_000);
});
