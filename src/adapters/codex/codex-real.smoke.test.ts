/**
 * Test de fumée RÉEL, désactivé par défaut : il consomme le quota d'abonnement de
 * l'utilisateur. Activation explicite : `MIND_WAKE_REAL_SMOKE=1`.
 *
 * Bornes : client officiel `codex` et connexion déjà configurée par l'utilisateur
 * (`CODEX_HOME` existant, jamais lu ni copié par ce test), sur l'hôte, mode manuel,
 * sandbox Codex `read-only`, aucune approbation et aucun mode sans approbation, serveurs
 * MCP et fonctions annexes désactivés, fil éphémère, un seul tour avec un prompt minimal,
 * puis une lecture de jauge. Aucune nouvelle tentative : une erreur d'authentification
 * ou une limitation arrête le test.
 *
 * Variables facultatives :
 * - `MIND_WAKE_CODEX_BIN` : chemin du binaire (sinon `where codex`) ;
 * - `MIND_WAKE_REAL_SMOKE_OUT` : fichier du bilan JSON expurgé ;
 * - `MIND_WAKE_REAL_SMOKE_FIXTURE` : fichier du flux expurgé, au format du faux `codex` ;
 * - `MIND_WAKE_REAL_SMOKE_MODEL`, `MIND_WAKE_REAL_SMOKE_EFFORT` : modèle et effort (sinon
 *   ceux de la configuration de l'utilisateur) ;
 * - `MIND_WAKE_REAL_SMOKE_SKIP_QUOTA=1` : ne pas relire la jauge (budget d'appels épuisé).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AdapterEvent,
  PolicyRevision,
  ProfileId,
  ReservationId,
  SessionId,
  StartRequest,
  UtcTimestamp,
} from "../../contracts/index.js";
import { SpawnedCodexProcess, type TranscriptLine } from "../../../test/fixtures/codex/process.js";
import {
  CODEX_SUPPORTED_VERSION,
  CodexAdapter,
  MemoryThreadStore,
  type CodexCommand,
  type QuotaReading,
} from "./index.js";

const ENABLED = process.env["MIND_WAKE_REAL_SMOKE"] === "1";
/** Version installée sur le poste de développement au 29 octobre 2026 (non validée). */
const SMOKE_VERSIONS = [CODEX_SUPPORTED_VERSION, "0.147.0"];

/** Fonctions annexes de Codex désactivées pour ce test (`codex features list`). */
const DISABLED_FEATURES = [
  "apps",
  "plugins",
  "hooks",
  "memories",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "multi_agent",
  "goals",
];

function codexBinary(): string {
  const given = process.env["MIND_WAKE_CODEX_BIN"];
  if (given !== undefined) return given;
  const found = execFileSync("where", ["codex"], { encoding: "utf8" })
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().endsWith(".exe"));
  if (found === undefined) throw new Error("codex.exe introuvable");
  return found.trim();
}

/** Noms des serveurs MCP configurés, pour les désactiver (aucune valeur d'environnement lue). */
function mcpServerNames(binary: string, overrides: Readonly<Record<string, string>>): string[] {
  // Listés avec les fonctions annexes déjà désactivées : un serveur fourni par un plugin
  // n'existe plus, et le surcharger créerait une entrée invalide qui empêche le démarrage.
  const args = Object.entries(overrides).flatMap(([k, v]) => ["-c", `${k}=${v}`]);
  const out = execFileSync(binary, [...args, "mcp", "list", "--json"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const value: unknown = JSON.parse(out);
  const list = Array.isArray(value) ? value : [];
  return list.flatMap((entry: unknown) => {
    const name = (entry as { name?: unknown } | null)?.name;
    return typeof name === "string" && /^[A-Za-z0-9_-]+$/.test(name) ? [name] : [];
  });
}

const SECRET_KEY = /(token|secret|password|cookie|credential|apikey|api_key|authorization)$/i;
const PERSONAL_KEY =
  /^(email|accountId|chatgptAccountId|userId|balance|name|serverName|installationId)$/;

/** Expurge un message : identifiants personnels, secrets éventuels, chemins du poste. */
function redact(value: unknown, home: string, user: string): unknown {
  if (typeof value === "string") {
    return value.split(home).join("<HOME>").split(user).join("<USER>");
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, home, user));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        typeof v === "string" && (SECRET_KEY.test(key) || PERSONAL_KEY.test(key))
          ? "<redacted>"
          : redact(v, home, user),
      ]),
    );
  }
  return value;
}

/** Transcription → flux du faux `codex` : chaque réponse suivie des notifications reçues. */
function toFlow(transcript: readonly TranscriptLine[], version: string): unknown {
  const methods = new Map<number, string>();
  const on: Record<string, { result?: unknown; error?: unknown; then: unknown[] }> = {};
  let current: { then: unknown[] } | null = null;
  for (const { dir, line } of transcript) {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (dir === "out") {
      if (typeof message["id"] === "number" && typeof message["method"] === "string") {
        methods.set(message["id"], message["method"]);
      }
      continue;
    }
    const id = message["id"];
    if (typeof message["method"] === "string") {
      if (id === undefined)
        current?.then.push({ notify: message["method"], params: message["params"] });
      continue;
    }
    const method = typeof id === "number" ? methods.get(id) : undefined;
    if (method === undefined || on[method] !== undefined) continue;
    const handler =
      message["error"] === undefined
        ? { result: message["result"], then: [] }
        : { error: message["error"], then: [] };
    on[method] = handler;
    current = handler;
  }
  return { version: `codex-cli ${version}`, recordedAt: new Date().toISOString(), on };
}

