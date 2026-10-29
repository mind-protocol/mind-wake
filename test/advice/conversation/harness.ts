/**
 * Harnais multi-processus du canal guest SIMULÉ : une passerelle, des adaptateurs MCP
 * côté guide et des agents guest factices, chacun dans son propre processus Node.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { digest, opaque } from "../../../services/advice/conversation/capability.js";
import type { ConversationEvent } from "../../../services/advice/conversation/events.js";
import { localPipePath } from "../../../services/advice/conversation/framing.js";
import { GatewayLink } from "../../../services/advice/conversation/link.js";
import { PROTOCOL_VERSION } from "../../../services/advice/conversation/protocol.js";
import type { GatewayConfig } from "../../../services/advice/conversation/service.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HOOKS = pathToFileURL(join(ROOT, "test/fixtures/store-ledger/ts-hooks.ts")).href;
const CONVERSATION = join(ROOT, "services/advice/conversation");
export const NODE_ARGS = ["--disable-warning=ExperimentalWarning", "--import", HOOKS];

/** Identités privées et secrets témoins : ne doivent jamais traverser le canal. */
export const GUIDE_PRIVATE_ID = "alice.guide@example.com";
export const OWNER_PRIVATE_ID = "bob.owner@example.org";
export const HOST_SECRET = ["sk-proj-", "HostWitness", "Secret0123456789abcd"].join("");
export const GUEST_PRIVATE_TOKEN = ["guest-private-", "token-", "7f3a9c"].join("");
export const GUEST_SYSTEM_PROMPT_MARKER = "GUEST-SYSTEM-PROMPT-MARKER-91c2";
export const GUEST_MEMORY_MARKER = "GUEST-PRIOR-MEMORY-MARKER-55e1";

export interface Invitation {
  readonly invitation: string;
  readonly guestKey: string;
  readonly sessionRef: string;
}

export interface Harness {
  readonly dir: string;
  readonly pipe: string;
  readonly guideKey: string;
  readonly otherGuideKey: string;
  readonly operatorKey: string;
  readonly invitations: readonly Invitation[];
  readonly gatewayStderr: () => string;
  events(): ConversationEvent[];
  guestHome(name: string): string;
  track(child: ChildProcess): void;
  stop(): Promise<void>;
}

const key = (): string => randomBytes(24).toString("base64url");

export async function startHarness(
  options: { invitations?: number; ttlMs?: number; retain?: boolean } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "mind-advice-"));
  const pipe = localPipePath("mind-advice-test");
  const guideKey = key();
  const otherGuideKey = key();
  const operatorKey = key();
  const invitations: Invitation[] = Array.from({ length: options.invitations ?? 1 }, (_, i) => ({
    invitation: opaque("inv"),
    guestKey: key(),
    sessionRef: `sess_sim_${String(i + 1)}`,
  }));
  const config: GatewayConfig = {
    guides: [
      { privateId: GUIDE_PRIVATE_ID, keyDigest: digest(guideKey) },
      { privateId: "mallory.other@example.net", keyDigest: digest(otherGuideKey) },
    ],
    invitations: invitations.map((inv) => ({
      invitation: inv.invitation,
      sessionRef: inv.sessionRef,
      topic: "small emergent systems",
      ownerPrivateId: OWNER_PRIVATE_ID,
      guestKeyDigest: digest(inv.guestKey),
    })),
    operatorKeyDigest: digest(operatorKey),
    encounterTtlMs: options.ttlMs ?? 60_000,
    retainTranscriptAfterClose: options.retain ?? false,
  };
  const configPath = join(dir, "gateway-config.json");
  const eventsPath = join(dir, "events.jsonl");
  writeFileSync(configPath, JSON.stringify(config), "utf8");

  const gateway = spawn(
    process.execPath,
    [
      ...NODE_ARGS,
      join(CONVERSATION, "gateway-main.ts"),
      "--pipe",
      pipe,
      "--config",
      configPath,
      "--events",
      eventsPath,
    ],
    // Environnement minimal : aucune variable du guest ni de l'hôte n'est héritée.
    { stdio: ["pipe", "pipe", "pipe"], env: minimalEnv() },
  );
  let stderr = "";
  gateway.stderr.setEncoding("utf8");
  gateway.stderr.on("data", (chunk: string) => (stderr += chunk));
  await new Promise<void>((resolve, reject) => {
    let out = "";
    gateway.stdout.setEncoding("utf8");
    gateway.stdout.on("data", (chunk: string) => {
      out += chunk;
      if (out.includes('"ready":true')) resolve();
    });
    gateway.once("exit", (code) => {
      reject(new Error(`passerelle arrêtée (${String(code)}) : ${stderr}`));
    });
  });

  const children = new Set<ChildProcess>([gateway]);
  return {
    dir,
    pipe,
    guideKey,
    otherGuideKey,
    operatorKey,
    invitations,
    gatewayStderr: () => stderr,
    events: () =>
      existsSync(eventsPath)
        ? readFileSync(eventsPath, "utf8")
            .split("\n")
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as ConversationEvent)
        : [],
    guestHome: (name) => prepareGuestHome(join(dir, `guest-${name}`)),
    track: (child) => {
      children.add(child);
    },
    stop: async () => {
      for (const child of children) {
        if (child.exitCode === null) child.kill();
      }
      await new Promise((r) => setTimeout(r, 50));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function minimalEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "SystemRoot", "TEMP", "TMP", "HOME"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

function prepareGuestHome(home: string): string {
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "system-prompt.txt"),
      `You are a curious explorer. ${GUEST_SYSTEM_PROMPT_MARKER}`,
      "utf8",
    );
    writeFileSync(
      join(home, "credentials.json"),
      JSON.stringify({ privateToken: GUEST_PRIVATE_TOKEN }),
      "utf8",
    );
    writeFileSync(
      join(home, "memory.jsonl"),
      `${JSON.stringify({ type: "tool", name: GUEST_MEMORY_MARKER, ok: true })}\n`,
      "utf8",
    );
  }
  return home;
}

