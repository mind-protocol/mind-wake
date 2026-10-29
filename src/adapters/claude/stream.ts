/**
 * Lecture du flux `claude -p --output-format stream-json --verbose` : une ligne JSON par
 * message `SDKMessage` (référence TypeScript de l'Agent SDK, vérifiée le 29 octobre 2026).
 * Fonctions pures : le flux vient d'un processus confiné, rien de ce qu'il contient n'est
 * une autorité (AGENTS §3.8). Aucun texte produit par le modèle n'est conservé : seules des
 * formes (noms d'outils, tailles, codes) remontent au journal.
 */

/** Valeurs documentées de `SDKAssistantMessageError` et de `system/api_retry.error`. */
export const CLAUDE_API_ERRORS = [
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "billing_error",
  "rate_limit",
  "overloaded",
  "invalid_request",
  "model_not_found",
  "server_error",
  "max_output_tokens",
  "cloud_credential_error",
  "unknown",
] as const;

export type ClaudeApiError = (typeof CLAUDE_API_ERRORS)[number];

/** Totaux de tokens d'un résultat, par catégorie Wake. */
export interface ClaudeTokenTotals {
  /** `input_tokens` + `cache_creation_input_tokens`. */
  readonly input: number;
  /** `cache_read_input_tokens`. */
  readonly cachedInput: number;
  /** `output_tokens` (réflexion incluse, selon la documentation de `ModelUsage`). */
  readonly output: number;
}

/** Ligne de `usage_report.rate_limits.limits` (`SDKUsageReport`, type expérimental). */
export interface ClaudeUsageLimitRow {
  readonly kind: string;
  readonly percent: number;
  readonly resetsAt: string | null;
  readonly scope: string | null;
}

export type ClaudeStreamItem =
  | {
      readonly kind: "init";
      readonly sessionId: string;
      readonly model: string;
      readonly version: string;
      readonly permissionMode: string;
      readonly tools: readonly string[];
    }
  | { readonly kind: "activity"; readonly summary: string }
  | { readonly kind: "assistant_error"; readonly error: ClaudeApiError }
  | {
      readonly kind: "api_retry";
      readonly attempt: number;
      readonly delayMs: number;
      readonly error: ClaudeApiError;
      readonly status: number | null;
    }
  | {
      readonly kind: "rate_limit";
      readonly status: "allowed" | "allowed_warning" | "rejected";
      /** Instant de remise à zéro en millisecondes epoch, s'il est communiqué. */
      readonly resetsAtMs: number | null;
      readonly utilization: number | null;
      readonly creditsRequired: boolean;
    }
  | { readonly kind: "usage_report"; readonly limits: readonly ClaudeUsageLimitRow[] | null }
  | { readonly kind: "permission_denied"; readonly tool: string }
  | {
      readonly kind: "result";
      readonly subtype: string;
      readonly isError: boolean;
      readonly sessionId: string;
      readonly numTurns: number;
      readonly apiErrorStatus: number | null;
      readonly terminalReason: string | null;
      /** Totaux toutes requêtes confondues (`modelUsage`), sinon boucle principale (`usage`). */
      readonly tokens: ClaudeTokenTotals | null;
      /** Nombre de messages d'erreur, sans leur texte. */
      readonly errorCount: number;
      /** Texte d'erreur du CLI, utile seulement au diagnostic local (jamais journalisé tel quel). */
      readonly errors: readonly string[];
    }
  | { readonly kind: "ignored"; readonly type: string }
  | { readonly kind: "malformed" };

type Json = Readonly<Record<string, unknown>>;

