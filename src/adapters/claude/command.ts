import {claudeCallMcpConfig,type HumanCallIdentity} from '../../communication/human-call-capability.js';
import type { WakeImage } from "../../contracts/wake-image.js";
import { claudeWakeContent } from "../wake-image.js";
import path from "node:path";
/**
 * Ligne de commande et environnement de `claude -p`, à partir des seules options documentées
 * dans la référence CLI officielle (code.claude.com/docs/en/cli-reference, vérifiée le
 * 29 octobre 2026 avec Claude Code 2.1.308). Fonctions pures.
 */

/** Modèle par défaut : alias officiel `opus`, configurable. */
export const DEFAULT_CLAUDE_MODEL = "opus";

/**
 * Outils intégrés accordés par défaut : fichiers et shell, sans accès web (`WebFetch`,
 * `WebSearch` absents), dans l'espace d'exploration. `--tools` restreint la liste des
 * outils disponibles ; les outils MCP sont écartés par `--strict-mcp-config` sans config.
 */
export const DEFAULT_CLAUDE_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"] as const;

/**
 * Réglages passés par `--settings` : pas de hooks (un hook écrit par l'agent dans son
 * espace ne doit rien exécuter hors de son tour), pas de co-signature imposée.
 */
export const CLAUDE_SESSION_SETTINGS = JSON.stringify({
  disableAllHooks: true,
  bashEditDiffEnabled: false,
});

export type ClaudePermissionStance =
  /** Sandbox AppContainer avec autotest réussi : mode sans approbation (ADR-005). */
  | "skip_permissions_in_sandbox"
  /** Poste hôte, consentement distinct au mode non isolé consigné (ADR-006). */
  | "skip_permissions_unsandboxed"
  /** Hors sandbox : `dontAsk`, seuls les outils listés passent, sans demande. */
  | "allowlist_only";

/** Trusted Bash hook shipped next to the owner inbox hook (same build directory). */
export function interruptibleBashScript(ownerInboxScript: string): string {
  return path.join(
    path.dirname(path.dirname(ownerInboxScript)),
    "communication",
    // Même extension que le hook : `.js` compilé, `.ts` hors compilation.
    `interruptible-bash${path.extname(ownerInboxScript) || ".js"}`,
  );
}

export interface ClaudeRunArgs {
  readonly humanCall?: HumanCallIdentity;
  readonly strictMcpConfig?: boolean;
  readonly model: string;
  readonly systemPromptFile: string;
  /** `replace` : `--system-prompt-file` ; `append` : `--append-system-prompt-file`. */
  readonly systemPromptMode?: "replace" | "append";
  readonly tools: readonly string[];
  readonly nativeCapabilities?: boolean;
  /** Trusted local desktop inbox hook; never supplied by the agent workspace. */
  readonly ownerInboxHook?: {
    readonly script: string;
    readonly dataDir: string;
    readonly node: string;
    /** Options Node avant le script (chargeur TypeScript quand le moteur tourne depuis src). */
    readonly nodeArgs?: readonly string[];
  };
  /**
   * Hook de confiance d'une room (room-inbox-hook.ts) : les messages arrivés pendant le tour
   * sont injectés après chaque outil et au Stop. Ignoré si `ownerInboxHook` est fourni.
   */
  readonly roomInboxHook?: {
    readonly node: string;
    readonly nodeArgs?: readonly string[];
    readonly script: string;
    /** Arguments après le script (`--deliver-room-inbox` …). */
    readonly args: readonly string[];
  };
  /** Configuration MCP explicitement fournie par le lanceur de confiance. */
  readonly mcpConfigFile?: string;
  /** Journal de débogage du CLI (`--debug-file`), activé par l'administrateur du poste. */
  readonly debugFile?: string;
  readonly permission: ClaudePermissionStance;
  /** `--session-id` pour une conversation neuve, `--resume` pour la suite. */
  readonly session: { readonly mode: "new" | "resume"; readonly id: string };
  readonly maxTurns?: number;
  /** Dossiers supplémentaires accessibles aux outils (`--add-dir`), hors du dossier de travail. */
  readonly addDirs?: readonly string[];
}

