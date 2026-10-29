/**
 * Adapter Codex contre un faux exécutable `codex` (test/fixtures/codex/fake-codex.ts) qui
 * rejoue des flux app-server enregistrés. Aucun appel modèle, aucun réseau, aucun
 * credential : ces tests ne prouvent pas l'intégration réelle (AGENTS §5).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AdapterEvent,
  PolicyRevision,
  ProfileId,
  ReservationId,
  SessionId,
  StartRequest,
  UtcTimestamp,
} from "../../contracts/index.js";
import { defaultRegistry } from "../../daemon/registry.js";
import { canReadQuota } from "../../runner/host.js";
import type { Sandbox } from "../../sandbox/sandbox.js";
import { SpawnedCodexProcess } from "../../../test/fixtures/codex/process.js";
import {
  appContainerLauncher,
  buildAppServerCommand,
  classifyCodexError,
  CODEX_ADAPTER_ID,
  CODEX_SUPPORTED_VERSION,
  CODEX_DEFAULT_MODEL,
  codexRegistration,
  codexRegistrationFromEnv,
  CodexAdapter,
  CodexAdapterError,
  CodexConfigError,
  FileThreadStore,
  hostLauncher,
  hostPassthroughEnv,
  MemoryThreadStore,
  parseCodexVersion,
  quotaFromRateLimitsResponse,
  type CodexAdapterOptions,
  type CodexCommand,
  type CodexLauncher,
  type IsolationAttestation,
  type ProviderTransport,
  type SandboxLike,
} from "./index.js";

const FAKE = fileURLToPath(new URL("../../../test/fixtures/codex/fake-codex.ts", import.meta.url));
const FLOWS = fileURLToPath(new URL("../../../test/fixtures/codex/flows/", import.meta.url));

interface Harness {
  readonly dir: string;
  readonly logPath: string;
  readonly launches: CodexCommand[];
  flow: string;
  attestation: IsolationAttestation;
  launcher: CodexLauncher;
  log(): Record<string, unknown>[];
  requests(method: string): Record<string, unknown>[];
}

const CONFINED: IsolationAttestation = {
  confined: true,
  selfTestPassed: true,
  detail: "AppContainer de test",
};

let h: Harness;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mindwake-codex-test-"));
  const logPath = path.join(dir, "fake-codex.log");
  const launches: CodexCommand[] = [];
  const harness: Harness = {
    dir,
    logPath,
    launches,
    flow: "success.json",
    attestation: CONFINED,
    launcher: {
      isolation: () => harness.attestation,
      launch: (_sessionId, command) => {
        launches.push(command);
        return new SpawnedCodexProcess(command, {
          FAKE_CODEX_FLOW: path.join(FLOWS, harness.flow),
          FAKE_CODEX_LOG: logPath,
        });
      },
    },
    log: () =>
      fs.existsSync(logPath)
        ? fs
            .readFileSync(logPath, "utf8")
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [],
    requests: (method) => harness.log().filter((e) => e["method"] === method),
  };
  fs.mkdirSync(path.join(dir, "codex-home"));
  fs.mkdirSync(path.join(dir, "workspace"));
  h = harness;
});

afterEach(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

const closed: ProviderTransport = {
  open: () =>
    Promise.resolve({
      configOverrides: { model_provider: '"wake_relay"' },
      env: { WAKE_RELAY_PIPE: "mindwake-broker-test" },
      close: () => Promise.resolve(),
    }),
};

/** Surcharges ; `undefined` retire l'option (par exemple le transport). */
type Overrides = { [K in keyof CodexAdapterOptions]?: CodexAdapterOptions[K] | undefined };