describe.skipIf(!ENABLED)("Codex réel (fumée, opt-in MIND_WAKE_REAL_SMOKE=1)", () => {
  it("un tour minimal en read-only puis la jauge officielle", async () => {
    const binary = codexBinary();
    const codexHome = process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex");
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mindwake-codex-smoke-"));
    const extraConfig: Record<string, string> = { web_search: '"disabled"' };
    for (const feature of DISABLED_FEATURES) extraConfig[`features.${feature}`] = "false";
    for (const name of mcpServerNames(binary, extraConfig))
      extraConfig[`mcp_servers.${name}.enabled`] = "false";

    const commands: CodexCommand[] = [];
    const transcripts: TranscriptLine[][] = [];
    const quota: QuotaReading[] = [];
    const adapter = new CodexAdapter({
      executable: { path: binary },
      codexHome,
      workspaceDir: workspace,
      mode: "manual",
      hostSandbox: "read-only",
      ephemeralThreads: true,
      acceptedVersions: SMOKE_VERSIONS,
      allowUserCodexHome: true,
      launcher: {
        isolation: () => ({ confined: false, selfTestPassed: false, detail: "hôte (fumée)" }),
        launch: (_sessionId, command) => {
          commands.push(command);
          const process_ = new SpawnedCodexProcess(command, {}, true);
          if (process_.transcript !== null) transcripts.push(process_.transcript);
          return process_;
        },
      },
      threads: new MemoryThreadStore(),
      systemPrompt: "Test de fumée MIND Wake. N'utilise aucun outil.",
      extraConfig,
      ...(process.env["MIND_WAKE_REAL_SMOKE_MODEL"] === undefined
        ? {}
        : { model: process.env["MIND_WAKE_REAL_SMOKE_MODEL"] }),
      ...(process.env["MIND_WAKE_REAL_SMOKE_EFFORT"] === undefined
        ? {}
        : { effort: process.env["MIND_WAKE_REAL_SMOKE_EFFORT"] }),
      requestTimeoutMs: 90_000,
      onQuota: (r) => quota.push(r),
    });

    const probe = await adapter.probe();
    expect(probe.available).toBe(true);

    const request: StartRequest = {
      sessionId: `smoke-${String(Date.now())}` as SessionId,
      reservationId: "smoke" as ReservationId,
      policy: { profileId: "smoke" as ProfileId } as PolicyRevision,
      context: "Réponds seulement OK",
      maxInputTokens: 1_000,
      deadline: new Date(Date.now() + 180_000).toISOString() as UtcTimestamp,
    };
    const handle = await adapter.start(request);
    const events: AdapterEvent[] = [];
    for await (const event of adapter.events(handle)) events.push(event);
    const reconcile = await adapter.reconcile(request.sessionId);

    const stopped = events.some(
      (e) => e.type === "rate_limited" || (e.type === "error" && e.code === "auth_failed"),
    );
    // Une seule lecture de jauge, et seulement si rien n'impose l'arrêt.
    const skipQuota = process.env["MIND_WAKE_REAL_SMOKE_SKIP_QUOTA"] === "1";
    const reading = stopped || skipQuota ? null : await adapter.readProviderQuota();

    const home = os.homedir();
    const user = path.basename(home);
    const summary = redact(
      {
        version: probe.version,
        probe,
        command: commands.map((c) => ({
          executable: c.executable,
          args: c.args,
          envKeys: Object.keys(c.env),
        })),
        events,
        reconcile,
        quotaDuringTurn: reading === null ? quota : quota.slice(0, -1),
        quotaRead: reading,
      },
      home,
      user,
    );
    const out = process.env["MIND_WAKE_REAL_SMOKE_OUT"];
    if (out !== undefined) fs.writeFileSync(out, JSON.stringify(summary, null, 2));
    const fixture = process.env["MIND_WAKE_REAL_SMOKE_FIXTURE"];
    if (fixture !== undefined && transcripts[0] !== undefined) {
      const flow = redact(toFlow(transcripts[0], probe.version), home, user);
      fs.writeFileSync(fixture, `${JSON.stringify(flow, null, 2)}\n`);
    }
    fs.rmSync(workspace, { recursive: true, force: true });

    expect(events[0]?.type).toBe("started");
    expect(events.at(-1)?.type).toBe("ended");
    expect(stopped).toBe(false);
    expect(events.some((e) => e.type === "usage")).toBe(true);
    if (!skipQuota) expect(reading?.snapshots.length ?? 0).toBeGreaterThan(0);
  }, 300_000);
});