export interface GuestProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  readonly stderr: () => string;
}

export function spawnGuest(
  harness: Harness,
  invitation: Invitation,
  home: string,
  options: { script?: "cooperative" | "hostile"; duplicate?: boolean; closeAfter?: number } = {},
): GuestProcess {
  const child = spawn(process.execPath, [...NODE_ARGS, join(CONVERSATION, "guest/fake-guest.ts")], {
    stdio: ["ignore", "ignore", "pipe"],
    // Le guest seul reçoit ses variables ; son prompt, sa mémoire et son credential sont
    // dans son dossier privé, jamais dans l'environnement des autres processus.
    env: minimalEnv({
      MIND_ADVICE_PIPE: harness.pipe,
      MIND_ADVICE_INVITATION: invitation.invitation,
      MIND_ADVICE_LINK_KEY: invitation.guestKey,
      GUEST_HOME: home,
      GUEST_SCRIPT: options.script ?? "cooperative",
      GUEST_DUPLICATE_SENDS: options.duplicate === true ? "1" : "0",
      GUEST_CLOSE_AFTER: String(options.closeAfter ?? 0),
    }),
  });
  harness.track(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      resolve(code);
    });
  });
  return { child, exited, stderr: () => stderr };
}

export interface GuideSession {
  readonly client: Client;
  readonly samplingRequests: () => number;
  call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ data: Record<string, unknown>; isError: boolean; raw: string }>;
  close(): Promise<void>;
}

/** Client MCP côté guide : lance l'adaptateur stdio dans son propre processus. */
export async function connectGuide(
  harness: Harness,
  linkKey = harness.guideKey,
): Promise<GuideSession> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...NODE_ARGS, join(CONVERSATION, "mcp-server.ts")],
    env: {
      MIND_ADVICE_PIPE: harness.pipe,
      MIND_ADVICE_LINK_KEY: linkKey,
      OPENAI_API_KEY: HOST_SECRET,
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "guide-mediator-test", version: "0.0.0" },
    { capabilities: { sampling: {} } },
  );
  let sampling = 0;
  // Le client accepterait une délégation de génération : on vérifie qu'aucune n'est demandée.
  client.setRequestHandler("sampling/createMessage", () => {
    sampling += 1;
    return Promise.resolve({
      model: "none",
      role: "assistant",
      content: { type: "text", text: "refused" },
    });
  });
  await client.connect(transport);
  return {
    client,
    samplingRequests: () => sampling,
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const first = (result.content as { type: string; text?: string }[])[0];
      const raw = first?.text ?? "";
      return {
        data: JSON.parse(raw) as Record<string, unknown>,
        isError: result.isError === true,
        raw,
      };
    },
    close: () => client.close(),
  };
}

/** Connexion brute au protocole filaire (attaquant, opérateur ou guest défaillant). */
export async function rawLink(
  harness: Harness,
  role: "guide" | "guest" | "operator",
  linkKey: string,
  invitation?: string,
): Promise<{ link: GatewayLink; hello: unknown }> {
  const link = await GatewayLink.connect(harness.pipe);
  const hello = await link.call({
    op: "hello",
    version: PROTOCOL_VERSION,
    role,
    key: linkKey,
    ...(invitation === undefined ? {} : { invitation }),
  });
  return { link, hello };
}

export async function until<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("délai dépassé");
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function readAll(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
