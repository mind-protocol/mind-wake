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
export const CLAUDE_SESSION_SETTINGS = JSON.stringify({ disableAllHooks: true });

export type ClaudePermissionStance =
  /** Sandbox AppContainer avec autotest réussi : mode sans approbation (ADR-005). */
  | "skip_permissions_in_sandbox"
  /** Hors sandbox : `dontAsk`, seuls les outils listés passent, sans demande. */
  | "allowlist_only";

export interface ClaudeRunArgs {
  readonly model: string;
  readonly systemPromptFile: string;
  readonly tools: readonly string[];
  readonly permission: ClaudePermissionStance;
  /** `--session-id` pour une conversation neuve, `--resume` pour la suite. */
  readonly session: { readonly mode: "new" | "resume"; readonly id: string };
  readonly maxTurns?: number;
}

/** Arguments d'une session : entrée et sortie `stream-json`, aucun réglage projet chargé. */
export function claudeRunArgs(options: ClaudeRunArgs): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    options.model,
    "--system-prompt-file",
    options.systemPromptFile,
    "--tools",
    options.tools.join(","),
    // Seuls les réglages du dossier de configuration dédié : aucun `.claude/settings*.json`
    // de l'espace d'exploration, écrit par l'agent, n'est chargé.
    "--setting-sources",
    "user",
    "--settings",
    CLAUDE_SESSION_SETTINGS,
    "--strict-mcp-config",
    options.session.mode === "new" ? "--session-id" : "--resume",
    options.session.id,
  ];
  if (options.permission === "skip_permissions_in_sandbox") {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push(
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--allowedTools",
      options.tools.join(","),
    );
  }
  if (options.maxTurns !== undefined) args.push("--max-turns", String(options.maxTurns));
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

/** Message utilisateur au format `--input-format stream-json` (une ligne). */
export function userMessageLine(content: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content } });
}

/** Même règle que la sandbox (`spec.ts`) : aucun nom de secret dans l'environnement. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE)/i;

export class ClaudeEnvironmentError extends Error {
  constructor(readonly variable: string) {
    super(`variable refusée dans l'environnement de claude : ${variable}`);
    this.name = "ClaudeEnvironmentError";
  }
}

export interface ClaudeEnvironmentOptions {
  /** Dossier de configuration dédié à Wake (`CLAUDE_CONFIG_DIR`). */
  readonly configDir: string;
  /** Dossier personnel substitué (`HOME`, `USERPROFILE`) ; absent = non défini. */
  readonly homeDir?: string;
  /** Windows : chemin de `bash.exe` (`CLAUDE_CODE_GIT_BASH_PATH`). */
  readonly gitBashPath?: string;
  /** Variables de transport du relais fournisseur. */
  readonly network?: Readonly<Record<string, string>>;
}

/**
 * Environnement explicite ajouté aux variables système minimales par le lanceur. Rien
 * n'est hérité du daemon ; une variable au nom de secret est refusée, y compris venant
 * du relais (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`…).
 */
export function claudeEnvironment(options: ClaudeEnvironmentOptions): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CONFIG_DIR: options.configDir,
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (options.homeDir !== undefined) {
    env["HOME"] = options.homeDir;
    env["USERPROFILE"] = options.homeDir;
  }
  if (options.gitBashPath !== undefined) env["CLAUDE_CODE_GIT_BASH_PATH"] = options.gitBashPath;
  for (const [key, value] of Object.entries(options.network ?? {})) env[key] = value;
  for (const key of Object.keys(env)) {
    if (SECRET_NAME.test(key)) throw new ClaudeEnvironmentError(key);
  }
  return env;
}