/** Réglages d'une session de room : seul le hook de sa boîte de réception (même forme que le principal). */
function roomInboxSettings(hook: NonNullable<ClaudeRunArgs["roomInboxHook"]>): string {
  return JSON.stringify({
    disableAllHooks: false,
    bashEditDiffEnabled: false,
    hooks: Object.fromEntries(
      ["PostToolUse", "PostToolUseFailure", "Stop"].map((event) => [
        event,
        [
          {
            hooks: [
              {
                type: "command",
                command: hook.node,
                args: [...(hook.nodeArgs ?? []), hook.script, ...hook.args],
              },
            ],
          },
        ],
      ]),
    ),
  });
}

/** Arguments d'une session : entrée et sortie `stream-json`, aucun réglage projet chargé. */
export function claudeRunArgs(options: ClaudeRunArgs): string[] {
  if(options.humanCall) { const config=claudeCallMcpConfig(options.mcpConfigFile,options.humanCall,options.nativeCapabilities===true); options={...options,...(config===undefined?{}:{mcpConfigFile:config})}; }
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    options.model,
    options.systemPromptMode === "append" ? "--append-system-prompt-file" : "--system-prompt-file",
    options.systemPromptFile,
    "--tools",
    options.nativeCapabilities === true ? "default" : options.tools.join(","),
    // Seuls les réglages du dossier de configuration dédié : aucun `.claude/settings*.json`
    // de l'espace d'exploration, écrit par l'agent, n'est chargé.
    ...(options.strictMcpConfig === true && options.nativeCapabilities === true ? ["--strict-mcp-config"] : []),
    ...(options.nativeCapabilities === true
      ? []
      : [
          "--setting-sources",
          options.ownerInboxHook === undefined ? "user" : "",
          "--strict-mcp-config",
        ]),
    ...(options.ownerInboxHook === undefined
      ? options.roomInboxHook !== undefined
        ? ["--settings", roomInboxSettings(options.roomInboxHook)]
        : options.nativeCapabilities === true
          ? []
          : ["--settings", CLAUDE_SESSION_SETTINGS]
      : [
          "--settings",
          JSON.stringify({
            disableAllHooks: false,
            // Diff git avant chaque Bash : plusieurs minutes dans un espace de 57 000 fichiers
            // (6 novembre 2026, session principale bloquée). Inutile à un agent autonome.
            bashEditDiffEnabled: false,
            hooks: Object.fromEntries([
              // Bash calls yield to a newly arrived human message (interruptible-bash.ts).
              [
                "PreToolUse",
                [
                  {
                    matcher: "Bash",
                    hooks: [
                      {
                        type: "command",
                        command: options.ownerInboxHook.node,
                        args: [
                          ...(options.ownerInboxHook.nodeArgs ?? []),
                          interruptibleBashScript(options.ownerInboxHook.script),
                          "--rewrite-bash",
                          options.ownerInboxHook.dataDir,
                          options.session.id,
                        ],
                      },
                    ],
                  },
                ],
              ],
              ...["SessionStart", "PostToolUse", "PostToolUseFailure", "Stop"].map((event) => [
                event,
                [
                  {
                    hooks: [
                      {
                        type: "command",
                        command: options.ownerInboxHook!.node,
                        args: [
                          ...(options.ownerInboxHook!.nodeArgs ?? []),
                          options.ownerInboxHook!.script,
                          "--deliver-owner-inbox",
                          options.ownerInboxHook!.dataDir,
                          options.session.id,
                        ],
                      },
                    ],
                  },
                ],
              ]),
            ]),
          }),
        ]),
    options.session.mode === "new" ? "--session-id" : "--resume",
    options.session.id,
  ];
  if (
    options.permission === "skip_permissions_in_sandbox" ||
    options.permission === "skip_permissions_unsandboxed"
  ) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", "dontAsk", "--permission-prompts", "none");
    if (options.tools.length > 0) args.push("--allowedTools", options.tools.join(","));
  }
  if (options.mcpConfigFile !== undefined) args.push("--mcp-config", options.mcpConfigFile);
  if (options.debugFile !== undefined) args.push("--debug-file", options.debugFile);
  if (options.maxTurns !== undefined) args.push("--max-turns", String(options.maxTurns));
  if (options.addDirs !== undefined && options.addDirs.length > 0) args.push("--add-dir", ...options.addDirs);
  if (options.ownerInboxHook !== undefined) args.push("--replay-user-messages");
  return args;
}

