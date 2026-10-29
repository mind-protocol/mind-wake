import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AdapterEvent,
  ReservationId,
  SessionId,
  StartRequest,
  UtcTimestamp,
} from "../../contracts/index.js";
import type { AdapterHost } from "../../runner/host.js";
import type { ContainedProcess } from "../../runner/process-tree.js";
import type { Sandbox, SandboxLaunchSpec, SandboxedProcess } from "../../sandbox/sandbox.js";
import { ChildClaude } from "../../../test/fixtures/claude/child-process.js";
import {
  CLAUDE_ADAPTER_ID,
  ClaudeAdapter,
  ClaudeAdapterError,
  claudeEnvironment,
  ClaudeEnvironmentError,
  claudeSessionUuid,
  compareVersions,
  hostClaudeLauncher,
  MemoryConversationStore,
  parseStreamLine,
  quotaSnapshots,
  sandboxClaudeLauncher,
  type ClaudeAdapterOptions,
  type ClaudeIsolation,
  type ClaudeLauncher,
  type ClaudeLaunchSpec,
  type ClaudeNetworkPort,
  type ClaudeQuotaSignal,
} from "./index.js";

const FAKE_CLAUDE = fileURLToPath(
  new URL("../../../test/fixtures/claude/fake-claude.ts", import.meta.url),
);

interface Harness {
  readonly dir: string;
  readonly workspace: string;
  readonly configDir: string;
  readonly promptDir: string;
  readonly state: string;
  readonly log: string;
  readonly launches: ClaudeLaunchSpec[];
  readonly processes: ChildClaude[];
  scenario: string;
  isolation: ClaudeIsolation;
  launcher: ClaudeLauncher;
}

let h: Harness;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mindwake-claude-"));
  const sub = (name: string): string => {
    const p = path.join(dir, name);
    fs.mkdirSync(p);
    return p;
  };
  const harness: Harness = {
    dir,
    workspace: sub("workspace"),
    configDir: sub("claude-config"),
    promptDir: sub("prompts"),
    state: sub("state"),
    log: path.join(dir, "invocations.jsonl"),
    launches: [],
    processes: [],
    scenario: "success",
    isolation: { kind: "appcontainer", selfTestPassed: true, detail: "test" },
    launcher: {
      isolation: () => harness.isolation,
      launch: (spec) => {
        harness.launches.push(spec);
        const child = new ChildClaude(spec, {
          SystemRoot: process.env["SystemRoot"] ?? "",
          FAKE_CLAUDE_SCENARIO: harness.scenario,
          FAKE_CLAUDE_STATE: harness.state,
          FAKE_CLAUDE_LOG: harness.log,
        });
        harness.processes.push(child);
        return child;
      },
    },
  };
  h = harness;
});

afterEach(async () => {
  for (const child of h.processes) await child.terminateTree();
  fs.rmSync(h.dir, { recursive: true, force: true });
});

function network(): ClaudeNetworkPort & { opened: SessionId[]; closed: SessionId[] } {
  const opened: SessionId[] = [];
  const closed: SessionId[] = [];
  return {
    opened,
    closed,
    open: (sessionId) => {
      opened.push(sessionId);
      return Promise.resolve({
        broker: { pipeName: "mindwake-broker-test", port: 1 },
        env: { HTTPS_PROXY: "http://relais.invalid:1" },
      });
    },
    close: (sessionId) => {
      closed.push(sessionId);
      return Promise.resolve();
    },
  };
}

/** `network: null` retire le relais fournisseur. */
function adapter(
  overrides: Partial<Omit<ClaudeAdapterOptions, "network">> & {
    network?: ClaudeNetworkPort | null;
  } = {},
): ClaudeAdapter {
  const { network: port, ...rest } = overrides;
  const relay = port === undefined ? network() : port;
  return new ClaudeAdapter({
    launcher: h.launcher,
    ...(relay === null ? {} : { network: relay }),
    autonomy: "autonomous",
    executable: process.execPath,
    executablePrefixArgs: [FAKE_CLAUDE],
    configDir: h.configDir,
    promptDir: h.promptDir,
    systemPrompt: "Tu es l'agent Wake.",
    workspaceFor: () => h.workspace,
    ...rest,
  });
}

