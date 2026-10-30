import fs from "node:fs";
import { observeClaudeTools } from "../../communication/runtime-activity.js";
/**
 * Enregistrement de Claude Code dans le registre du daemon (`src/daemon/registry.ts`).
 *
 * Runtime déclaré : fournisseur `anthropic`, connexion par abonnement claude.ai faite par
 * l'humain dans le CLI officiel (`authMode: "claude_subscription"`), facturation
 * `subscription_quota` bornée par la jauge officielle `/usage` (ADR-004, ADR-005).
 * Lancement par le runner : sandbox, ou hôte NON ISOLÉ si la policy porte
 * `runtime.hostUnsandboxedAcknowledged` (ADR-006) ; sinon refus du mode autonome.
 */

import { WAKE_HOME_SYSTEM_PROMPT, withWakePersonality } from "../wake-system-prompt.js";
import os from "node:os";
import path from "node:path";
import { saveStepsResult } from "../../daemon/wake-steps.js";
import type { ProfileId, RuntimeGroup } from "../../contracts/index.js";
import type { AdapterRegistration } from "../../daemon/registry.js";
import type { BillingFacts } from "../../policy/index.js";
import { runtimeDirFor } from "../../runner/paths.js";
import { ProcessTreeSupervisor } from "../../runner/process-tree.js";
import { CLAUDE_ADAPTER_ID, ClaudeAdapter } from "./claude-adapter.js";
import { DEFAULT_CLAUDE_MODEL } from "./command.js";
import { FileConversationStore } from "./conversation.js";
import { hostClaudeLauncher, supervisorClaudeLauncher } from "./launch.js";
import { readAgentPilot } from "../../daemon/agent-pilot.js";

export const CLAUDE_PROVIDER = "anthropic";
export const CLAUDE_AUTH_MODE = "claude_subscription";

/** Fil par défaut stable, même en l’absence d’expérience. Le fichier permet de reprendre un fil antérieur lors d’une migration. */
export function wakeConversationKey(runtimeDir: string, experiment: string | null): string {
  if (experiment !== null) return experiment;
  const file = path.join(runtimeDir, "default-conversation.json");
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as { key?: unknown };
    if (typeof value.key !== "string" || value.key.length === 0 || value.key.length > 200)
      throw new Error("Invalid default Wake conversation key");
    return value.key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "wake-default";
    throw error;
  }
}

/**
 * Ajouté au prompt système de Claude Code (`--append-system-prompt-file`) : les outils et
 * consignes du CLI restent ; le message de réveil porte l'espace, les permissions et la
 * consigne de la session.
 */
export const CLAUDE_WAKE_SYSTEM_PROMPT = [
  WAKE_HOME_SYSTEM_PROMPT,
  "You are running inside MIND Wake as your human's agent, during time they are not using.",
  "The system context describes your workspace and permissions. Wake messages contain only a resumption cue, current time/budget and new events.",
  "Work inside your space, keep notes and checkpoints there, and stop when there is no",
  "justified next action.",
].join(" ");

/** Profil synthétique des Job Objects de lecture de jauge, hors de toute session. */
const QUOTA_PROFILE = "claude-quota" as ProfileId;

export interface ClaudeRegistrationConfig {
  /** Binaire officiel `claude`. */
  readonly executable: string;
  /** Arguments placés avant ceux de l'adapter (bancs de test seulement). */
  readonly executablePrefixArgs?: readonly string[];
  /** Modèle fixé par la configuration Wake, comparé à `policy.runtime.model`. */
  readonly model: string;
  /** Dossier de configuration dédié (`CLAUDE_CONFIG_DIR`) ; absent : connexion par défaut. */
  readonly configDir?: string;
  readonly systemPrompt?: string;
  /** Configuration MCP administrée hors de l’espace de l’agent (mode hôte). */
  readonly mcpConfigFile?: string;
  /** Variables supplémentaires sans nom de secret (bancs de test). */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Dossier des superviseurs de jauge ; défaut : `runtime/` du dossier de données. */
  readonly runtimeDir?: string;
  /** Auto-compaction au-delà de ce nombre de tokens au réveil précédent ; 0 : jamais. */
  readonly compactAboveTokens?: number;
}

/**
 * Seuil d'auto-compaction par défaut : un réveil qui a mesuré plus de 2 M de tokens (lectures
 * de cache comprises) fait commencer le suivant par `/compact`. Mesuré le 29/10 : un réveil
 * sur une conversation fraîche coûte ~0,1 M, sur une conversation de plusieurs heures ~12 M.
 */
export const DEFAULT_COMPACT_ABOVE_TOKENS = 2_000_000;