function adapter(overrides: Overrides = {}): CodexAdapter {
  const options: Record<string, unknown> = {
    executable: { path: process.execPath, prefixArgs: [FAKE] },
    codexHome: path.join(h.dir, "codex-home"),
    workspaceDir: path.join(h.dir, "workspace"),
    launcher: h.launcher,
    transport: closed,
    threads: new MemoryThreadStore(),
    systemPrompt: "Tu es l'agent Wake.",
    model: "gpt-test",
    effort: "medium",
    requestTimeoutMs: 5_000,
    versionCheck: () =>
      Promise.resolve(`codex-cli ${CODEX_SUPPORTED_VERSION}
`),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) Reflect.deleteProperty(options, key);
    else options[key] = value;
  }
  return new CodexAdapter(options as unknown as CodexAdapterOptions);
}

let counter = 0;
function request(profile = "profil-1"): StartRequest {
  counter += 1;
  return {
    sessionId: `session-${String(counter)}` as SessionId,
    reservationId: `res-${String(counter)}` as ReservationId,
    policy: {
      profileId: profile as ProfileId,
      groups: { runtime: {} },
    } as unknown as PolicyRevision,
    context: "Reprends l'expérience des automates.",
    maxInputTokens: 10_000,
    deadline: "2030-01-01T00:00:00.000Z" as UtcTimestamp,
  };
}

async function collect(a: CodexAdapter, req: StartRequest): Promise<AdapterEvent[]> {
  const handle = await a.start(req);
  const events: AdapterEvent[] = [];
  for await (const event of a.events(handle)) events.push(event);
  return events;
}

describe("protocole app-server", () => {
  it("lit la version de `codex --version`", () => {
    expect(parseCodexVersion("codex-cli 0.165.0\n")).toBe("0.165.0");
    expect(parseCodexVersion("rien")).toBeNull();
  });

  it("classe les codes d'erreur officiels", () => {
    expect(classifyCodexError("unauthorized").kind).toBe("auth_failed");
    expect(classifyCodexError({ httpConnectionFailed: { httpStatusCode: 401 } }).kind).toBe(
      "auth_failed",
    );
    expect(classifyCodexError("usageLimitExceeded").kind).toBe("rate_limited");
    expect(classifyCodexError({ responseStreamDisconnected: { httpStatusCode: 429 } }).kind).toBe(
      "rate_limited",
    );
    expect(classifyCodexError("serverOverloaded").kind).toBe("transient");
    expect(classifyCodexError("modelNotFound").kind).toBe("incompatible");
    expect(classifyCodexError("cyberPolicy").kind).toBe("fatal");
    expect(classifyCodexError(null).kind).toBe("fatal");
  });

  it("convertit la jauge sans deviner une fenêtre incomplète", () => {
    const reading = quotaFromRateLimitsResponse(
      {
        rateLimits: {},
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_793_300_000 },
            secondary: { usedPercent: 7, windowDurationMins: null, resetsAt: 1_793_900_000 },
          },
        },
      },
      "2026-10-29T12:00:00.000Z" as UtcTimestamp,
    );
    expect(reading.snapshots).toEqual([
      {
        windowKey: "codex:primary",
        windowDurationMs: 18_000_000,
        usedBasisPoints: 4_200,
        resetsAt: new Date(1_793_300_000_000).toISOString(),
        observedAt: "2026-10-29T12:00:00.000Z",
        provenance: "measured",
      },
    ]);
    expect(reading.incomplete.map((w) => w.windowKey)).toEqual(["codex:secondary"]);
  });
});

