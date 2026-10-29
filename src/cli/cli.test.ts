import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  JournalEventInput,
  PolicyRevision,
  PolicyRevisionId,
  ProfileId,
  ProfileRecord,
  UnitOfWork,
  UtcTimestamp,
  IanaTimeZone,
  AdapterId,
  AgentId,
} from "../contracts/index.js";
import { ALL_SECRETS, SECRET_TRAPS, SENSITIVE_KEY_TRAPS } from "../../test/fixtures/secrets.js";
import { runIsolationSelfTest, type IsolationSelfTestReport } from "../sandbox/index.js";
import { assessIsolation } from "./commands/doctor.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "./context.js";
import { CLI_OUTPUT_SCHEMA, CLI_OUTPUT_SCHEMA_VERSION, EXIT_OK, EXIT_USAGE } from "./output.js";
import { runCli } from "./run.js";
import { probeSqliteDriver, type Store } from "./store/index.js";
import { MemoryUnitOfWork } from "./store/memory.js";

const NOW = new Date("2026-10-29T10:00:00.000Z");

interface Harness {
  readonly ctx: CliContext;
  readonly uow: MemoryUnitOfWork;
  readonly dataDir: string;
  readonly out: string[];
  readonly err: string[];
  run(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mind-wake-cli-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Un même `UnitOfWork` en mémoire partagé entre invocations, comme le serait SQLite. */
function harness(options: { uow?: UnitOfWork; createDataDir?: boolean } = {}): Harness {
  const uow = new MemoryUnitOfWork();
  const shared = options.uow ?? uow;
  const dataDir = path.join(tmpRoot, "data");
  if (options.createDataDir !== false) fs.mkdirSync(dataDir);
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    platform: "win32",
    homeDir: path.join(tmpRoot, "home"),
    cwd: tmpRoot,
    nodeVersion: "24.17.0",
    now: () => NOW,
    openStore: (dir): Store => ({
      uow: shared,
      persistence: "memory",
      dataDir: dir,
      close: () => undefined,
    }),
    storeBackend: "memory",
    probeSqlite: () =>
      Promise.resolve({ status: "ok", driver: "better-sqlite3", sqliteVersion: "3.53.4" }),
  };
  return {
    ctx,
    uow,
    dataDir,
    out,
    err,
    async run(...argv) {
      out.length = 0;
      err.length = 0;
      const code = await runCli(["--data-dir", dataDir, ...argv], ctx);
      return { code, stdout: out.join(""), stderr: err.join("") };
    },
  };
}

function parseJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

const at = NOW.toISOString() as UtcTimestamp;

function policyRevision(): PolicyRevision {
  return {
    schemaVersion: 1,
    id: "rev-1" as PolicyRevisionId,
    profileId: DEFAULT_PROFILE_ID,
    previousRevisionId: null,
    createdAt: at,
    groups: {
      identity: { profileId: DEFAULT_PROFILE_ID, agentId: "default" as AgentId },
      runtime: {
        adapterId: "fake" as AdapterId,
        provider: "simulé",
        model: "aucun",
        authMode: SECRET_TRAPS[0]?.text ?? "",
      },
      schedule: {
        timeZone: "Europe/Paris" as IanaTimeZone,
        weeklyWindows: [{ day: 1, start: "22:00", end: "23:00" }],
        minIntervalBetweenSessionsMs: 3_600_000,
        maxSessionDurationMs: 600_000,
      },
      humanPriority: {
        activitySignal: "idle",
        idleThresholdMs: 600_000,
        maxSignalAgeMs: 60_000,
        maxInterruptLatencyMs: 5_000,
        maxTerminationLatencyMs: 10_000,
      },
      budget: {
        period: { kind: "day", timeZone: "Europe/Paris" as IanaTimeZone },
        tokensPerSession: 5_000,
        tokensPerPeriod: 20_000,
        sessionsPerPeriod: 4,
        userReserveTokens: 1_000,
        checkpointTokens: 500,
        paidApi: { authorized: false },
      },
      filesAndTools: {
        readRoots: ["C:\\wake"],
        writeRoots: ["C:\\wake"],
        allowedExecutables: ["node --token " + "fake" + "Value123"],
        maxProcesses: 4,
        maxStorageBytes: 1_000_000,
      },
      network: {
        explorationDestinations: [],
        providerTransportDestinations: [
          { host: "api.example.test", ports: [443], purpose: SECRET_TRAPS[8]?.text ?? "" },
        ],
      },
      data: {
        eventRetentionDays: 30,
        localStorageCapBytes: 1_000_000,
        purge: "manual",
        exportPaths: [],
      },
    },
  };
}

/** Peuple le stockage en contournant le writer : l'affichage doit expurger quand même. */
function seedWithRawSecrets(uow: UnitOfWork): void {
  const profile: ProfileRecord = {
    id: DEFAULT_PROFILE_ID,
    agentId: "default" as AgentId,
    state: "blocked",
    activePolicyRevisionId: "rev-1" as PolicyRevisionId,
    nextWakeAt: null,
    emergencyStopLocked: false,
    stateReason: `adapter refusé : ${SECRET_TRAPS[1]?.text ?? ""}`,
    updatedAt: at,
  };
  uow.profiles.create(profile);
  uow.policies.appendRevision(policyRevision());
  for (const trap of SECRET_TRAPS) {
    const raw: JournalEventInput = {
      type: "error",
      at,
      profileId: DEFAULT_PROFILE_ID,
      reason: trap.text,
      metadata: { output: trap.text, ...SENSITIVE_KEY_TRAPS },
    };
    uow.journal.append(raw);
  }
}

const WRITE_METHODS = new Set([
  "create",
  "transition",
  "setNextWake",
  "setEmergencyStopLocked",
  "appendRevision",
  "recordConsent",
  "recordRevocation",
  "upsert",
  "close",
  "ensurePeriod",
  "reserve",
  "recordUsage",
  "reconcile",
  "markUncertain",
  "append",
  "publish",
]);

/** Enveloppe un `UnitOfWork` et enregistre toute écriture ou transaction. */
function recordingUow(inner: UnitOfWork, writes: string[]): UnitOfWork {
  const wrap = <T extends object>(name: string, repo: T): T =>
    new Proxy(repo, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof prop === "string" && WRITE_METHODS.has(prop) && typeof value === "function") {
          return (...args: unknown[]) => {
            writes.push(`${name}.${prop}`);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    });
  const uow: UnitOfWork = {
    profiles: wrap("profiles", inner.profiles),
    policies: wrap("policies", inner.policies),
    experiments: wrap("experiments", inner.experiments),
    sessions: wrap("sessions", inner.sessions),
    ledger: wrap("ledger", inner.ledger),
    journal: wrap("journal", inner.journal),
    checkpoints: wrap("checkpoints", inner.checkpoints),
    transaction: (fn) => {
      writes.push("transaction");
      return inner.transaction(() => fn(uow));
    },
  };
  return uow;
}

describe("init", () => {
  it("crée un profil disabled, sans policy, et le journalise", async () => {
    const h = harness();
    const { code, stdout } = await h.run("init");
    expect(code).toBe(EXIT_OK);
    expect(stdout).toContain("disabled");
    const profile = h.uow.profiles.get(DEFAULT_PROFILE_ID);
    expect(profile).toMatchObject({
      state: "disabled",
      activePolicyRevisionId: null,
      nextWakeAt: null,
      emergencyStopLocked: false,
    });
    expect(h.uow.policies.listRevisions(DEFAULT_PROFILE_ID)).toEqual([]);
    expect(h.uow.sessions.listOpen(DEFAULT_PROFILE_ID)).toEqual([]);
    const events = h.uow.journal.list(DEFAULT_PROFILE_ID);
    expect(events.map((e) => e.type)).toEqual(["profile_state_changed"]);
  });

  it("est idempotent et ne modifie jamais un profil existant", async () => {
    const h = harness();
    await h.run("init");
    const second = await h.run("init", "--json");
    expect(parseJson(second.stdout)).toMatchObject({ ok: true, data: { created: false } });
    expect(h.uow.journal.list(DEFAULT_PROFILE_ID)).toHaveLength(1);
  });

  it("ne réactive pas un profil arrêté ou bloqué", async () => {
    const h = harness();
    h.uow.profiles.create({
      id: DEFAULT_PROFILE_ID,
      agentId: "default" as AgentId,
      state: "stopped",
      activePolicyRevisionId: null,
      nextWakeAt: null,
      emergencyStopLocked: true,
      stateReason: "arrêt d'urgence",
      updatedAt: at,
    });
    const { stdout } = await h.run("init", "--json");
    expect(parseJson(stdout)).toMatchObject({
      data: { created: false, profile: { state: "stopped" } },
    });
    expect(h.uow.profiles.get(DEFAULT_PROFILE_ID)?.emergencyStopLocked).toBe(true);
  });

  it("ne crée jamais de profil actif, quel que soit l'ordre des commandes", async () => {
    const h = harness();
    for (const argv of [
      ["status"],
      ["init"],
      ["policy", "show"],
      ["init"],
      ["journal"],
      ["doctor"],
    ]) {
      await h.run(...argv);
      const state = h.uow.profiles.get(DEFAULT_PROFILE_ID)?.state;
      expect(state === undefined || state === "disabled").toBe(true);
    }
  });

  it("crée le dossier de données et rien d'autre", async () => {
    const h = harness({ createDataDir: false });
    await h.run("init");
    expect(fs.readdirSync(tmpRoot)).toEqual(["data"]);
    expect(fs.readdirSync(h.dataDir)).toEqual([]);
  });

  it("annule la création si le journal échoue", async () => {
    const h = harness();
    vi.spyOn(h.uow.journal, "append").mockImplementation(() => {
      throw new Error("disque plein");
    });
    const { code } = await h.run("init");
    expect(code).not.toBe(EXIT_OK);
    expect(h.uow.profiles.get(DEFAULT_PROFILE_ID)).toBeNull();
  });
});

describe("consultations", () => {
  it("n'écrivent rien et ne déclenchent aucune session", async () => {
    const writes: string[] = [];
    const base = new MemoryUnitOfWork();
    seedWithRawSecrets(base);
    const h = harness({ uow: recordingUow(base, writes) });
    for (const argv of [
      ["status"],
      ["journal"],
      ["policy", "show"],
      ["doctor"],
      ["status", "--json"],
    ]) {
      const { code } = await h.run(...argv);
      expect(code, argv.join(" ")).toBe(EXIT_OK);
    }
    expect(writes).toEqual([]);
    expect(base.sessions.listOpen(DEFAULT_PROFILE_ID)).toEqual([]);
    expect(base.profiles.get(DEFAULT_PROFILE_ID)?.state).toBe("blocked");
  });

  it("ne créent pas le dossier de données absent", async () => {
    const h = harness({ createDataDir: false });
    for (const argv of [["status"], ["journal"], ["policy", "show"], ["doctor"]]) {
      await h.run(...argv);
    }
    expect(fs.existsSync(h.dataDir)).toBe(false);
  });

  it("indiquent l'absence de profil", async () => {
    const h = harness();
    const status = parseJson((await h.run("status", "--json")).stdout);
    expect(status).toMatchObject({
      ok: true,
      data: { profile: null, budget: { availability: "unknown" } },
    });
    expect((await h.run("policy", "show")).stdout).toContain("aucun profil");
  });

  it("status après init : désactivé, budget inconnu, aucune policy", async () => {
    const h = harness();
    await h.run("init");
    const { stdout } = await h.run("status");
    expect(stdout).toContain("État : disabled");
    expect(stdout).toContain("Budget disponible : inconnu");
    expect((await h.run("policy", "show")).stdout).toContain("Aucune policy active");
  });
});

describe("aucun secret dans la sortie CLI", () => {
  for (const json of [false, true]) {
    it(`status, journal et policy show (${json ? "JSON" : "texte"})`, async () => {
      const h = harness();
      seedWithRawSecrets(h.uow);
      const flags = json ? ["--json"] : [];
      const outputs = [
        await h.run("status", ...flags),
        await h.run("journal", "--limit", "1000", ...flags),
        await h.run("policy", "show", ...flags),
      ];
      const all = outputs.map((o) => o.stdout + o.stderr).join("\n");
      for (const secret of ALL_SECRETS) expect(all).not.toContain(secret);
      expect(all).not.toContain("fakeValue123");
      if (json)
        for (const o of outputs) expect(() => JSON.parse(o.stdout) as unknown).not.toThrow();
      expect(all).toContain("[EXPURGÉ]");
    });
  }

  it("expurge aussi un message d'erreur", async () => {
    const h = harness();
    const trap = SECRET_TRAPS[0];
    const { stdout } = await h.run(`--${trap?.secret ?? ""}`, "--json");
    expect(stdout).not.toContain(trap?.secret);
    expect(parseJson(stdout)).toMatchObject({ ok: false, error: { code: "usage" } });
  });
});

describe("sortie JSON versionnée", () => {
  it("a une enveloppe stable et des clés ordonnées", async () => {
    const h = harness();
    const { stdout } = await h.run("init", "--json");
    expect(parseJson(stdout)).toEqual({
      schema: CLI_OUTPUT_SCHEMA,
      schemaVersion: CLI_OUTPUT_SCHEMA_VERSION,
      command: "init",
      ok: true,
      data: {
        dataDir: h.dataDir,
        persistence: "memory",
        created: true,
        profile: { id: "default", state: "disabled", activePolicyRevisionId: null },
      },
    });
    expect(Object.keys(parseJson(stdout))).toEqual([
      "schema",
      "schemaVersion",
      "command",
      "ok",
      "data",
    ]);
  });

  it("est identique d'une exécution à l'autre", async () => {
    const h = harness();
    seedWithRawSecrets(h.uow);
    for (const argv of [["status"], ["journal"], ["policy", "show"], ["doctor"]]) {
      const first = (await h.run(...argv, "--json")).stdout;
      const second = (await h.run(...argv, "--json")).stdout;
      expect(second).toBe(first);
    }
  });

  it("fixe la forme de status", async () => {
    const h = harness();
    await h.run("init");
    const data = parseJson((await h.run("status", "--json")).stdout)["data"];
    expect(data).toEqual({
      dataDir: h.dataDir,
      persistence: "memory",
      profile: {
        id: "default",
        state: "disabled",
        stateReason: "créé par init : désactivé, aucune policy, aucun budget, aucune permission",
        emergencyStopLocked: false,
        activePolicyRevisionId: null,
        nextWakeAt: null,
        updatedAt: at,
      },
      hint: null,
      activeExperiment: null,
      openSessions: 0,
      daemon: {
        state: "never",
        mode: null,
        pid: null,
        startedAt: null,
        endedAt: null,
        endReason: null,
        prioritySignal: null,
      },
      lastSession: null,
      lastEvent: {
        sequence: 1,
        at,
        type: "profile_state_changed",
        reason: "profil créé à l'état disabled par init",
      },
      budget: {
        availability: "unknown",
        detail: "aucune policy active : aucun budget accordé",
        caps: null,
        subscriptionQuota: null,
      },
      capabilities: expect.any(Array) as unknown,
    });
  });

  it("pagine le journal avec --after et --limit", async () => {
    const h = harness();
    seedWithRawSecrets(h.uow);
    const page = parseJson(
      (await h.run("journal", "--after", "2", "--limit", "3", "--json")).stdout,
    );
    const data = page["data"] as { events: { sequence: number }[]; truncated: boolean };
    expect(data.events.map((e) => e.sequence)).toEqual([3, 4, 5]);
    expect(data.truncated).toBe(true);
  });

  it("signale les erreurs d'usage avec le code 2", async () => {
    const h = harness();
    for (const argv of [
      ["frobnicate"],
      ["policy", "edit"],
      ["status", "--limit", "3"],
      ["journal", "--limit", "0"],
      ["init", "extra"],
    ]) {
      const { code, stdout } = await h.run(...argv, "--json");
      expect(code, argv.join(" ")).toBe(EXIT_USAGE);
      expect(parseJson(stdout)).toMatchObject({
        schema: CLI_OUTPUT_SCHEMA,
        ok: false,
        error: { code: "usage" },
      });
    }
  });
});

describe("doctor", () => {
  it("n'accède jamais au réseau, y compris avec le vrai pilote SQLite", async () => {
    const attempts: string[] = [];
    const deny = (name: string) => () => {
      attempts.push(name);
      throw new Error(`accès réseau interdit : ${name}`);
    };
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(deny("net.connect"));
    vi.spyOn(net, "createConnection").mockImplementation(deny("net.createConnection"));
    vi.spyOn(tls, "connect").mockImplementation(deny("tls.connect"));
    vi.spyOn(http, "request").mockImplementation(deny("http.request"));
    vi.spyOn(http, "get").mockImplementation(deny("http.get"));
    vi.spyOn(https, "request").mockImplementation(deny("https.request"));
    vi.spyOn(https, "get").mockImplementation(deny("https.get"));
    vi.spyOn(dns, "lookup").mockImplementation(deny("dns.lookup"));
    vi.spyOn(dns.promises, "lookup").mockImplementation(deny("dns.promises.lookup"));
    vi.spyOn(dns, "resolve").mockImplementation(deny("dns.resolve"));
    vi.stubGlobal("fetch", deny("fetch"));

    const h = harness();
    const ctx: CliContext = { ...h.ctx, probeSqlite: probeSqliteDriver };
    const code = await runCli(["doctor", "--json", "--data-dir", h.dataDir], ctx);
    expect(attempts).toEqual([]);
    expect(code).toBe(EXIT_OK);
    const data = parseJson(h.out.join(""))["data"] as {
      modelCalls: string;
      networkAccess: string;
      checks: { id: string; status: string }[];
    };
    expect(data.modelCalls).toBe("none");
    expect(data.networkAccess).toBe("none");
    const byId = Object.fromEntries(data.checks.map((c) => [c.id, c.status]));
    expect(byId).toEqual({
      node: "ok",
      sqlite_driver: "ok",
      data_dir: "ok",
    });
  });

  it("échoue sur une version de Node non prise en charge ou un pilote absent", async () => {
    const h = harness();
    const ctx: CliContext = {
      ...h.ctx,
      nodeVersion: "22.23.4",
      probeSqlite: () =>
        Promise.resolve({ status: "fail", driver: "better-sqlite3", detail: "absent" }),
    };
    const code = await runCli(["doctor", "--data-dir", h.dataDir], ctx);
    expect(code).toBe(1);
    expect(h.out.join("")).toContain("[ÉCHEC] node");
    expect(h.out.join("")).toContain("[ÉCHEC] sqlite_driver");
    expect(h.out.join("")).toContain("[BLOQUÉ] isolation");
  });

  const report = (passed: boolean): IsolationSelfTestReport => ({
    passed,
    platform: "win32",
    profile: "mindwake.selftest.test",
    checks: [
      { id: "write_outside_root", expected: "denied", outcome: "denied", code: 5, passed: true },
      {
        id: "read_secret_outside_root",
        expected: "denied",
        outcome: passed ? "denied" : "allowed",
        code: passed ? 5 : 0,
        passed,
      },
    ],
    termination: { confirmed: true, elapsedMs: 10, kernelMs: 3, survivors: 0, treeSize: 3 },
    cleanup: { aclRemoved: true, profileRemoved: true, tempRemoved: true },
    notDemonstrated: ["traversée d'un symlink préexistant"],
    durationMs: 3_000,
  });

  it("l'isolation n'est présente que si l'autotest de refus réussit", async () => {
    const h = harness();
    let calls = 0;
    const ok: CliContext = {
      ...h.ctx,
      isolationSelfTest: () => {
        calls += 1;
        return Promise.resolve(report(true));
      },
    };
    await runCli(["doctor", "--data-dir", h.dataDir], ok);
    expect(calls).toBe(1);
    expect(h.out.join("")).toContain("[PRÉSENT] isolation : AppContainer sans capacité");
    expect(h.out.join("")).toContain("non démontré : traversée d'un symlink préexistant");

    h.out.length = 0;
    const ko: CliContext = { ...h.ctx, isolationSelfTest: () => Promise.resolve(report(false)) };
    await runCli(["doctor", "--json", "--data-dir", h.dataDir], ko);
    const data = parseJson(h.out.join(""))["data"] as {
      capabilities: { id: string; availability: string; blockers: string[] }[];
      isolationSelfTest: { passed: boolean; failed: string[] };
    };
    expect(data.capabilities.find((c) => c.id === "isolation")).toMatchObject({
      availability: "blocked",
      blockers: ["refus non obtenu : read_secret_outside_root"],
    });
    expect(data.isolationSelfTest).toMatchObject({
      passed: false,
      failed: ["read_secret_outside_root"],
    });
  });

  it("un nettoyage non vérifié bloque l'isolation même si les refus passent", () => {
    const assessed = assessIsolation({
      ...report(true),
      passed: false,
      cleanup: { aclRemoved: true, profileRemoved: false, tempRemoved: true },
    });
    expect(assessed).toMatchObject({
      passed: false,
      blockers: ["nettoyage de l'autotest non vérifié"],
    });
  });

  it.runIf(process.platform === "win32")(
    "autotest réel sur ce poste : isolation présente",
    async () => {
      const h = harness();
      const ctx: CliContext = { ...h.ctx, isolationSelfTest: () => runIsolationSelfTest() };
      await runCli(["doctor", "--json", "--data-dir", h.dataDir], ctx);
      const data = parseJson(h.out.join(""))["data"] as {
        capabilities: { id: string; availability: string }[];
        isolationSelfTest: { passed: boolean; cleanup: unknown };
      };
      expect(data.isolationSelfTest).toMatchObject({
        passed: true,
        cleanup: { aclRemoved: true, profileRemoved: true, tempRemoved: true },
      });
      expect(data.capabilities.find((c) => c.id === "isolation")?.availability).toBe("present");
    },
    60_000,
  );
});

describe("emplacement des données", () => {
  it("suit l'option, puis la variable d'environnement, puis le défaut", async () => {
    const h = harness();
    const fromEnv = path.join(tmpRoot, "env-dir");
    const base: CliContext = {
      ...h.ctx,
      env: { MIND_WAKE_DATA_DIR: fromEnv, LOCALAPPDATA: path.join(tmpRoot, "local") },
    };
    const read = async (argv: string[], ctx: CliContext) => {
      h.out.length = 0;
      await runCli([...argv, "doctor", "--json"], ctx);
      return (parseJson(h.out.join(""))["data"] as { dataDir: { path: string; source: string } })
        .dataDir;
    };
    expect(await read(["--data-dir", "rel"], base)).toEqual({
      path: path.join(tmpRoot, "rel"),
      source: "option",
    });
    expect(await read([], base)).toEqual({ path: fromEnv, source: "environment" });
    expect(await read([], { ...base, env: { LOCALAPPDATA: path.join(tmpRoot, "local") } })).toEqual(
      {
        path: path.join(tmpRoot, "local", "mind-wake"),
        source: "default",
      },
    );
  });
});

describe("profil", () => {
  it("utilise l'identifiant local stable", () => {
    expect(DEFAULT_PROFILE_ID).toBe("default" as ProfileId);
  });
});
