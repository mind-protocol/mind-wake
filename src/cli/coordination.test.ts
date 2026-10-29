/**
 * Exigences de la revue de coordination S5 (docs/REVIEW-2026-10-29.md) : disponibilité
 * distinguée, voie abonnement jamais autorisée, quota en pourcentage, expurgation des
 * erreurs et chemins, consultations sans effet externe.
 */

import childProcess from "node:child_process";
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
  AdapterId,
  AgentId,
  IanaTimeZone,
  PolicyRevision,
  PolicyRevisionId,
  SubscriptionQuotaGuard,
  UtcTimestamp,
} from "../contracts/index.js";
import { ALL_SECRETS, SECRET_TRAPS } from "../../test/fixtures/secrets.js";
import { JournalWriter, MemoryJournalRepository, PRIVATE_USER } from "../journal/index.js";
import { AVAILABILITIES, subscriptionPath, type Capability } from "./capabilities.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "./context.js";
import { USAGE, runCli } from "./run.js";
import type { Store } from "./store/index.js";
import { MemoryUnitOfWork } from "./store/memory.js";

const NOW = new Date("2026-10-29T10:00:00.000Z");
const at = NOW.toISOString() as UtcTimestamp;
const fake = (...parts: string[]): string => parts.join("");

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mind-wake-coord-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function context(uow: MemoryUnitOfWork, out: string[], overrides: Partial<CliContext> = {}) {
  const ctx: CliContext = {
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
    env: {},
    platform: "win32",
    homeDir: path.join(tmpRoot, "home"),
    cwd: tmpRoot,
    nodeVersion: "24.17.0",
    now: () => NOW,
    openStore: (dir): Store => ({
      uow,
      persistence: "memory",
      dataDir: dir,
      close: () => undefined,
    }),
    storeBackend: "memory",
    probeSqlite: () =>
      Promise.resolve({ status: "ok", driver: "better-sqlite3", sqliteVersion: "3.53.4" }),
    ...overrides,
  };
  return ctx;
}