describe("commande", () => {
  it("CODEX_HOME dédié, aucune variable au nom de secret, réglages Wake prioritaires", () => {
    const base = {
      executable: { path: "C:\\codex\\codex.exe" },
      codexHome: path.join(h.dir, "codex-home"),
      workspaceDir: path.join(h.dir, "workspace"),
    };
    const command = buildAppServerCommand({
      ...base,
      channel: {
        configOverrides: { request_max_retries: "9", model_provider: '"wake_relay"' },
        env: {},
        close: () => Promise.resolve(),
      },
    });
    expect(command.env).toEqual({ CODEX_HOME: base.codexHome });
    expect(command.args.slice(-3)).toEqual(["app-server", "--listen", "stdio://"]);
    expect(command.args).toContain("request_max_retries=1");
    expect(command.args).not.toContain("request_max_retries=9");
    expect(command.args).toContain('shell_environment_policy.inherit="none"');
    expect(() =>
      buildAppServerCommand({
        ...base,
        channel: {
          configOverrides: {},
          env: { OPENAI_API_KEY: "x" },
          close: () => Promise.resolve(),
        },
      }),
    ).toThrow(CodexConfigError);
    expect(() =>
      buildAppServerCommand({
        ...base,
        codexHome: path.join(os.homedir(), ".codex"),
        channel: null,
      }),
    ).toThrow(/dossier Codex de l'utilisateur/);
  });
});

describe("sonde et capacités", () => {
  it("version figée disponible, capacités honnêtes", async () => {
    const a = adapter({ versionCheck: undefined });
    const probe = await a.probe();
    expect(probe).toMatchObject({
      adapterId: CODEX_ADAPTER_ID,
      version: CODEX_SUPPORTED_VERSION,
      available: true,
      simulated: false,
    });
    const caps = await a.capabilities();
    expect(caps).toMatchObject({
      tokenCapEnforcement: "provider_quota_guard",
      providerQuotaReading: "official",
      cancellation: "graceful",
      residualUsageBound: null,
    });
  });

  it("une autre version est indisponible et refusée au lancement", async () => {
    const a = adapter({ versionCheck: () => Promise.resolve("codex-cli 0.147.0") });
    expect(await a.probe()).toMatchObject({ available: false, version: "0.147.0" });
    await expect(a.start(request())).rejects.toMatchObject({ code: "version_unsupported" });
    expect(h.launches).toHaveLength(0);
  });

  it("binaire absent : indisponible", async () => {
    const a = adapter({ versionCheck: () => Promise.reject(new Error("ENOENT")) });
    expect(await a.probe()).toMatchObject({ available: false });
  });
});

describe("lancement et isolation", () => {
  it("refuse le mode autonome hors sandbox vérifiée", async () => {
    h.attestation = { confined: true, selfTestPassed: false, detail: "autotest absent" };
    await expect(adapter().start(request())).rejects.toBeInstanceOf(CodexAdapterError);
    h.attestation = { confined: false, selfTestPassed: false, detail: "hôte" };
    await expect(adapter().start(request())).rejects.toMatchObject({ code: "isolation_required" });
    expect(h.launches).toHaveLength(0);
  });

  it("refuse un conteneur sans transport fournisseur", async () => {
    await expect(adapter({ transport: undefined }).start(request())).rejects.toMatchObject({
      code: "transport_required",
    });
  });

  it("sous AppContainer vérifié : sans approbation, sans sandbox Codex", async () => {
    await collect(adapter(), request());
    const [thread] = h.requests("thread/start");
    expect(thread?.["params"]).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: "Tu es l'agent Wake.",
      model: "gpt-test",
    });
    // Environnement demandé par l'adapter : rien d'hérité, seulement CODEX_HOME et le relais.
    // (Le lanceur de test, un `spawn` ordinaire, laisse libuv ajouter PATH, USERPROFILE…
    // les lanceurs de production construisent un bloc d'environnement explicite.)
    expect(Object.keys(h.launches[0]?.env ?? {}).sort()).toEqual(["CODEX_HOME", "WAKE_RELAY_PIPE"]);
    const launch = h.log().find((e) => e["kind"] === "launch");
    expect(launch?.["envKeys"]).toEqual(expect.arrayContaining(["CODEX_HOME", "WAKE_RELAY_PIPE"]));
    expect(h.launches[0]?.args).toContain('model_provider="wake_relay"');
  });

  it("mode manuel hors conteneur : approbations coupées mais sandbox Codex conservée", async () => {
    h.attestation = { confined: false, selfTestPassed: false, detail: "hôte" };
    await collect(adapter({ mode: "manual", transport: undefined }), request());
    const [thread] = h.requests("thread/start");
    expect(thread?.["params"]).toMatchObject({
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
  });
});

describe("flux d'événements", () => {
  it("tour réussi : début, activité, usage par catégorie, fin ; rapprochement mesuré", async () => {
    const quota: unknown[] = [];
    const a = adapter({ onQuota: (r) => quota.push(r) });
    const req = request();
    const events = await collect(a, req);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("started");
    expect(types.at(-1)).toBe("ended");
    const usage = events.filter((e) => e.type === "usage");
    // Le relevé d'un autre tour (turn_0) sert de point de départ, sans compter.
    expect(usage.map((u) => u.quantity)).toEqual([
      { unit: "tokens", amount: 150 },
      { unit: "tokens", amount: 60 },
    ]);
    expect(usage[0]).toMatchObject({
      provenance: "measured",
      tokenBreakdown: { input: 80, cached_input: 20, output: 40, reasoning: 10 },
    });
    const summaries = events.flatMap((e) => (e.type === "activity" ? [e.summary] : []));
    expect(summaries).toContain("commande : python sim.py");
    expect(summaries).toContain("message : J'ai lancé la simulation.");
    expect(summaries.join(" ")).not.toContain("pensée privée");
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "completed" });
    expect(quota).toHaveLength(1);
    expect(await a.reconcile(req.sessionId)).toEqual({
      status: "confirmed",
      ended: true,
      usage: [{ unit: "tokens", amount: 210 }],
      provenance: "measured",
    });
    expect(h.requests("turn/start")[0]?.["params"]).toMatchObject({
      threadId: "thr_1",
      effort: "medium",
      input: [{ type: "text", text: "Reprends l'expérience des automates." }],
    });
  });

  it("limitation fournisseur : rate_limited avec le délai officiel de remise à zéro", async () => {
    h.flow = "rate-limited.json";
    const now = new Date(1_793_299_000_000);
    const a = adapter({ clock: () => now });
    const req = request();
    const events = await collect(a, req);
    const limited = events.find((e) => e.type === "rate_limited");
    expect(limited).toMatchObject({ retryAfterMs: 1_000_000 });
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "failed" });
    expect(await a.reconcile(req.sessionId)).toMatchObject({ status: "uncertain" });
  });

  it("aucun compte connecté : auth_failed avant tout fil ni tour", async () => {
    h.flow = "auth-missing.json";
    const events = await collect(adapter(), request());
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "auth_failed" });
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "auth_required" });
    expect(h.requests("thread/start")).toHaveLength(0);
    expect(h.requests("turn/start")).toHaveLength(0);
  });

  it("401 en cours de tour : auth_failed ; une erreur retentée reste une activité", async () => {
    h.flow = "auth-unauthorized.json";
    const events = await collect(adapter(), request());
    expect(events.filter((e) => e.type === "error")).toEqual([
      expect.objectContaining({ code: "auth_failed", message: "401 Unauthorized" }),
    ]);
    expect(
      events.some((e) => e.type === "activity" && e.summary.includes("nouvelle tentative")),
    ).toBe(true);
  });

  it("flux coupé : erreur transitoire, fin, usage incertain", async () => {
    h.flow = "stream-cut.json";
    const a = adapter();
    const req = request();
    const events = await collect(a, req);
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "transient" });
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "stream_cut" });
    const reconcile = await a.reconcile(req.sessionId);
    expect(reconcile).toMatchObject({ status: "uncertain" });
    expect(reconcile.status === "uncertain" && reconcile.detail).toContain("150 tokens mesurés");
  });

  it("refuse les requêtes du serveur (approbations)", async () => {
    h.flow = "approval-request.json";
    await collect(adapter(), request());
    const replies = h.log().filter((e) => e["kind"] === "reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.["message"]).toMatchObject({ error: { code: -32601 } });
  });
});

