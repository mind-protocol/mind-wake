import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AdapterEvent,
  PolicyRevision,
  ReservationId,
  SessionId,
  UtcTimestamp,
} from "../../contracts/index.js";
import type { ContainedExit } from "../../runner/process-tree.js";
import { GeminiAdapter, type GeminiAdapterOptions } from "./gemini-adapter.js";
import {
  GeminiLaunchRefused,
  type GeminiLaunchPort,
  type GeminiLaunchSpec,
  type GeminiProcess,
  type IsolationVerdict,
  type ProviderTransportPort,
} from "./launch.js";

const FAKE_GEMINI = fileURLToPath(
  new URL("../../../test/fixtures/gemini/fake-gemini.ts", import.meta.url),
);

/** Processus enfant direct : remplace la sandbox pour rejouer le faux exécutable. */
function directProcess(spec: GeminiLaunchSpec, scenario: string): GeminiProcess {
  const child = spawn(spec.executable, [...spec.args], {
    cwd: spec.workspace,
    env: {
      ...spec.env,
      SystemRoot: process.env["SystemRoot"] ?? "",
      FAKE_GEMINI_SCENARIO: scenario,
    },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const lines: string[] = [];
  const waiters: ((line: string | null) => void)[] = [];
  let closed = false;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter === undefined) lines.push(line);
    else waiter(line);
  });
  child.stdout.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(null);
  });
  let done = false;
  const exited = new Promise<ContainedExit>((resolve) => {
    child.on("exit", (code) => {
      done = true;
      resolve({ mainExitCode: code, killReason: null, totalProcesses: null });
    });
  });
  return {
    started: () =>
      new Promise((resolve, reject) => {
        child.once("spawn", () => {
          resolve(child.pid ?? 0);
        });
        child.once("error", reject);
      }),
    readLine: () => {
      const line = lines.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    get hasExited() {
      return done;
    },
    exited,
    async terminateTree(timeoutMs) {
      const begin = performance.now();
      if (done) return { confirmed: true, elapsedMs: 0, kernelMs: null, via: "already_exited" };
      child.kill("SIGKILL");
      const confirmed = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => {
          setTimeout(() => {
            resolve(false);
          }, timeoutMs);
        }),
      ]);
      return {
        confirmed,
        elapsedMs: performance.now() - begin,
        kernelMs: null,
        via: "kill_command",
      };
    },
  };
}

interface Bench {
  readonly root: string;
  readonly workspace: string;
  readonly home: string;
  readonly state: string;
  readonly launched: GeminiLaunchSpec[];
}

let bench: Bench;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindwake-gemini-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  bench = {
    root,
    workspace,
    home: path.join(root, "home"),
    state: path.join(root, "state"),
    launched: [],
  };
});

afterEach(() => {
  fs.rmSync(bench.root, { recursive: true, force: true });
});

function port(
  scenario: string,
  kind: GeminiLaunchPort["kind"] = "host",
  isolation: IsolationVerdict = { verified: false, detail: "hôte" },
): GeminiLaunchPort {
  return {
    kind,
    isolationVerified: () => Promise.resolve(isolation),
    launch(spec) {
      bench.launched.push(spec);
      return directProcess(spec, scenario);
    },
  };
}

const SANDBOX_OK: IsolationVerdict = { verified: true, detail: "profil mindwake.sandbox" };

function adapter(overrides: Partial<GeminiAdapterOptions> & { launch: GeminiLaunchPort }) {
  return new GeminiAdapter({
    command: { executable: process.execPath, prefixArgs: [FAKE_GEMINI] },
    mode: "manual",
    workspaceFor: () => bench.workspace,
    homeDir: bench.home,
    stateDir: bench.state,
    readVersion: () => Promise.resolve("0.52.0\n"),
    ...overrides,
  });
}

function request(sessionId: string, context = "Reprends l'expérience.") {
  return {
    sessionId: sessionId as SessionId,
    reservationId: "r-1" as ReservationId,
    policy: { groups: { runtime: { model: "gemini-2.5-pro" } } } as unknown as PolicyRevision,
    context,
    maxInputTokens: 4_000,
    deadline: new Date(Date.now() + 60_000).toISOString() as UtcTimestamp,
  };
}

