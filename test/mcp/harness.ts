/**
 * Harnais multi-processus du serveur MCP MIND : un processus hub, puis un processus
 * `server-main.ts` (stdio) par partie, piloté par un vrai client MCP. Aucun port réseau :
 * pipe nommé local et fichiers SQLite temporaires.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { digest } from "../../services/advice/conversation/capability.js";
import { localPipePath } from "../../services/advice/conversation/framing.js";
import type { PartyConfig } from "../../services/mcp/config.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOOKS = pathToFileURL(join(ROOT, "test/fixtures/store-ledger/ts-hooks.ts")).href;
export const MCP_DIR = join(ROOT, "services/mcp");
export const CLI_MAIN = join(ROOT, "src/cli/main.ts");
export const NODE_ARGS = [
  "--disable-warning=ExperimentalWarning",
  "--experimental-transform-types",
  "--import",
  HOOKS,
];

export type PartyName = "agent" | "guide" | "guideEn" | "agentGuide" | "mute";

/** Identifiants privés témoins : ne doivent jamais apparaître dans une sortie d'outil. */
export const PRIVATE_IDS: Record<PartyName, string> = {
  agent: "agent.owner@example.org",
  guide: "alice.guide@example.com",
  guideEn: "bob.guide@example.net",
  agentGuide: "helper-agent-private-7c1e",
  mute: "carol.readonly@example.com",
};

function parties(): Record<PartyName, Omit<PartyConfig, "keyDigest" | "privateId">> {
  return {
    agent: {
      kind: "agent",
      permissions: { message: true, requestHelp: true, guide: false },
      fictiveBudget: { funding: "100", unitPrice: "2", maxExchanges: 5 },
    },
    guide: {
      kind: "human",
      permissions: { message: true, requestHelp: false, guide: true },
      guide: {
        topics: ["petits systèmes émergents", "automates cellulaires"],
        languages: ["fr", "en"],
        termsVersion: "guide-terms-1",
      },
    },
    guideEn: {
      kind: "human",
      permissions: { message: true, requestHelp: false, guide: true },
      guide: { topics: ["emergent systems"], languages: ["en"], termsVersion: "terms-en-1" },
    },
    agentGuide: {
      kind: "agent",
      permissions: { message: true, requestHelp: false, guide: true },
      guide: { topics: ["systèmes émergents"], languages: ["fr"], termsVersion: "agent-terms-1" },
    },
    mute: {
      kind: "human",
      permissions: { message: false, requestHelp: false, guide: false },
    },
  };
}

export interface ToolCall {
  readonly data: Record<string, unknown>;
  readonly isError: boolean;
  readonly raw: string;
}

export interface PartyClient {
  readonly client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<ToolCall>;
  close(): Promise<void>;
}

export interface Harness {
  readonly dir: string;
  readonly pipe: string;
  readonly keys: Record<PartyName, string>;
  /** Toutes les sorties brutes d'outils, toutes parties confondues. */
  readonly outputs: string[];
  party(name: PartyName, extraEnv?: Record<string, string>): Promise<PartyClient>;
  /** Client MCP sans hub configuré (lectures Wake seulement). */
  wakeOnly(dataDir: string): Promise<PartyClient>;
  hubStderr(): string;
  close(): Promise<void>;
}

export async function startHarness(
  options: { rateLimit?: { writesPerMinute: number; callsPerMinute: number } } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "mind-mcp-"));
  const pipe = localPipePath("mind-mcp-test");
  const keys = {} as Record<PartyName, string>;
  const configured: PartyConfig[] = [];
  for (const [name, party] of Object.entries(parties()) as [PartyName, PartyConfig][]) {
    const key = randomBytes(24).toString("base64url");
    keys[name] = key;
    configured.push({ ...party, privateId: PRIVATE_IDS[name], keyDigest: digest(key) });
  }
  const configPath = join(dir, "hub.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      parties: configured,
      ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
      closeGraceMs: 0,
    }),
  );
  const hub = spawn(
    process.execPath,
    [
      ...NODE_ARGS,
      join(MCP_DIR, "hub-main.ts"),
      "--config",
      configPath,
      "--dir",
      join(dir, "hub"),
      "--pipe",
      pipe,
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: minimalEnv() },
  );
  let stderr = "";
  hub.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  await waitReady(hub, () => stderr);

  const outputs: string[] = [];
  const clients: PartyClient[] = [];
  const connect = async (env: Record<string, string>): Promise<PartyClient> => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...NODE_ARGS, join(MCP_DIR, "server-main.ts")],
      env: { ...minimalEnv(), ...env },
      stderr: "pipe",
    });
    const client = new Client({ name: "mind-mcp-test", version: "0.0.0" });
    await client.connect(transport);
    const party: PartyClient = {
      client,
      async call(name, args = {}) {
        const result = await client.callTool({ name, arguments: args });
        const first = (result.content as { type: string; text?: string }[])[0];
        const raw = first?.text ?? "";
        outputs.push(raw);
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          data = { unparsed: raw };
        }
        return { data, isError: result.isError === true, raw };
      },
      close: () => client.close(),
    };
    clients.push(party);
    return party;
  };

  return {
    dir,
    pipe,
    keys,
    outputs,
    party: (name, extraEnv = {}) =>
      connect({
        MIND_MCP_HUB_PIPE: pipe,
        MIND_MCP_LINK_KEY: keys[name],
        // Jamais le dossier Wake réel de l'utilisateur pendant les tests.
        MIND_WAKE_DATA_DIR: join(dir, "no-wake-data"),
        ...extraEnv,
      }),
    wakeOnly: (dataDir) => connect({ MIND_WAKE_DATA_DIR: dataDir }),
    hubStderr: () => stderr,
    async close() {
      for (const c of clients) await c.close().catch(() => undefined);
      hub.kill();
      await new Promise((resolve) => hub.once("exit", resolve));
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function waitReady(child: ChildProcess, stderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`hub non prêt : ${stderr()}`));
    }, 20_000);
    if (child.stdout === null) throw new Error("stdout du hub absent");
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.includes('"ready":true')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`hub arrêté (${String(code)}) : ${stderr()}`));
    });
  });
}

/** Environnement minimal : aucune variable de l'hôte (clés, chemins privés) héritée. */
export function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

let keyCounter = 0;
export function idem(label = "k"): string {
  keyCounter += 1;
  return `${label}-${String(keyCounter)}-${randomBytes(4).toString("hex")}`;
}