describe("annulation", () => {
  it("tour interrompu : turn/interrupt coopératif, puis arrêt du serveur", async () => {
    h.flow = "interrupted.json";
    const a = adapter();
    const req = request();
    const handle = await a.start(req);
    const events: AdapterEvent[] = [];
    for await (const event of a.events(handle)) {
      events.push(event);
      if (event.type === "usage") {
        expect(await a.cancel(handle, 2_000)).toMatchObject({ status: "cancelled" });
      }
    }
    expect(h.requests("turn/interrupt")[0]?.["params"]).toEqual({
      threadId: "thr_1",
      turnId: "turn_1",
    });
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "interrupted" });
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(await a.reconcile(req.sessionId)).toMatchObject({ status: "uncertain" });
  });

  it("serveur qui ignore l'interruption : terminaison forcée dans le délai", async () => {
    h.flow = "stubborn.json";
    const a = adapter();
    const handle = await a.start(request());
    const events: AdapterEvent[] = [];
    for await (const event of a.events(handle)) {
      events.push(event);
      if (event.type === "started") {
        const result = await a.cancel(handle, 400);
        expect(result.status).toBe("forced");
        expect(result.status === "forced" && result.within).toBeLessThan(1_000);
      }
    }
    expect(events.at(-1)).toMatchObject({ type: "ended" });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("session inconnue : annulation et rapprochement non confirmés", async () => {
    const a = adapter();
    const handle = {
      adapterId: CODEX_ADAPTER_ID,
      sessionId: "x" as SessionId,
      startedAt: "2026-10-29T00:00:00.000Z" as UtcTimestamp,
    };
    expect(await a.cancel(handle, 100)).toMatchObject({ status: "unconfirmed" });
    expect(await a.reconcile("x" as SessionId)).toMatchObject({ status: "uncertain" });
  });
});

