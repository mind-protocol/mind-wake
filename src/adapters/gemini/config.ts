/**
 * Arguments et configuration d'un lancement de Gemini CLI. Seules des options documentées
 * sont employées (« CLI reference », « Configuration », « Policy engine », vérifiées le
 * 29 octobre 2026, CLI 0.52.0 installée) :
 *
 * - `--prompt` (non interactif), `--output-format stream-json`, `--model`,
 *   `--approval-mode default|yolo` (`--yolo` est déprécié), `--resume <id>` ;
 * - `GEMINI_CLI_HOME` : racine de la configuration utilisateur et du stockage (sessions
 *   dans `.gemini/tmp/<hash>/chats/`). Wake y pointe un dossier qui lui est propre :
 *   la CLI ne lit ni `~/.gemini` ni les credentials de l'utilisateur ;
 * - `settings.json` : `privacy.usageStatisticsEnabled`, `telemetry.enabled`, `model.name`,
 *   `model.maxSessionTurns`, `tools.core`, `tools.exclude` ;
 * - politique utilisateur `.gemini/policies/*.toml` (`[[rule]]`, `toolName`, `decision`,
 *   `priority`) : une règle utilisateur l'emporte sur les règles par défaut, dont celle
 *   qui accorde tout en mode `yolo`.
 *
 * `--allowed-tools` est déprécié au profit du policy engine : il n'est pas employé.
 */

import fs from "node:fs";
import path from "node:path";

/** Outils réseau intégrés, exclus par défaut : la recherche passe par le fournisseur. */
export const DEFAULT_EXCLUDED_TOOLS: readonly string[] = ["google_web_search", "web_fetch"];

/** Longueur maximale du prompt passé en argument (ligne de commande Windows ≈ 32 767). */
export const MAX_PROMPT_CHARS = 24_000;

const TOOL_NAME = /^[A-Za-z0-9_.*-]{1,128}$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
/** Identifiant de session de la CLI (UUID). */
export const GEMINI_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ApprovalMode = "default" | "yolo";

export interface GeminiRunSettings {
  readonly model: string;
  /** Tours maximum par session (`model.maxSessionTurns`) ; pas une borne de tokens. */
  readonly maxSessionTurns: number;
  /** Liste blanche d'outils intégrés (`tools.core`) ; absente = outils par défaut. */
  readonly coreTools?: readonly string[];
  readonly excludedTools: readonly string[];
}

export function assertModel(model: string): void {
  if (!MODEL_NAME.test(model)) throw new Error(`nom de modèle Gemini refusé : ${model}`);
}

function assertTools(tools: readonly string[]): void {
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool)) throw new Error(`nom d'outil Gemini refusé : ${tool}`);
  }
}

/** Arguments de la CLI après le préfixe éventuel (`node <script>`). */
export function buildArgs(options: {
  readonly prompt: string;
  readonly model: string;
  readonly approvalMode: ApprovalMode;
  readonly resumeSessionId?: string;
}): string[] {
  assertModel(options.model);
  if (options.prompt.length === 0) throw new Error("prompt vide");
  if (options.prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(
      `contexte trop long pour la ligne de commande (${String(options.prompt.length)} > ${String(MAX_PROMPT_CHARS)} caractères)`,
    );
  }
  const args = [
    "--output-format",
    "stream-json",
    "--model",
    options.model,
    "--approval-mode",
    options.approvalMode,
  ];
  if (options.resumeSessionId !== undefined) {
    if (!GEMINI_SESSION_ID.test(options.resumeSessionId)) {
      throw new Error("identifiant de session Gemini invalide");
    }
    args.push("--resume", options.resumeSessionId);
  }
  // Forme `--prompt=<texte>` : un contexte commençant par « - » reste une valeur.
  args.push(`--prompt=${options.prompt}`);
  return args;
}

/** Contenu de `settings.json`, réécrit à chaque lancement. */
export function settingsDocument(settings: GeminiRunSettings): Record<string, unknown> {
  assertModel(settings.model);
  assertTools(settings.excludedTools);
  if (settings.coreTools !== undefined) assertTools(settings.coreTools);
  if (!Number.isSafeInteger(settings.maxSessionTurns) || settings.maxSessionTurns < 1) {
    throw new Error("maxSessionTurns doit être un entier positif");
  }
  return {
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false },
    model: { name: settings.model, maxSessionTurns: settings.maxSessionTurns },
    tools: {
      ...(settings.coreTools === undefined ? {} : { core: [...settings.coreTools] }),
      exclude: [...settings.excludedTools],
    },
  };
}

/** Politique utilisateur : refus explicite des outils exclus, même en mode `yolo`. */
export function policyDocument(excludedTools: readonly string[]): string {
  assertTools(excludedTools);
  const lines = ["# Écrit par MIND Wake à chaque lancement ; toute modification est écrasée."];
  for (const tool of excludedTools) {
    lines.push("", "[[rule]]", `toolName = "${tool}"`, 'decision = "deny"', "priority = 999");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Écrit `settings.json` et la politique dans `<home>/.gemini/`. Le dossier appartient à
 * Wake ; ce qu'un lancement précédent a pu y modifier est remplacé.
 */
export function writeHomeConfiguration(home: string, settings: GeminiRunSettings): void {
  const dir = path.join(home, ".gemini");
  const policies = path.join(dir, "policies");
  fs.mkdirSync(policies, { recursive: true });
  // Seule la politique de Wake est chargée : tout autre fichier `.toml` est retiré.
  for (const entry of fs.readdirSync(policies)) {
    if (entry.toLowerCase().endsWith(".toml") && entry !== "mindwake.toml") {
      fs.rmSync(path.join(policies, entry), { force: true });
    }
  }
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    `${JSON.stringify(settingsDocument(settings), null, 2)}\n`,
  );
  fs.writeFileSync(path.join(policies, "mindwake.toml"), policyDocument(settings.excludedTools));
}