function request(sessionId: string, context = "Que veux-tu explorer ?"): StartRequest {
  return {
    sessionId: sessionId as SessionId,
    reservationId: "r1" as ReservationId,
    policy: {} as StartRequest["policy"],
    context,
    maxInputTokens: 10_000,
    deadline: new Date(Date.now() + 60_000).toISOString() as UtcTimestamp,
  };
}

async function run(subject: ClaudeAdapter, sessionId: string): Promise<AdapterEvent[]> {
  const handle = await subject.start(request(sessionId));
  const events: AdapterEvent[] = [];
  for await (const event of subject.events(handle)) events.push(event);
  return events;
}

function invocations(): { argv: string[]; env: string[]; cwd: string }[] {
  return fs
    .readFileSync(h.log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { argv: string[]; env: string[]; cwd: string });
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

describe("adapter Claude Code : sonde et capacités", () => {
  it("lit la version par --version et refuse une version trop ancienne", async () => {
    const probe = await adapter().probe();
    expect(probe).toMatchObject({
      adapterId: CLAUDE_ADAPTER_ID,
      version: "2.1.308",
      available: true,
      simulated: false,
    });
    expect(probe.executionMechanism).toContain("claude -p");

    const missing = await adapter({
      executable: path.join(h.dir, "absent.exe"),
      executablePrefixArgs: [],
    }).probe();
    expect(missing).toMatchObject({ available: false, version: "unknown" });
    expect(compareVersions("2.1.100", "2.1.273")).toBe(-1);
    expect(compareVersions("2.2.0", "2.1.273")).toBe(1);
  });

  it("déclare des capacités honnêtes et liées à l'isolation réelle", async () => {
    const caps = await adapter().capabilities();
    expect(caps).toMatchObject({
      tokenCounting: "exact",
      countedCategories: ["input", "cached_input", "output"],
      tokenCapEnforcement: "provider_quota_guard",
      providerQuotaReading: "official",
      cancellation: "forced_only",
      residualUsageBound: null,
      isolationCompatible: true,
    });
    h.isolation = { kind: "host_job", detail: "hôte" };
    expect((await adapter().capabilities()).isolationCompatible).toBe(false);
  });
});

describe("adapter Claude Code : garde d'isolation", () => {
  it("refuse le mode autonome hors sandbox, sans rien lancer", async () => {
    h.isolation = { kind: "host_job", detail: "hôte" };
    await expect(adapter().start(request("s-host"))).rejects.toMatchObject({
      code: "isolation_required",
    });
    h.isolation = { kind: "appcontainer", selfTestPassed: false, detail: "autotest échoué" };
    await expect(adapter().start(request("s-fail"))).rejects.toBeInstanceOf(ClaudeAdapterError);
    expect(h.launches).toHaveLength(0);
  });

  it("refuse un lancement confiné sans relais fournisseur", async () => {
    const subject = adapter({ network: null });
    await expect(subject.start(request("s-net"))).rejects.toMatchObject({
      code: "transport_unavailable",
    });
    expect(h.launches).toHaveLength(0);
  });

  it("en mode supervisé, jamais de mode sans approbation : liste d'outils seule", async () => {
    h.isolation = { kind: "host_job", detail: "hôte" };
    const events = await run(adapter({ autonomy: "supervised", network: null }), "s-sup");
    expect(events.at(-1)).toMatchObject({ type: "ended" });
    const [call] = invocations();
    expect(call?.argv).not.toContain("--dangerously-skip-permissions");
    expect(flagValue(call?.argv ?? [], "--permission-mode")).toBe("dontAsk");
    expect(flagValue(call?.argv ?? [], "--permission-prompts")).toBe("none");
    expect(flagValue(call?.argv ?? [], "--allowedTools")).toBe("Bash,Read,Edit,Write,Glob,Grep");
  });
});

describe("adapter Claude Code : mode non isolé sur l'hôte (ADR-006)", () => {
  const hostSource = {
    USERPROFILE: "C:/Users/humain",
    APPDATA: "C:/Users/humain/AppData/Roaming",
    PATH: "C:/Windows",
    ANTHROPIC_API_KEY: "ne-doit-pas-passer",
    CLAUDE_CODE_OAUTH_TOKEN: "ne-doit-pas-passer",
  };

  it("passe --dangerously-skip-permissions seulement avec le consentement distinct", async () => {
    h.isolation = { kind: "host_job", detail: "Job Object du runner" };
    let consent = false;
    const subject = adapter({
      network: null,
      hostUnsandboxedAcknowledged: () => consent,
      hostEnvSource: hostSource,
    });
    await expect(subject.start(request("s-refus"))).rejects.toMatchObject({
      code: "isolation_required",
      message: expect.stringContaining("hostUnsandboxedAcknowledged") as unknown,
    });
    expect(h.launches).toHaveLength(0);
    expect((await subject.probe()).executionMechanism).not.toContain("NON ISOLÉ");

    consent = true;
    const probe = await subject.probe();
    expect(probe.executionMechanism).toContain("NON ISOLÉ");
    expect((await subject.capabilities()).isolationCompatible).toBe(false);
    const events = await run(subject, "s-host");

    const [call] = invocations();
    expect(call?.argv).toContain("--dangerously-skip-permissions");
    expect(call?.argv).not.toContain("--permission-mode");
    expect(events[0]).toMatchObject({ type: "activity" });
    expect(events[0]?.type === "activity" ? events[0].summary : "").toContain("NON ISOLÉ");
    expect(events[1]).toMatchObject({ type: "started" });
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "result:completed" });

    const env = h.launches[0]?.env ?? {};
    expect(env).toMatchObject({ USERPROFILE: hostSource.USERPROFILE, PATH: "C:/Windows" });
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(h.launches[0]?.network).toBeNull();
  });

  it("relit le consentement à chaque lancement : une révocation bloque le suivant", async () => {
    h.isolation = { kind: "host_job", detail: "Job Object du runner" };
    let consent = true;
    const subject = adapter({
      network: null,
      hostUnsandboxedAcknowledged: () => consent,
      hostEnvSource: hostSource,
    });
    await run(subject, "s-ok");
    consent = false;
    await expect(subject.start(request("s-revoque"))).rejects.toBeInstanceOf(ClaudeAdapterError);
    expect(h.launches).toHaveLength(1);
  });

  it("le consentement n'affecte ni la sandbox ni le mode supervisé", async () => {
    h.isolation = { kind: "host_job", detail: "hôte" };
    await run(
      adapter({ autonomy: "supervised", network: null, hostUnsandboxedAcknowledged: () => true }),
      "s-sup",
    );
    expect(invocations()[0]?.argv).not.toContain("--dangerously-skip-permissions");
    h.isolation = { kind: "appcontainer", selfTestPassed: false, detail: "autotest échoué" };
    await expect(
      adapter({ hostUnsandboxedAcknowledged: () => true }).start(request("s-ac")),
    ).rejects.toMatchObject({ code: "isolation_required" });
  });
});