function object(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function apiError(value: unknown): ClaudeApiError {
  return CLAUDE_API_ERRORS.find((code) => code === value) ?? "unknown";
}

/** Somme de `modelUsage` (chaque modèle, sous-agents compris) ; repli sur `usage`. */
function tokenTotals(message: Json): ClaudeTokenTotals | null {
  const models = object(message["modelUsage"]);
  if (models !== null && Object.keys(models).length > 0) {
    let input = 0;
    let cachedInput = 0;
    let output = 0;
    for (const entry of Object.values(models)) {
      const usage = object(entry);
      if (usage === null) continue;
      input += count(usage["inputTokens"]) + count(usage["cacheCreationInputTokens"]);
      cachedInput += count(usage["cacheReadInputTokens"]);
      output += count(usage["outputTokens"]);
    }
    return { input, cachedInput, output };
  }
  const usage = object(message["usage"]);
  if (usage === null) return null;
  return {
    input: count(usage["input_tokens"]) + count(usage["cache_creation_input_tokens"]),
    cachedInput: count(usage["cache_read_input_tokens"]),
    output: count(usage["output_tokens"]),
  };
}

/** Résumé d'un message assistant : outils appelés et volume de texte, jamais le contenu. */
function assistantSummary(message: Json): string | null {
  const content = object(message["message"])?.["content"];
  if (!Array.isArray(content)) return null;
  const tools: string[] = [];
  let characters = 0;
  for (const block of content) {
    const entry = object(block);
    if (entry === null) continue;
    if (entry["type"] === "tool_use") tools.push(text(entry["name"]) ?? "?");
    if (entry["type"] === "text") characters += text(entry["text"])?.length ?? 0;
  }
  const parts: string[] = [];
  if (tools.length > 0) parts.push(`outils : ${tools.join(", ")}`);
  if (characters > 0) parts.push(`texte : ${String(characters)} caractères`);
  if (parts.length === 0) return null;
  const subagent = message["parent_tool_use_id"] === null ? "" : " (sous-agent)";
  return `assistant${subagent} — ${parts.join(" ; ")}`;
}

function usageReport(message: Json): ClaudeStreamItem | null {
  const report = object(message["usage_report"]);
  if (report === null) return null;
  const limits = object(report["rate_limits"])?.["limits"];
  if (!Array.isArray(limits)) return { kind: "usage_report", limits: null };
  const rows: ClaudeUsageLimitRow[] = [];
  for (const raw of limits) {
    const row = object(raw);
    const kind = text(row?.["kind"]);
    const percent = finite(row?.["percent"]);
    if (row === null || kind === null || percent === null) continue;
    const scope = object(row["scope"]);
    const scopeName =
      text(object(scope?.["model"])?.["display_name"]) ??
      text(object(scope?.["surface"])?.["display_name"]);
    rows.push({ kind, percent, resetsAt: text(row["resets_at"]), scope: scopeName });
  }
  return { kind: "usage_report", limits: rows };
}

/** `resetsAt` : secondes epoch (unité de la status line) ; une valeur en ms est acceptée. */
function epochMs(value: unknown): number | null {
  const n = finite(value);
  if (n === null || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** Interprète une ligne du flux. Une ligne illisible donne `malformed`, jamais une exception. */
export function parseStreamLine(line: string): ClaudeStreamItem {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "malformed" };
  }
  const message = object(value);
  if (message === null) return { kind: "malformed" };
  const type = text(message["type"]) ?? "";
  const subtype = text(message["subtype"]) ?? "";

  if (type === "system" && subtype === "init") {
    const tools = Array.isArray(message["tools"])
      ? message["tools"].filter((t): t is string => typeof t === "string")
      : [];
    return {
      kind: "init",
      sessionId: text(message["session_id"]) ?? "",
      model: text(message["model"]) ?? "",
      version: text(message["claude_code_version"]) ?? "",
      permissionMode: text(message["permissionMode"]) ?? "",
      tools,
    };
  }
  if (type === "system" && subtype === "api_retry") {
    return {
      kind: "api_retry",
      attempt: count(message["attempt"]),
      delayMs: count(message["retry_delay_ms"]),
      error: apiError(message["error"]),
      status: finite(message["error_status"]),
    };
  }
  if (type === "system" && subtype === "permission_denied") {
    return { kind: "permission_denied", tool: text(message["tool_name"]) ?? "?" };
  }
  if (type === "rate_limit_event") {
    const info = object(message["rate_limit_info"]);
    const status = text(info?.["status"]);
    return {
      kind: "rate_limit",
      status: status === "allowed" || status === "allowed_warning" ? status : "rejected",
      resetsAtMs: epochMs(info?.["resetsAt"]),
      utilization: finite(info?.["utilization"]),
      creditsRequired: info?.["errorCode"] === "credits_required",
    };
  }
  if (type === "assistant") {
    if (message["error"] !== undefined) {
      return { kind: "assistant_error", error: apiError(message["error"]) };
    }
    const report = usageReport(message);
    if (report !== null) return report;
    const summary = assistantSummary(message);
    return summary === null ? { kind: "ignored", type } : { kind: "activity", summary };
  }
  if (type === "result") {
    const errors = Array.isArray(message["errors"])
      ? message["errors"].filter((e): e is string => typeof e === "string")
      : [];
    return {
      kind: "result",
      subtype,
      isError: message["is_error"] === true || subtype.startsWith("error"),
      sessionId: text(message["session_id"]) ?? "",
      numTurns: count(message["num_turns"]),
      apiErrorStatus: finite(message["api_error_status"]),
      terminalReason: text(message["terminal_reason"]),
      tokens: tokenTotals(message),
      errorCount: errors.length,
      errors,
    };
  }
  return { kind: "ignored", type };
}

/** Classement d'une erreur API documentée vers le code d'erreur du contrat d'adapter. */
export function errorCodeFor(
  error: ClaudeApiError,
): "auth_failed" | "incompatible" | "transient" | "fatal" {
  switch (error) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
    case "cloud_credential_error":
      return "auth_failed";
    case "invalid_request":
    case "model_not_found":
      return "incompatible";
    case "overloaded":
    case "server_error":
    case "max_output_tokens":
      return "transient";
    case "rate_limit":
      return "transient";
    // Compte suspendu ou facturation : restriction sur le compte, la voie doit se fermer
    // (AGENTS §5, « Fermeture immédiate »), sans repli ni achat.
    case "account_on_hold":
    case "billing_error":
    case "unknown":
      return "fatal";
  }
}