describe("continuité", () => {
  it("fil persisté et repris ; prompt système réinjecté seulement s'il change", async () => {
    const threads = new FileThreadStore(path.join(h.dir, "threads"));
    await collect(adapter({ threads }), request());
    expect(h.requests("thread/start")).toHaveLength(1);

    await collect(adapter({ threads }), request());
    const resumes = h.requests("thread/resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.["params"]).toMatchObject({ threadId: "thr_1" });
    expect(resumes[0]?.["params"]).not.toHaveProperty("developerInstructions");

    await collect(adapter({ threads, systemPrompt: "Prompt révisé." }), request());
    expect(h.requests("thread/resume")[1]?.["params"]).toMatchObject({
      developerInstructions: "Prompt révisé.",
    });
    await collect(adapter({ threads, systemPrompt: "Prompt révisé." }), request());
    expect(h.requests("thread/resume")[2]?.["params"]).not.toHaveProperty("developerInstructions");
    expect(h.requests("thread/start")).toHaveLength(1);
  });

  it("fil refusé : nouveau fil avec le prompt système", async () => {
    const threads = new MemoryThreadStore();
    threads.save("profil-1", {
      threadId: "thr_old",
      promptFingerprint: "0".repeat(64),
      updatedAt: "2026-10-28T00:00:00.000Z" as UtcTimestamp,
    });
    h.flow = "resume-refused.json";
    const events = await collect(adapter({ threads }), request());
    expect(h.requests("thread/start")[0]?.["params"]).toMatchObject({
      developerInstructions: "Tu es l'agent Wake.",
    });
    expect(threads.load("profil-1")?.threadId).toBe("thr_1");
    expect(events.at(-1)).toMatchObject({ exitReason: "completed" });
  });

  it("un fichier de fil altéré est ignoré", () => {
    const store = new FileThreadStore(path.join(h.dir, "threads"));
    store.save("k", {
      threadId: "thr_9",
      promptFingerprint: "a".repeat(64),
      updatedAt: "2026-10-29T00:00:00.000Z" as UtcTimestamp,
    });
    expect(store.load("k")?.threadId).toBe("thr_9");
    const file = fs.readdirSync(path.join(h.dir, "threads"))[0] ?? "";
    fs.writeFileSync(path.join(h.dir, "threads", file), '{"threadId":"../../x"}');
    expect(store.load("k")).toBeNull();
  });
});

describe("jauge de quota", () => {
  it("lecture officielle sans fil ni tour", async () => {
    const reading = await adapter().readProviderQuota();
    expect(reading.snapshots.map((s) => [s.windowKey, s.usedBasisPoints])).toEqual([
      ["codex:primary", 4_200],
    ]);
    expect(reading.incomplete.map((w) => w.windowKey)).toEqual(["codex:secondary"]);
    expect(h.requests("account/rateLimits/read")).toHaveLength(1);
    expect(h.requests("thread/start")).toHaveLength(0);
    expect(h.requests("turn/start")).toHaveLength(0);
  });
});

describe("lanceur AppContainer", () => {
  it("n'atteste l'autotest que pour le lanceur testé", () => {
    const sandbox: SandboxLike = {
      health: () => ({ operational: true, detail: "ok" }),
      launch: () => {
        throw new Error("non lancé");
      },
    };
    const make = (digest: string | null) =>
      appContainerLauncher({
        sandbox,
        launcherDigest: "abc",
        selfTest: digest === null ? null : { passed: true, launcherDigest: digest },
        jobName: (s) => `job-${s}`,
        readWriteRoots: [],
        readOnlyRoots: [],
        protectedPaths: [],
      }).isolation("s" as SessionId);
    expect(make("abc")).toMatchObject({ confined: true, selfTestPassed: true });
    expect(make("old")).toMatchObject({ confined: true, selfTestPassed: false });
    expect(make(null)).toMatchObject({ selfTestPassed: false });
  });

  it("la Sandbox de production satisfait le port", () => {
    const check = (sandbox: Sandbox): SandboxLike => sandbox;
    expect(typeof check).toBe("function");
  });
});

describe("flux réels enregistrés (codex-cli 0.147.0, expurgés)", () => {
  const manual = (quota: unknown[] = []): CodexAdapter => {
    h.attestation = { confined: false, selfTestPassed: false, detail: "hôte" };
    return adapter({
      mode: "manual",
      hostSandbox: "read-only",
      transport: undefined,
      acceptedVersions: ["0.147.0"],
      versionCheck: () => Promise.resolve("codex-cli 0.147.0"),
      onQuota: (r) => quota.push(r),
    });
  };

  it("tour « OK » : usage mesuré, jauge reçue pendant le tour, rapprochement confirmé", async () => {
    h.flow = "real-0.147.0-ok.json";
    const quota: unknown[] = [];
    const a = manual(quota);
    const req = request();
    const events = await collect(a, req);
    expect(events.map((e) => e.type)).toEqual(["started", "activity", "usage", "ended"]);
    expect(events[1]).toMatchObject({ summary: "message : OK" });
    expect(events[2]).toMatchObject({
      quantity: { unit: "tokens", amount: 8_196 },
      provenance: "measured",
      tokenBreakdown: { input: 8_191, cached_input: 0, output: 5, reasoning: 0 },
    });
    expect(quota).toEqual([
      expect.objectContaining({
        snapshots: [
          expect.objectContaining({
            windowKey: "codex:primary",
            windowDurationMs: 604_800_000,
            usedBasisPoints: 2_800,
            resetsAt: "2026-11-04T06:38:41.000Z",
          }),
        ],
      }),
    ]);
    expect(await a.reconcile(req.sessionId)).toMatchObject({
      status: "confirmed",
      usage: [{ unit: "tokens", amount: 8_196 }],
    });
    expect(h.requests("thread/start")[0]?.["params"]).toMatchObject({ sandbox: "read-only" });
  });

  it("modèle refusé (`codexErrorInfo: other`, 400 model_not_found) : incompatible", async () => {
    h.flow = "real-0.147.0-model-not-found.json";
    const a = manual();
    const req = request();
    const events = await collect(a, req);
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "incompatible" });
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "failed" });
    expect(await a.reconcile(req.sessionId)).toMatchObject({ status: "uncertain" });
  });

  it("une version non validée reste refusée en mode autonome", async () => {
    const a = adapter({
      acceptedVersions: ["0.147.0"],
      versionCheck: () => Promise.resolve("codex-cli 0.147.0"),
    });
    expect(await a.probe()).toMatchObject({ available: false });
    await expect(a.start(request())).rejects.toMatchObject({ code: "version_unsupported" });
  });

  it("le CODEX_HOME de l'utilisateur n'est admis qu'en mode manuel", async () => {
    const userHome = path.join(os.homedir(), ".codex");
    await expect(
      adapter({ codexHome: userHome, allowUserCodexHome: true }).start(request()),
    ).rejects.toThrow(/dossier Codex de l'utilisateur/);
    expect(h.launches).toHaveLength(0);
  });
});