describe("adapter Claude Code : session", () => {
  it("charge seulement la configuration MCP explicitement fournie", async () => {
    await run(adapter({ mcpConfigFile: path.join(h.configDir, "mind-mcp.json") }), "mcp-explicit");
    const argv = invocations()[0]?.argv ?? [];
    expect(argv).toContain("--strict-mcp-config");
    expect(flagValue(argv, "--mcp-config")).toBe(path.join(h.configDir, "mind-mcp.json"));
  });

  it("lance dans la sandbox avec session fixée, outils listés et environnement minimal", async () => {
    const net = network();
    const subject = adapter({ network: net });
    const events = await run(subject, "s1");

    const [call] = invocations();
    const argv = call?.argv ?? [];
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(flagValue(argv, "--session-id")).toBe(claudeSessionUuid("s1", 0));
    expect(argv).not.toContain("--resume");
    expect(flagValue(argv, "--model")).toBe("opus");
    expect(flagValue(argv, "--output-format")).toBe("stream-json");
    expect(flagValue(argv, "--input-format")).toBe("stream-json");
    expect(flagValue(argv, "--tools")).toBe("Bash,Read,Edit,Write,Glob,Grep");
    expect(flagValue(argv, "--setting-sources")).toBe("user");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).not.toContain("--mcp-config");
    const promptFile = flagValue(argv, "--system-prompt-file") ?? "";
    expect(path.dirname(promptFile)).toBe(h.promptDir);
    expect(fs.readFileSync(promptFile, "utf8")).toBe("Tu es l'agent Wake.");
    expect(fs.realpathSync(call?.cwd ?? "")).toBe(fs.realpathSync(h.workspace));

    const launch = h.launches[0];
    expect(launch?.env).toMatchObject({
      CLAUDE_CONFIG_DIR: h.configDir,
      HTTPS_PROXY: "http://relais.invalid:1",
    });
    expect(Object.keys(launch?.env ?? {}).some((k) => /KEY|TOKEN|SECRET|AUTH/i.test(k))).toBe(
      false,
    );
    expect(launch?.network?.broker?.pipeName).toBe("mindwake-broker-test");
    expect(launch?.readWriteRoots).toEqual([h.workspace, h.configDir]);
    expect(launch?.readOnlyRoots).toContain(h.promptDir);

    expect(events.map((e) => e.type)).toEqual([
      "started",
      "activity",
      "activity",
      "activity",
      "usage",
      "ended",
    ]);
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toMatchObject({
      quantity: { unit: "tokens", amount: 200 },
      provenance: "measured",
      tokenBreakdown: { input: 120, cached_input: 30, output: 50 },
    });
    expect(JSON.stringify(events)).not.toContain("Terminé");
    expect(events.at(-1)).toMatchObject({ exitReason: "result:completed" });

    expect(h.processes[0]?.hasExited).toBe(true);
    expect(net.opened).toEqual(["s1"]);
    expect(net.closed).toEqual(["s1"]);
    expect(await subject.reconcile("s1" as SessionId)).toEqual({
      status: "confirmed",
      ended: true,
      usage: [{ unit: "tokens", amount: 200 }],
      provenance: "measured",
    });
  });

  it("reprend la conversation par --resume et ne compte que l'usage du réveil", async () => {
    const conversations = new MemoryConversationStore();
    let prompt = "Manuel v1";
    const subject = adapter({
      conversations,
      conversationKeyFor: () => "experience-1",
      systemPrompt: () => prompt,
    });
    await run(subject, "s1");
    const second = await run(subject, "s2");
    prompt = "Manuel v2";
    const third = await run(subject, "s3");

    const calls = invocations();
    const uuid = claudeSessionUuid("experience-1", 0);
    expect(flagValue(calls[0]?.argv ?? [], "--session-id")).toBe(uuid);
    expect(flagValue(calls[1]?.argv ?? [], "--resume")).toBe(uuid);
    expect(calls[1]?.argv).not.toContain("--session-id");
    // Le prompt accompagne chaque appel ; inchangé, il réutilise le même fichier.
    expect(flagValue(calls[1]?.argv ?? [], "--system-prompt-file")).toBe(
      flagValue(calls[0]?.argv ?? [], "--system-prompt-file"),
    );
    expect(second.some((e) => e.type === "activity" && e.summary.includes("prompt"))).toBe(false);
    expect(second.find((e) => e.type === "usage")).toMatchObject({ quantity: { amount: 200 } });

    const thirdPrompt = flagValue(calls[2]?.argv ?? [], "--system-prompt-file") ?? "";
    expect(thirdPrompt).not.toBe(flagValue(calls[0]?.argv ?? [], "--system-prompt-file"));
    expect(fs.readFileSync(thirdPrompt, "utf8")).toBe("Manuel v2");
    expect(third[0]).toMatchObject({ type: "activity" });
    expect(third.find((e) => e.type === "usage")).toMatchObject({ quantity: { amount: 200 } });
    expect(conversations.get("experience-1")).toMatchObject({ started: true, generation: 0 });
  });

  it("repart sur une nouvelle conversation quand la reprise est impossible", async () => {
    const conversations = new MemoryConversationStore();
    const subject = adapter({ conversations, conversationKeyFor: () => "exp" });
    await run(subject, "s1");
    for (const file of fs.readdirSync(h.state)) fs.rmSync(path.join(h.state, file));

    const failed = await run(subject, "s2");
    expect(failed.find((e) => e.type === "error")).toMatchObject({ code: "transient" });
    expect(failed.at(-1)).toMatchObject({ type: "ended" });
    expect(conversations.get("exp")).toMatchObject({ generation: 1, started: false });

    const fresh = await run(subject, "s3");
    expect(fresh.find((e) => e.type === "usage")).toMatchObject({ quantity: { amount: 200 } });
    const calls = invocations();
    expect(flagValue(calls[2]?.argv ?? [], "--session-id")).toBe(claudeSessionUuid("exp", 1));
  });

  it("traduit une limitation en rate_limited avec le délai officiel, sans erreur", async () => {
    h.scenario = "rate_limited";
    const signals: ClaudeQuotaSignal[] = [];
    const events = await run(
      adapter({ onQuotaSignal: (_s, signal) => signals.push(signal) }),
      "s-rl",
    );
    const limited = events.filter((e) => e.type === "rate_limited");
    expect(limited).toHaveLength(1);
    const retry = limited[0]?.type === "rate_limited" ? limited[0].retryAfterMs : null;
    expect(retry).toBeGreaterThan(3_500_000);
    expect(retry).toBeLessThanOrEqual(3_600_000);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(signals[0]).toMatchObject({ status: "rejected", creditsRequired: false });
    expect(events.at(-1)).toMatchObject({ type: "ended" });
  });

  it("signale un échec d'authentification", async () => {
    h.scenario = "auth_failed";
    const events = await run(adapter(), "s-auth");
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "auth_failed" });
    expect(events.at(-1)).toMatchObject({ type: "ended" });
  });

  it("un flux coupé finit en erreur et laisse l'usage incertain", async () => {
    h.scenario = "cut";
    const net = network();
    const subject = adapter({ network: net });
    const events = await run(subject, "s-cut");
    expect(events.at(-2)).toMatchObject({ type: "error", code: "transient" });
    expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "stream_cut" });
    expect(net.closed).toEqual(["s-cut"]);
    expect(await subject.reconcile("s-cut" as SessionId)).toMatchObject({ status: "uncertain" });
  });

  it("annule une session bloquée dans le délai, sans affirmer d'usage", async () => {
    h.scenario = "hang";
    const net = network();
    const subject = adapter({ network: net });
    const handle = await subject.start(request("s-hang"));
    const iterator = subject.events(handle)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "started" });
    expect(await subject.reconcile("s-hang" as SessionId)).toMatchObject({ status: "uncertain" });

    const cancelled = await subject.cancel(handle, 1_000);
    expect(cancelled.status).toBe("forced");
    expect(net.closed).toEqual(["s-hang"]);
    const rest: AdapterEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      rest.push(next.value);
    }
    expect(rest.at(-1)).toMatchObject({ type: "ended", exitReason: "stream_cut" });
    expect(await subject.reconcile("s-hang" as SessionId)).toMatchObject({ status: "uncertain" });
    expect(await subject.reconcile("inconnue" as SessionId)).toMatchObject({ status: "uncertain" });
  });
});