/**
 * Arguments de la lecture de jauge : `/usage` comme prompt, aucun outil, aucune session
 * conservée. `/usage` est une commande locale : elle n'envoie aucune requête au modèle.
 */
export function claudeUsageArgs(): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--tools",
    "",
    "--setting-sources",
    "user",
    "--settings",
    CLAUDE_SESSION_SETTINGS,
    "--strict-mcp-config",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
  ];
}

/**
 * Arguments de l'auto-compaction : `/compact` sur la conversation du réveil, dans un
 * processus à part, avant le réveil. `--strict-mcp-config` est indispensable (mesuré avec
 * 2.1.308 : sans lui, `/compact` échoue sans rien signaler), aucun outil, session conservée.
 */
export function claudeCompactArgs(sessionUuid: string, model: string): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    "--tools",
    "",
    "--setting-sources",
    "user",
    "--settings",
    CLAUDE_SESSION_SETTINGS,
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--resume",
    sessionUuid,
  ];
}

/** Message utilisateur au format `--input-format stream-json` (une ligne). */
export function userMessageLine(content: string, image?: WakeImage): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: claudeWakeContent(content, image) },
  });
}

/** Même règle que la sandbox (`spec.ts`) : aucun nom de secret dans l'environnement. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE)/i;

export class ClaudeEnvironmentError extends Error {
  constructor(readonly variable: string) {
    super(`variable refusée dans l'environnement de claude : ${variable}`);
    this.name = "ClaudeEnvironmentError";
  }
}

/**
 * Variables du profil Windows nécessaires au CLI lancé sur l'hôte (connexion par défaut,
 * Git Bash, réseau direct) ; le Job Object du runner ne transmet que les variables système.
 * Aucune n'a un nom de secret.
 */
export const HOST_PROFILE_ENV_KEYS = [
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "ComSpec",
] as const;

export function hostProfileEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of HOST_PROFILE_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export interface ClaudeEnvironmentOptions {
  /** Variables reprises de l'hôte (`hostProfileEnv`), posées en premier. */
  readonly inherited?: Readonly<Record<string, string>>;
  /**
   * Dossier de configuration dédié à Wake (`CLAUDE_CONFIG_DIR`). Absent : configuration
   * par défaut du CLI, celle de l'humain (lancement supervisé seulement).
   */
  readonly configDir?: string;
  /** Dossier personnel substitué (`HOME`, `USERPROFILE`) ; absent = non défini. */
  readonly homeDir?: string;
  /** Windows : chemin de `bash.exe` (`CLAUDE_CODE_GIT_BASH_PATH`). */
  readonly gitBashPath?: string;
  /** Variables de transport du relais fournisseur. */
  readonly network?: Readonly<Record<string, string>>;
  /**
   * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (défaut `true`) : pas de télémétrie ni de
   * mise à jour. Mesuré avec 2.1.308 : prive `/usage` de `rate_limits`.
   */
  readonly disableNonessentialTraffic?: boolean;
  /** Variables supplémentaires, posées en dernier ; aucun nom de secret. */
  readonly extra?: Readonly<Record<string, string>>;
}

/**
 * Environnement explicite ajouté aux variables système minimales par le lanceur. Rien
 * n'est hérité du daemon ; une variable au nom de secret est refusée, y compris venant
 * du relais (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`…).
 */
export function claudeEnvironment(options: ClaudeEnvironmentOptions): Record<string, string> {
  const env: Record<string, string> = { ...options.inherited };
  if (options.configDir !== undefined) env["CLAUDE_CONFIG_DIR"] = options.configDir;
  env["DISABLE_AUTOUPDATER"] = "1";
  if (options.disableNonessentialTraffic !== false) {
    env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1";
  }
  if (options.homeDir !== undefined) {
    env["HOME"] = options.homeDir;
    env["USERPROFILE"] = options.homeDir;
  }
  if (options.gitBashPath !== undefined) env["CLAUDE_CODE_GIT_BASH_PATH"] = options.gitBashPath;
  for (const [key, value] of Object.entries(options.network ?? {})) env[key] = value;
  for (const [key, value] of Object.entries(options.extra ?? {})) env[key] = value;
  for (const key of Object.keys(env)) {
    if (SECRET_NAME.test(key)) throw new ClaudeEnvironmentError(key);
  }
  return env;
}