describe("alignement ADR-006 et câblage", () => {
  const HOST: IsolationAttestation = { confined: false, selfTestPassed: false, detail: "hôte" };

  it("hôte non isolé avec consentement ADR-006 : sans approbation, signalé au journal", async () => {
    h.attestation = HOST;
    const a = adapter({ transport: undefined, hostUnattendedConsent: () => true });
    const events = await collect(a, request());
    expect(h.launches[0]?.unattended).toBe(true);
    expect(h.requests("thread/start")[0]?.["params"]).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(events[0]).toMatchObject({
      type: "activity",
      summary: expect.stringContaining("NON ISOLÉ") as unknown,
    });
  });

  it("hôte non isolé sans consentement : refus en autonome, rien de lancé", async () => {
    h.attestation = HOST;
    const a = adapter({ transport: undefined, hostUnattendedConsent: () => false });
    await expect(a.start(request())).rejects.toMatchObject({ code: "isolation_required" });
    expect(h.launches).toHaveLength(0);
  });

  it("readQuota : lecture hors session par quotaLauncher, sans mode sans approbation", async () => {
    h.attestation = HOST;
    const quotaLaunches: string[] = [];
    const a = adapter({
      transport: undefined,
      quotaLauncher: {
        isolation: () => HOST,
        launch: (sessionId, command) => {
          quotaLaunches.push(sessionId);
          expect(command.unattended).toBe(false);
          return h.launcher.launch(sessionId, command);
        },
      },
    });
    const snapshots = await a.readQuota();
    expect(snapshots.map((s) => s.usedBasisPoints)).toEqual([4_200]);
    expect(quotaLaunches).toHaveLength(1);
  });

  it("readQuota : lecture impossible = tableau vide (quota inconnu)", async () => {
    const a = adapter({ versionCheck: () => Promise.resolve("codex-cli 0.1.0") });
    expect(await a.readQuota()).toEqual([]);
  });

  it("hostLauncher : isolation du runner par session, `unattended` transmis", () => {
    const spawned: unknown[] = [];
    const host = {
      spawnContained: (_s: SessionId, command: unknown) => {
        spawned.push(command);
        return {} as never;
      },
      authorize: () => ({ allowed: false, reason: "test", interruptSession: false }),
      isolation: (s: SessionId) => (s === ("confinée" as SessionId) ? "sandbox" : "none") as never,
    };
    const launcher = hostLauncher(host);
    expect(launcher.isolation("confinée" as SessionId)).toMatchObject({ confined: true });
    expect(launcher.isolation("autre" as SessionId)).toMatchObject({ confined: false });
    launcher.launch("autre" as SessionId, {
      executable: "codex.exe",
      args: [],
      env: {},
      cwd: h.dir,
      unattended: true,
    });
    expect(spawned[0]).toMatchObject({ executable: "codex.exe", unattended: true });
  });

  it("codexRegistration : runtime déclaré, facturation par quota, fabrique", () => {
    const registration = codexRegistration({
      executable: { path: path.join(h.dir, "bin", "codex.exe") },
      codexHome: path.join(h.dir, "codex-home"),
      model: "gpt-5.6-luna",
      systemPrompt: "p",
      threadsDir: path.join(h.dir, "threads"),
    });
    expect(registration).toMatchObject({ id: CODEX_ADAPTER_ID, simulated: false });
    expect(registration.runtime()).toEqual({
      adapterId: CODEX_ADAPTER_ID,
      provider: "openai",
      model: "gpt-5.6-luna",
      authMode: "chatgpt",
    });
    expect(registration.billing()).toEqual({ kind: "subscription_quota" });
    expect(registration.runtimeRoots?.()).toEqual([path.join(h.dir, "bin")]);
    const created = registration.create({
      host: {
        spawnContained: () => {
          throw new Error("aucun lancement");
        },
        authorize: () => ({ allowed: false, reason: "test", interruptSession: false }),
        isolation: () => "none",
      },
      dataDir: h.dir,
      workspaceDir: path.join(h.dir, "workspace"),
      experimentFor: () => null,
      onProposal: () => undefined,
      fakeScenario: () => undefined,
    });
    expect(created).toBeInstanceOf(CodexAdapter);
    expect(canReadQuota(created)).toBe(true);
  });

  it("registre par défaut : Codex enregistré, configuration lue dans l'environnement", () => {
    expect(defaultRegistry().realIds()).toContain(CODEX_ADAPTER_ID);
    const fromEnv = codexRegistrationFromEnv({
      MIND_WAKE_CODEX_BIN: path.join(h.dir, "codex.exe"),
      MIND_WAKE_CODEX_MODEL: "gpt-6-luna",
      MIND_WAKE_CODEX_EFFORT: "low",
    });
    expect(fromEnv.runtime().model).toBe("gpt-6-luna");
    expect(fromEnv.runtimeRoots?.()).toEqual([h.dir]);
    expect(codexRegistrationFromEnv({}).runtime().model).toBe(CODEX_DEFAULT_MODEL);
  });

  it("consentement ADR-006 lu par défaut dans runtime.hostUnsandboxedAcknowledged", async () => {
    h.attestation = { confined: false, selfTestPassed: false, detail: "hôte" };
    const consented = {
      ...request(),
      policy: {
        profileId: "profil-1" as ProfileId,
        groups: { runtime: { hostUnsandboxedAcknowledged: true } },
      } as unknown as PolicyRevision,
    };
    const events = await collect(adapter({ transport: undefined }), consented);
    expect(h.launches[0]?.unattended).toBe(true);
    expect(events.at(-1)).toMatchObject({ exitReason: "completed" });
    await expect(adapter({ transport: undefined }).start(request())).rejects.toMatchObject({
      code: "isolation_required",
    });
  });

  it("sur l'hôte, le lanceur ajoute le profil Windows ; dans la sandbox, non", () => {
    const spawned: { env?: Record<string, string> }[] = [];
    const make = (mode: "sandbox" | "host_unsandboxed") =>
      hostLauncher({
        spawnContained: (_s, command) => {
          spawned.push(command);
          return {} as never;
        },
        authorize: () => ({ allowed: false, reason: "test", interruptSession: false }),
        isolation: () => mode,
      });
    const command = { executable: "codex.exe", args: [], env: { CODEX_HOME: h.dir }, cwd: h.dir };
    make("host_unsandboxed").launch("s" as SessionId, command);
    make("sandbox").launch("s" as SessionId, command);
    expect(Object.keys(spawned[0]?.env ?? {})).toEqual(
      expect.arrayContaining(["CODEX_HOME", ...Object.keys(hostPassthroughEnv())]),
    );
    expect(spawned[1]?.env).toEqual({ CODEX_HOME: h.dir });
  });

  it("pendant une session, readQuota réutilise la jauge reçue en fin de tour", async () => {
    const a = adapter();
    const handle = await a.start(request());
    for await (const event of a.events(handle)) {
      if (event.type === "usage") break;
    }
    const before = h.launches.length;
    // Jauge du flux enregistré : reçue à l'instant, donc réutilisée sans nouveau processus.
    const snapshots = await a.readQuota();
    expect(snapshots.map((s) => s.windowKey)).toEqual(["codex:primary"]);
    expect(h.launches.length).toBe(before);
    await a.cancel(handle, 500);
  });
});