describe("adapter Claude Code : jauge de quota", () => {
  it("lit /usage sans outils ni session conservée et convertit la jauge", async () => {
    const net = network();
    const reading = await adapter({ network: net }).readQuotaReading(10_000);
    // Mesuré : cette variable prive `/usage` de sa jauge ; les sessions la gardent.
    expect(h.launches[0]?.env).not.toHaveProperty("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC");
    expect(reading.unavailable).toBeUndefined();
    expect(reading.snapshots).toEqual([
      expect.objectContaining({
        windowKey: "claude:session",
        windowDurationMs: 5 * 3_600_000,
        usedBasisPoints: 2350,
        resetsAt: "2026-10-29T18:00:00.000Z",
        provenance: "measured",
      }),
      expect.objectContaining({
        windowKey: "claude:weekly_scoped:Opus",
        windowDurationMs: 7 * 24 * 3_600_000,
        usedBasisPoints: 6100,
      }),
    ]);
    expect(reading.unmapped).toEqual(["monthly_mystery"]);
    const [call] = invocations();
    expect(flagValue(call?.argv ?? [], "--tools")).toBe("");
    expect(call?.argv).toContain("--no-session-persistence");
    expect(call?.argv).not.toContain("--dangerously-skip-permissions");
    expect(net.opened).toHaveLength(1);
    expect(net.closed).toEqual(net.opened);
    expect(h.processes[0]?.hasExited).toBe(true);
  });

  it("arrondit vers le haut sans bruit flottant et borne à 10 000", () => {
    const at = "2026-10-29T12:00:00.000Z" as UtcTimestamp;
    const reading = quotaSnapshots(
      [
        { kind: "session", percent: 0.1, resetsAt: at, scope: null },
        { kind: "seven_day", percent: 12.341, resetsAt: at, scope: null },
        { kind: "weekly_all", percent: 130, resetsAt: at, scope: null },
      ],
      at,
    );
    expect(reading.snapshots.map((s) => s.usedBasisPoints)).toEqual([10, 1235, 10_000]);
  });
});