async function run(ctx: CliContext, out: string[], ...argv: string[]) {
  out.length = 0;
  const dataDir = path.join(tmpRoot, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const code = await runCli(["--data-dir", dataDir, ...argv], ctx);
  return { code, stdout: out.join("") };
}

const ENABLED_GUARD: SubscriptionQuotaGuard = {
  enabled: true,
  accountRiskAcknowledged: true,
  startBelowBasisPoints: 5_000,
  stopAtBasisPoints: 8_000,
  userReserveBasisPoints: 1_500,
  overshootBoundBasisPoints: 250,
  maxSnapshotAgeMs: 60_000,
  targetUsageBasisPoints: 8_000,
  initialRateBasisPointsPerHour: 2_000,
  pacingMarginRatio: 0.25,
};

function revisionWithGuard(guard: SubscriptionQuotaGuard | undefined): PolicyRevision {
  return {
    schemaVersion: 1,
    id: "rev-q" as PolicyRevisionId,
    profileId: DEFAULT_PROFILE_ID,
    previousRevisionId: null,
    createdAt: at,
    groups: {
      identity: { profileId: DEFAULT_PROFILE_ID, agentId: "default" as AgentId },
      runtime: {
        adapterId: "codex" as AdapterId,
        provider: "openai",
        model: "m",
        authMode: "chatgpt",
      },
      schedule: {
        timeZone: "Europe/Paris" as IanaTimeZone,
        weeklyWindows: [],
        minIntervalBetweenSessionsMs: 1,
        maxSessionDurationMs: 1,
      },
      humanPriority: {
        activitySignal: "idle",
        idleThresholdMs: 1,
        maxSignalAgeMs: 1,
        maxInterruptLatencyMs: 1,
        maxTerminationLatencyMs: 1,
      },
      budget: {
        period: { kind: "week", timeZone: "Europe/Paris" as IanaTimeZone },
        tokensPerSession: 1,
        tokensPerPeriod: 1,
        sessionsPerPeriod: 1,
        userReserveTokens: 0,
        checkpointTokens: 0,
        paidApi: { authorized: false },
        ...(guard !== undefined && { subscriptionQuota: guard }),
      },
      filesAndTools: {
        readRoots: [],
        writeRoots: [],
        allowedExecutables: [],
        maxProcesses: 1,
        maxStorageBytes: 1,
      },
      network: { explorationDestinations: [], providerTransportDestinations: [] },
      data: { eventRetentionDays: 30, localStorageCapBytes: 1, purge: "manual", exportPaths: [] },
    },
  };
}

function seedProfile(uow: MemoryUnitOfWork, revision: PolicyRevision | null): void {
  uow.profiles.create({
    id: DEFAULT_PROFILE_ID,
    agentId: "default" as AgentId,
    state: "blocked",
    activePolicyRevisionId: revision?.id ?? null,
    nextWakeAt: null,
    emergencyStopLocked: false,
    stateReason: "test",
    updatedAt: at,
  });
  if (revision !== null) uow.policies.appendRevision(revision);
}

function byId(caps: readonly Capability[]): Record<string, string> {
  return Object.fromEntries(caps.map((c) => [c.id, c.availability]));
}

describe("disponibilité des composants", () => {
  it("doctor et status distinguent présent, simulé et non implémenté, sans rien de réel par défaut", async () => {
    const uow = new MemoryUnitOfWork();
    const out: string[] = [];
    const ctx = context(uow, out);
    await run(ctx, out, "init");
    for (const command of ["doctor", "status"]) {
      const { stdout } = await run(ctx, out, command, "--json");
      const data = (JSON.parse(stdout) as { data: { capabilities: Capability[] } }).data;
      for (const c of data.capabilities) expect(AVAILABILITIES).toContain(c.availability);
      expect(byId(data.capabilities)).toEqual({
        journal: "present",
        persistence: "not_implemented",
        ledger: "not_implemented",
        policy_engine: "not_implemented",
        scheduler: "not_implemented",
        daemon: "not_implemented",
        isolation: "blocked",
        simulated_adapter: "simulated",
        runtime_adapter: "not_implemented",
        api_key_path: "not_implemented",
        subscription_path: "blocked",
      });
    }
    const human = (await run(ctx, out, "doctor")).stdout;
    expect(human).toContain("[NON IMPLÉMENTÉ] ledger");
    expect(human).toContain("[BLOQUÉ] subscription_path");
    expect(human).toContain("expurgation heuristique");
  });
});

describe("voie abonnement", () => {
  const all = { adapter: true, isolation: true };

  it("n'est jamais présentée comme autorisée ni présente", () => {
    const guards: (SubscriptionQuotaGuard | undefined)[] = [
      undefined,
      { enabled: false },
      { ...ENABLED_GUARD, overshootBoundBasisPoints: null },
      ENABLED_GUARD,
    ];
    for (const guard of guards) {
      for (const available of [
        all,
        { adapter: false, isolation: true },
        { adapter: true, isolation: false },
      ]) {
        const cap = subscriptionPath(guard, available);
        expect(["experimental", "blocked"]).toContain(cap.availability);
        expect(cap.detail).toContain("expérimentale");
        expect(cap.detail).toContain("non autorisée explicitement");
        if (cap.availability === "blocked") expect(cap.blockers.length).toBeGreaterThan(0);
      }
    }
  });

  it("est bloquée avec motif : désactivée, dépassement non mesuré, réserve entamée, composants absents", () => {
    expect(subscriptionPath(undefined, all).blockers.join()).toContain("désactivée par défaut");
    expect(
      subscriptionPath({ ...ENABLED_GUARD, overshootBoundBasisPoints: null }, all).blockers.join(),
    ).toContain("dépassement");
    expect(
      subscriptionPath({ ...ENABLED_GUARD, overshootBoundBasisPoints: 900 }, all).blockers.join(),
    ).toContain("réserve humaine");
    expect(subscriptionPath(ENABLED_GUARD, { adapter: false, isolation: false }).blockers).toEqual([
      "aucun adapter réel enregistré dans ce build",
      "isolation non vérifiée sur ce poste (autotest de refus)",
    ]);
  });

  it("au mieux expérimentale quand toutes les conditions tiennent", () => {
    expect(subscriptionPath(ENABLED_GUARD, all)).toMatchObject({
      availability: "experimental",
      blockers: [],
    });
  });

  it("status affiche la jauge en pourcentage, sans tokens et sans la présenter comme une borne", async () => {
    const uow = new MemoryUnitOfWork();
    seedProfile(uow, revisionWithGuard(ENABLED_GUARD));
    const out: string[] = [];
    const ctx = context(uow, out);
    const json = JSON.parse((await run(ctx, out, "status", "--json")).stdout) as {
      data: { budget: { subscriptionQuota: Record<string, unknown> } };
    };
    expect(json.data.budget.subscriptionQuota).toEqual({
      enabled: true,
      unit: "provider_quota_bp",
      isConsumptionBound: false,
      startBelow: "50 %",
      stopAt: "80 %",
      userReserve: "15 %",
      overshootBound: "2.5 %",
      pacing: { target: "80 %", initialRatePerHour: "20 %", margin: 0.25 },
      note: "pourcentage d'une fenêtre de quota du fournisseur, usage humain inclus ; non converti en tokens, ce n'est pas une borne de consommation",
    });
    const human = (await run(ctx, out, "status")).stdout;
    expect(human).toContain("Jauge abonnement (expérimentale) : lancement sous 50 %, arrêt à 80 %");
    expect(human).toContain("ce n'est pas une borne");
    expect(human).not.toMatch(/80 %[^\n]*tokens\/session/);
  });
});

describe("expurgation avant écriture et avant sortie", () => {
  const ghToken = fake("ghp_", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2");
  const cookie = fake("session=", "tool", "CookieSecret99");
  const userPath = "C:\\Users\\alice.martin\\projects\\wake";

  it("couvre erreurs d'outils, en-têtes imbriqués, cookies, URL et chaînes tronquées", () => {
    const repo = new MemoryJournalRepository();
    const writer = new JournalWriter(repo);
    const toolError = new Error(
      `git exited 128: fatal: Authentication failed for 'https://bot:${ghToken}@github.com/x.git' in ${userPath}`,
    );
    toolError.stack = `${toolError.message}\n    at run (${userPath}\\tool.js:1:1)`;
    writer.record({
      type: "error",
      at,
      profileId: DEFAULT_PROFILE_ID,
      reason: `outil en échec dans ${userPath}`,
      metadata: {
        tool: { error: toolError, stderr: `remote: token ${ghToken}`, exitCode: 128 },
        response: {
          headers: [
            { name: "Set-Cookie", value: cookie },
            ["Authorization", fake("Bearer ", "abcDEF123456789xyz")],
          ],
          raw: `HTTP/1.1 401\r\nSet-Cookie: ${cookie}\r\nWWW-Authenticate: Bearer`,
        },
        // Secret à cheval sur la limite de 512 caractères : expurgé avant la coupe.
        truncated: `${"x".repeat(505)}${SECRET_TRAPS[0]?.text ?? ""}`,
        url: `https://example.test/hook?api_key=${fake("plain", "Hook", "Key42")}&ok=1`,
      },
    });
    const stored = JSON.stringify(repo.list(DEFAULT_PROFILE_ID));
    for (const secret of [
      ghToken,
      cookie,
      fake("abcDEF", "123456789xyz"),
      fake("plain", "Hook", "Key42"),
      ...ALL_SECRETS,
    ]) {
      expect(stored).not.toContain(secret);
    }
    for (const fragment of [ghToken.slice(0, 12), (SECRET_TRAPS[0]?.secret ?? "").slice(0, 10)]) {
      expect(stored).not.toContain(fragment);
    }
    expect(stored).not.toContain("alice.martin");
    expect(stored).toContain(PRIVATE_USER);
    expect(stored).not.toContain("tool.js:1:1");
  });

  it("expurge et anonymise une erreur interne, en texte comme en JSON", async () => {
    const uow = new MemoryUnitOfWork();
    const out: string[] = [];
    const secret = SECRET_TRAPS[0]?.secret ?? "";
    const ctx = context(uow, out, {
      openStore: () => {
        const error = new Error(`EACCES: open '${userPath}\\wake.db' with key ${secret}`);
        error.stack = `${error.message}\n    at open (${userPath}\\store.js:9:9)`;
        throw error;
      },
    });
    for (const flags of [[], ["--json"]]) {
      const { code, stdout } = await run(ctx, out, "status", ...flags);
      expect(code).toBe(1);
      expect(stdout).not.toContain(secret);
      expect(stdout).not.toContain("alice.martin");
      expect(stdout).not.toContain("store.js");
      expect(stdout).toContain(PRIVATE_USER);
    }
    const json = JSON.parse((await run(ctx, out, "status", "--json")).stdout) as Record<
      string,
      unknown
    >;
    expect(json).toMatchObject({ ok: false, error: { code: "internal" } });
  });
});

describe("consultations sans effet externe", () => {
  it("aucune commande n'ouvre de réseau ni ne lance de processus", async () => {
    const attempts: string[] = [];
    const deny = (name: string) => () => {
      attempts.push(name);
      throw new Error(`interdit : ${name}`);
    };
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(deny("net.connect"));
    vi.spyOn(net, "createConnection").mockImplementation(deny("net.createConnection"));
    vi.spyOn(net, "createServer").mockImplementation(deny("net.createServer"));
    vi.spyOn(tls, "connect").mockImplementation(deny("tls.connect"));
    vi.spyOn(http, "request").mockImplementation(deny("http.request"));
    vi.spyOn(http, "createServer").mockImplementation(deny("http.createServer"));
    vi.spyOn(https, "request").mockImplementation(deny("https.request"));
    vi.spyOn(dns, "lookup").mockImplementation(deny("dns.lookup"));
    vi.spyOn(childProcess, "spawn").mockImplementation(deny("spawn"));
    vi.spyOn(childProcess, "exec").mockImplementation(deny("exec"));
    vi.spyOn(childProcess, "execFile").mockImplementation(deny("execFile"));
    vi.spyOn(childProcess, "fork").mockImplementation(deny("fork"));
    vi.stubGlobal("fetch", deny("fetch"));

    const uow = new MemoryUnitOfWork();
    seedProfile(uow, revisionWithGuard(ENABLED_GUARD));
    const out: string[] = [];
    const ctx = context(uow, out);
    for (const argv of [
      ["doctor"],
      ["status"],
      ["journal"],
      ["policy", "show"],
      ["init"],
      ["--help"],
    ]) {
      await run(ctx, out, ...argv);
      await run(ctx, out, ...argv, "--json");
    }
    expect(attempts).toEqual([]);
    expect(uow.profiles.get(DEFAULT_PROFILE_ID)?.state).toBe("blocked");
    expect(uow.sessions.listOpen(DEFAULT_PROFILE_ID)).toEqual([]);
  });

  it("l'aide présente une interface locale, sans transaction ni guest", () => {
    expect(USAGE).toContain("Interface locale de MIND Wake pour votre propre agent");
    expect(USAGE).toContain("Aucune commande de paiement");
    expect(USAGE).not.toMatch(/wallet|\$MIND/i);
  });
});