async function collect(events: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const all: AdapterEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

function invocation(): { argv: string[]; cwd: string; envKeys: string[] } {
  return JSON.parse(fs.readFileSync(path.join(bench.home, "fake-invocation.json"), "utf8")) as {
    argv: string[];
    cwd: string;
    envKeys: string[];
  };
}

describe("GeminiAdapter : probe et capacités", () => {
  it("lit la version et déclare honnêtement ses limites", async () => {
    const gemini = adapter({ launch: port("success") });
    const probe = await gemini.probe();
    expect(probe).toMatchObject({
      adapterId: "gemini",
      version: "0.52.0",
      available: true,
      simulated: false,
    });
    const caps = await gemini.capabilities();
    expect(caps.providerQuotaReading).toBe("none");
    expect(caps.tokenCapEnforcement).toBe("none");
    expect(caps.cancellation).toBe("forced_only");
    expect(caps.isolationCompatible).toBe(false);
    expect(caps.resumeModes).toEqual(["fresh_process_from_memory"]);
  });

  it("lit la version auprès du faux exécutable réel", async () => {
    const gemini = new GeminiAdapter({
      command: { executable: process.execPath, prefixArgs: [FAKE_GEMINI] },
      mode: "manual",
      workspaceFor: () => bench.workspace,
      homeDir: bench.home,
      stateDir: bench.state,
      launch: port("success"),
    });
    expect(await gemini.probe()).toMatchObject({ version: "0.52.0", available: true });
  });

  it("signale un exécutable absent", async () => {
    const gemini = new GeminiAdapter({
      command: { executable: path.join(bench.root, "absent.exe") },
      mode: "manual",
      workspaceFor: () => bench.workspace,
      homeDir: bench.home,
      stateDir: bench.state,
      launch: port("success"),
    });
    const probe = await gemini.probe();
    expect(probe.available).toBe(false);
    expect(probe.unavailableReason).toMatch(/--version/);
  });
});

describe("GeminiAdapter : règle de lancement (ADR-005)", () => {
  it("refuse le mode autonome hors sandbox", async () => {
    const gemini = adapter({ launch: port("success"), mode: "autonomous" });
    await expect(gemini.start(request("s-auto"))).rejects.toMatchObject({
      refusal: "isolation_unverified",
    });
    expect(bench.launched).toHaveLength(0);
  });

  it("refuse le mode autonome même en sandbox vérifiée : aucune lecture officielle du quota", async () => {
    const gemini = adapter({ launch: port("success", "sandbox", SANDBOX_OK), mode: "autonomous" });
    const error = await gemini.start(request("s-auto")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiLaunchRefused);
    expect((error as GeminiLaunchRefused).refusal).toBe("no_quota_reading");
    expect(bench.launched).toHaveLength(0);
  });

  it("refuse --approval-mode yolo hors sandbox ou sans autotest réussi", async () => {
    for (const launch of [
      port("success"),
      port("success", "sandbox", { verified: false, detail: "autotest en échec" }),
    ]) {
      const gemini = adapter({ launch, approvalMode: "yolo" });
      await expect(gemini.start(request("s-yolo"))).rejects.toMatchObject({
        refusal: "approval_outside_sandbox",
      });
    }
    expect(bench.launched).toHaveLength(0);
  });

  it("passe yolo dans la sandbox vérifiée, avec le transport du relais", async () => {
    const closed: string[] = [];
    const transport: ProviderTransportPort = {
      open: (sessionId) =>
        Promise.resolve({
          broker: { pipeName: "mindwake-broker-test", port: 40_001 },
          env: { HTTPS_PROXY: "http://relais.invalid" },
          close: () => {
            closed.push(sessionId);
            return Promise.resolve();
          },
        }),
    };
    const gemini = adapter({
      launch: port("success", "sandbox", SANDBOX_OK),
      approvalMode: "yolo",
      transport,
    });
    const handle = await gemini.start(request("s-yolo"));
    await collect(gemini.events(handle));
    const spec = bench.launched[0];
    expect(spec?.broker).toEqual({ pipeName: "mindwake-broker-test", port: 40_001 });
    expect(spec?.args).toContain("yolo");
    expect(closed).toEqual(["s-yolo"]);
  });
});

describe("GeminiAdapter : lancement", () => {
  it("lance dans l'espace d'exploration, environnement minimal, configuration propre à Wake", async () => {
    process.env["MINDWAKE_TEST_SECRET_TOKEN"] = "ne-doit-pas-fuir";
    try {
      const gemini = adapter({ launch: port("success"), model: "gemini-2.5-flash" });
      const handle = await gemini.start(request("s-1", "-commence par relire la mémoire"));
      await collect(gemini.events(handle));
    } finally {
      delete process.env["MINDWAKE_TEST_SECRET_TOKEN"];
    }
    const seen = invocation();
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(bench.workspace));
    expect(seen.argv).toEqual([
      "--output-format",
      "stream-json",
      "--model",
      "gemini-2.5-flash",
      "--approval-mode",
      "default",
      "--prompt=-commence par relire la mémoire",
    ]);
    expect(seen.envKeys).not.toContain("MINDWAKE_TEST_SECRET_TOKEN");
    expect(Object.keys(bench.launched[0]?.env ?? {}).sort()).toEqual([
      "GEMINI_CLI_HOME",
      "NO_COLOR",
    ]);

    const settings = JSON.parse(
      fs.readFileSync(path.join(bench.home, ".gemini", "settings.json"), "utf8"),
    ) as Record<string, Record<string, unknown>>;
    expect(settings["privacy"]).toEqual({ usageStatisticsEnabled: false });
    expect(settings["model"]).toEqual({ name: "gemini-2.5-flash", maxSessionTurns: 50 });
    const policy = fs.readFileSync(
      path.join(bench.home, ".gemini", "policies", "mindwake.toml"),
      "utf8",
    );
    expect(policy).toContain('toolName = "web_fetch"');
    expect(policy).toContain('decision = "deny"');
  });

  it("prend le modèle de la policy par défaut et écrase une politique déposée par l'agent", async () => {
    const policies = path.join(bench.home, ".gemini", "policies");
    fs.mkdirSync(policies, { recursive: true });
    fs.writeFileSync(
      path.join(policies, "agent.toml"),
      '[[rule]]\ntoolName = "*"\ndecision = "allow"\n',
    );
    const gemini = adapter({ launch: port("success") });
    await collect(gemini.events(await gemini.start(request("s-1"))));
    expect(invocation().argv).toContain("gemini-2.5-pro");
    expect(fs.readdirSync(policies)).toEqual(["mindwake.toml"]);
  });

  it("refuse un transport qui redéfinit GEMINI_CLI_HOME et libère la bail", async () => {
    let closed = 0;
    const gemini = adapter({
      launch: port("success"),
      transport: {
        open: () =>
          Promise.resolve({
            broker: null,
            env: { GEMINI_CLI_HOME: "C:\\Users\\quelquun" },
            close: () => {
              closed += 1;
              return Promise.resolve();
            },
          }),
      },
    });
    await expect(gemini.start(request("s-1"))).rejects.toThrow(/GEMINI_CLI_HOME/);
    expect(closed).toBe(1);
  });

  it("refuse un état d'adapter placé dans une racine de l'agent, et un contexte trop long", async () => {
    const inside = adapter({
      launch: port("success"),
      stateDir: path.join(bench.workspace, "etat"),
    });
    await expect(inside.start(request("s-1"))).rejects.toThrow(/hors des racines/);
    const gemini = adapter({ launch: port("success") });
    await expect(gemini.start(request("s-2", "x".repeat(30_000)))).rejects.toThrow(/trop long/);
    expect(bench.launched).toHaveLength(0);
  });
});