describe("adapter Claude Code : briques", () => {
  it("lit les lignes stream-json sans jamais lever", () => {
    expect(parseStreamLine("pas du json")).toEqual({ kind: "malformed" });
    expect(parseStreamLine("[1]")).toEqual({ kind: "malformed" });
    expect(parseStreamLine('{"type":"stream_event"}')).toEqual({
      kind: "ignored",
      type: "stream_event",
    });
    expect(
      parseStreamLine('{"type":"assistant","error":"account_on_hold","message":{"content":[]}}'),
    ).toEqual({ kind: "assistant_error", error: "account_on_hold" });
    expect(
      parseStreamLine(
        '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","errorCode":"credits_required"}}',
      ),
    ).toMatchObject({ kind: "rate_limit", creditsRequired: true, resetsAtMs: null });
    expect(
      parseStreamLine(
        '{"type":"result","subtype":"error_max_turns","usage":{"input_tokens":3,"output_tokens":4}}',
      ),
    ).toMatchObject({
      kind: "result",
      isError: true,
      tokens: { input: 3, cachedInput: 0, output: 4 },
    });
  });

  it("refuse toute variable au nom de secret, y compris venant du relais", () => {
    expect(() =>
      claudeEnvironment({ configDir: "c", network: { CLAUDE_CODE_OAUTH_TOKEN: "x" } }),
    ).toThrow(ClaudeEnvironmentError);
    expect(() =>
      claudeEnvironment({ configDir: "c", network: { ANTHROPIC_API_KEY: "x" } }),
    ).toThrow(ClaudeEnvironmentError);
    expect(claudeEnvironment({ configDir: "c", gitBashPath: "b" })).toEqual({
      CLAUDE_CONFIG_DIR: "c",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_GIT_BASH_PATH: "b",
    });
  });

  it("dérive un UUID stable et valide par clé et génération", () => {
    const uuid = claudeSessionUuid("exp", 0);
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(claudeSessionUuid("exp", 0)).toBe(uuid);
    expect(claudeSessionUuid("exp", 1)).not.toBe(uuid);
  });

  it("le lanceur sandbox transmet broker, racines, job et filet de durée", () => {
    const launched: SandboxLaunchSpec[] = [];
    let healthy = true;
    const sandbox = {
      health: () => ({ operational: healthy, detail: "ok" }),
      launch: (spec: SandboxLaunchSpec) => {
        launched.push(spec);
        return {} as SandboxedProcess;
      },
    } as unknown as Sandbox;
    const launcher = sandboxClaudeLauncher({
      sandbox,
      selfTestPassed: () => true,
      jobNameFor: (id) => `job-${id}`,
      protectedPaths: ["C:\\data"],
      maxProcesses: 8,
      now: () => Date.parse("2026-10-29T12:00:00Z"),
    });
    expect(launcher.isolation()).toMatchObject({ kind: "appcontainer", selfTestPassed: true });
    healthy = false;
    expect(launcher.isolation()).toMatchObject({ selfTestPassed: false });
    launcher.launch({
      sessionId: "s" as SessionId,
      executable: "C:\\claude\\claude.exe",
      args: ["-p"],
      cwd: "C:\\ws",
      env: { CLAUDE_CONFIG_DIR: "C:\\cfg" },
      readWriteRoots: ["C:\\ws"],
      readOnlyRoots: ["C:\\claude"],
      network: { broker: { pipeName: "p", port: 9 }, env: {} },
      deadline: "2026-10-29T12:01:00.000Z" as UtcTimestamp,
      unattended: false,
    });
    expect(launched[0]).toMatchObject({
      jobName: "job-s",
      protectedPaths: ["C:\\data"],
      maxProcesses: 8,
      maxWallMs: 60_000,
      broker: { pipeName: "p", port: 9 },
    });
  });

  it("le lanceur hôte passe par l'arborescence contenue du runner", () => {
    const spawned: unknown[] = [];
    const host: AdapterHost = {
      spawnContained: (sessionId, command) => {
        spawned.push({ sessionId, command });
        return {} as ContainedProcess;
      },
      authorize: () => ({ allowed: false, reason: "test", interruptSession: false }),
      isolation: (sessionId) =>
        sessionId === "nonisole"
          ? "host_unsandboxed"
          : sessionId === "boite"
            ? "sandbox"
            : "job_only",
    };
    const launcher = hostClaudeLauncher(host, 4);
    expect(launcher.isolation()).toMatchObject({ kind: "host_job", unsandboxedConsent: false });
    expect(launcher.isolation("s" as SessionId)).toMatchObject({ unsandboxedConsent: false });
    expect(launcher.isolation("nonisole" as SessionId)).toMatchObject({
      kind: "host_job",
      unsandboxedConsent: true,
    });
    expect(launcher.isolation("boite" as SessionId)).toMatchObject({
      kind: "appcontainer",
      selfTestPassed: true,
    });
    launcher.launch({
      sessionId: "s" as SessionId,
      executable: "claude",
      args: ["-p"],
      cwd: "ws",
      env: { A: "1" },
      readWriteRoots: [],
      readOnlyRoots: [],
      network: null,
      deadline: "2026-10-29T12:01:00.000Z" as UtcTimestamp,
      unattended: false,
    });
    expect(spawned[0]).toEqual({
      sessionId: "s",
      command: {
        executable: "claude",
        args: ["-p"],
        cwd: "ws",
        env: { A: "1" },
        unattended: false,
        maxProcesses: 4,
      },
    });
  });
});