/**
 * Configuration de ce poste : `MIND_WAKE_CLAUDE_EXE` (défaut : installation native
 * `~/.local/bin/claude.exe`), `MIND_WAKE_CLAUDE_MODEL` (défaut `opus`),
 * `MIND_WAKE_CLAUDE_CONFIG_DIR` (facultatif), `MIND_WAKE_CLAUDE_COMPACT_TOKENS` (seuil
 * d'auto-compaction, défaut 2 000 000 ; 0 la désactive).
 */
export function defaultClaudeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ClaudeRegistrationConfig {
  const configDir = env["MIND_WAKE_CLAUDE_CONFIG_DIR"];
  const mcpConfigFile = env["MIND_WAKE_CLAUDE_MCP_CONFIG"];
  const compact = Number(env["MIND_WAKE_CLAUDE_COMPACT_TOKENS"] ?? DEFAULT_COMPACT_ABOVE_TOKENS);
  return {
    compactAboveTokens:
      Number.isSafeInteger(compact) && compact >= 0 ? compact : DEFAULT_COMPACT_ABOVE_TOKENS,
    executable:
      env["MIND_WAKE_CLAUDE_EXE"] ?? path.join(os.homedir(), ".local", "bin", "claude.exe"),
    model: env["MIND_WAKE_CLAUDE_MODEL"] ?? DEFAULT_CLAUDE_MODEL,
    ...(configDir === undefined ? {} : { configDir }),
    ...(mcpConfigFile === undefined ? {} : { mcpConfigFile }),
  };
}

export function claudeRegistration(config: ClaudeRegistrationConfig): AdapterRegistration {
  return {
    id: CLAUDE_ADAPTER_ID,
    simulated: false,
    runtime: (): RuntimeGroup => ({
      adapterId: CLAUDE_ADAPTER_ID,
      provider: CLAUDE_PROVIDER,
      model: config.model,
      authMode: CLAUDE_AUTH_MODE,
    }),
    billing: (): BillingFacts => ({ kind: "subscription_quota" }),
    runtimeRoots: () => [path.dirname(config.executable)],
    create: (context) => {
      const dir = path.join(context.dataDir, "runtimes", "claude");
      let supervisor: ProcessTreeSupervisor | null = null;
      return new ClaudeAdapter({
        stepsStopHook: true,
        onStepsResult: (request, raw) => saveStepsResult(context.workspaceDir, context.dataDir, request.policy.groups.identity.agentId, request.sessionId, raw),
        // Le runner confine selon la session ; le consentement au mode non isolé vient de la
        // policy (session `host_unsandboxed`), relu à chaque lancement.
        launcher: hostClaudeLauncher(context.host),
        quotaLauncher: supervisorClaudeLauncher(
          () =>
            (supervisor ??= new ProcessTreeSupervisor(
              config.runtimeDir ?? runtimeDirFor(context.dataDir),
            )),
          QUOTA_PROFILE,
        ),
        autonomy: "autonomous",
        executable: config.executable,
        ...(config.executablePrefixArgs === undefined
          ? {}
          : { executablePrefixArgs: config.executablePrefixArgs }),
        ...(config.configDir === undefined ? {} : { configDir: config.configDir }),
        ...(config.extraEnv === undefined ? {} : { extraEnv: config.extraEnv }),
        ...(config.compactAboveTokens === undefined
          ? {}
          : { compactAboveTokens: config.compactAboveTokens }),
        // L'agent règle lui-même sa compaction (ADR-009), lu comme donnée à chaque réveil.
        agentPilot: () => readAgentPilot(path.join(context.workspaceDir, "artifacts")),
        promptDir: path.join(dir, "prompts"),
        ownerInboxDir: context.dataDir,
        systemPrompt: () =>
          withWakePersonality(
            context.workspaceDir,
            config.systemPrompt ?? CLAUDE_WAKE_SYSTEM_PROMPT,
          ),
        systemPromptMode: "append",
        onStreamLine: (sessionId,line) => observeClaudeTools(context.dataDir,sessionId,line),
        onTools: (sessionId, tools) => {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(
            path.join(dir, "capabilities.json"),
            JSON.stringify({ sessionId, observedAt: new Date().toISOString(), tools }, null, 2),
          );
        },
        ...(config.mcpConfigFile === undefined ? {} : { mcpConfigFile: config.mcpConfigFile }),
        workspaceFor: () => context.workspaceDir,
        conversationKeyFor: (sessionId) =>
          wakeConversationKey(dir, context.experimentFor(sessionId)),
        conversations: new FileConversationStore(path.join(dir, "conversations.json")),
        model: config.model,
      });
    },
  };
}