describe("GeminiAdapter : événements et rapprochement", () => {
  it("rejoue une session réussie : activité, usage mesuré, fin", async () => {
    const gemini = adapter({ launch: port("success") });
    const handle = await gemini.start(request("s-1"));
    const events = await collect(gemini.events(handle));
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "activity",
      "activity",
      "activity",
      "activity",
      "activity",
      "activity",
      "usage",
      "ended",
    ]);
    const summaries = events.flatMap((e) => (e.type === "activity" ? [e.summary] : []));
    expect(summaries).toEqual([
      "Je relis le checkpoint puis je lance la simulation.",
      "outil run_shell_command",
      "outil write_file",
      "outil en échec : refusé par la politique",
      "avertissement : Loop detection paused",
      "Résultat : 42 cellules stables.",
    ]);
    const usage = events.find((event) => event.type === "usage");
    expect(usage).toMatchObject({
      quantity: { unit: "tokens", amount: 1650 },
      provenance: "measured",
      tokenBreakdown: { input: 1000, cached_input: 200, output: 300, unexposed: 150 },
    });
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "completed" });
    expect(await gemini.reconcile(handle.sessionId)).toEqual({
      status: "confirmed",
      ended: true,
      usage: [{ unit: "tokens", amount: 1650 }],
      provenance: "measured",
    });
  });

  it("traduit une limitation de quota en rate_limited avec le délai suggéré", async () => {
    const gemini = adapter({ launch: port("rate-limited") });
    const handle = await gemini.start(request("s-1"));
    const events = await collect(gemini.events(handle));
    expect(events.find((event) => event.type === "rate_limited")).toMatchObject({
      retryAfterMs: 3_600_000,
    });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "exit_1" });
  });

  it("traduit une erreur d'authentification (code 41) en auth_failed", async () => {
    const gemini = adapter({ launch: port("auth-failed") });
    const handle = await gemini.start(request("s-1"));
    const events = await collect(gemini.events(handle));
    expect(events.map((event) => event.type)).toEqual(["error", "ended"]);
    expect(events[0]).toMatchObject({ code: "auth_failed" });
    expect(await gemini.reconcile(handle.sessionId)).toMatchObject({ status: "uncertain" });
  });

  it("détecte une sortie coupée et laisse l'usage incertain", async () => {
    const gemini = adapter({ launch: port("truncated") });
    const handle = await gemini.start(request("s-1"));
    const events = await collect(gemini.events(handle));
    expect(events.map((event) => event.type)).toEqual(["started", "activity", "error", "ended"]);
    expect(events[2]).toMatchObject({ code: "transient" });
    expect(events.at(-1)).toMatchObject({ exitReason: "truncated" });
    expect(await gemini.reconcile(handle.sessionId)).toMatchObject({
      status: "uncertain",
      detail: expect.stringMatching(/aucune statistique/) as unknown,
    });
  });

  it("reconnaît la limite de tours (code 53)", async () => {
    const gemini = adapter({ launch: port("turn-limit") });
    const events = await collect(gemini.events(await gemini.start(request("s-1"))));
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "turn_limit" });
  });

  it("annule une session bloquée dans le délai et le signale", async () => {
    const gemini = adapter({ launch: port("hang") });
    const handle = await gemini.start(request("s-1"));
    const iterator = gemini.events(handle)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "started" });
    expect(await gemini.reconcile(handle.sessionId)).toMatchObject({ status: "uncertain" });
    const result = await gemini.cancel(handle, 2_000);
    expect(result.status).toBe("forced");
    const rest: AdapterEvent[] = [];
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
      rest.push(next.value);
    }
    expect(rest.at(-1)).toMatchObject({ type: "ended", exitReason: "cancelled" });
    expect(await gemini.reconcile(handle.sessionId)).toMatchObject({ status: "uncertain" });
  });

  it("rapproche après redémarrage depuis l'index persisté", async () => {
    const first = adapter({ launch: port("success") });
    await collect(first.events(await first.start(request("s-1"))));
    const restarted = adapter({ launch: port("success") });
    expect(await restarted.reconcile("s-1" as SessionId)).toMatchObject({
      status: "confirmed",
      usage: [{ unit: "tokens", amount: 1650 }],
    });
    expect(await restarted.reconcile("s-inconnue" as SessionId)).toMatchObject({
      status: "uncertain",
    });
  });

  it("reprend nativement la session Gemini précédente quand la reprise est configurée", async () => {
    const gemini = adapter({
      launch: port("success"),
      resumeFrom: (sessionId) => (sessionId === "s-2" ? ("s-1" as SessionId) : null),
    });
    expect((await gemini.capabilities()).resumeModes).toContain("native_resume");
    await collect(gemini.events(await gemini.start(request("s-1"))));
    expect(invocation().argv).not.toContain("--resume");
    await collect(gemini.events(await gemini.start(request("s-2"))));
    const argv = invocation().argv;
    expect(argv[argv.indexOf("--resume") + 1]).toBe("8f1c2b7e-4d3a-4f6b-9a21-0c5e7d9b1a33");
  });
});
