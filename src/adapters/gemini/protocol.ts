/**
 * Lecture du flux `--output-format stream-json` de Gemini CLI (JSONL, un événement par
 * ligne). Types relevés dans la documentation « Headless mode » et dans la source
 * officielle `packages/core/src/output/types.ts` (29 octobre 2026) : `init`, `message`,
 * `tool_use`, `tool_result`, `error`, `result`. Tout ce qui vient du flux est une donnée
 * non fiable (AGENTS §3.8) : rien ici n'élargit une permission.
 */

import type { TokenCategory } from "../../contracts/index.js";

/** Statistiques agrégées de l'événement `result` (`StreamStats`). */
export interface GeminiStreamStats {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  /** Entrée hors cache (`input`). */
  readonly freshInputTokens: number;
  readonly durationMs: number | null;
  readonly toolCalls: number | null;
}

export type GeminiStreamEvent =
  | { readonly kind: "init"; readonly sessionId: string; readonly model: string }
  | {
      readonly kind: "message";
      readonly role: "user" | "assistant";
      readonly content: string;
      readonly delta: boolean;
    }
  | { readonly kind: "tool_use"; readonly toolName: string; readonly toolId: string }
  | {
      readonly kind: "tool_result";
      readonly toolId: string;
      readonly status: "success" | "error";
      readonly errorMessage: string | null;
    }
  | { readonly kind: "error"; readonly severity: "warning" | "error"; readonly message: string }
  | {
      readonly kind: "result";
      readonly status: "success" | "error";
      readonly error: { readonly type: string; readonly message: string } | null;
      readonly stats: GeminiStreamStats | null;
    }
  /** Ligne JSON valide d'un type inconnu : ignorée, mais comptée. */
  | { readonly kind: "unknown"; readonly type: string }
  /** Ligne illisible : sortie coupée ou corrompue. */
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

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function errorDetail(value: unknown): { type: string; message: string } | null {
  const detail = object(value);
  if (detail === null) return null;
  return { type: text(detail["type"]) ?? "unknown", message: text(detail["message"]) ?? "" };
}

function stats(value: unknown): GeminiStreamStats | null {
  const raw = object(value);
  if (raw === null) return null;
  const totalTokens = count(raw["total_tokens"]);
  const inputTokens = count(raw["input_tokens"]);
  const outputTokens = count(raw["output_tokens"]);
  // Sans total, entrée et sortie, la mesure n'est pas exploitable.
  if (totalTokens === null || inputTokens === null || outputTokens === null) return null;
  const cachedTokens = count(raw["cached"]) ?? 0;
  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cachedTokens,
    freshInputTokens: count(raw["input"]) ?? Math.max(0, inputTokens - cachedTokens),
    durationMs: count(raw["duration_ms"]),
    toolCalls: count(raw["tool_calls"]),
  };
}

/** Interprète une ligne du flux. Ne lève jamais. */
export function parseStreamLine(line: string): GeminiStreamEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "malformed" };
  }
  const event = object(value);
  const type = event === null ? null : text(event["type"]);
  if (event === null || type === null) return { kind: "malformed" };
  switch (type) {
    case "init":
      return {
        kind: "init",
        sessionId: text(event["session_id"]) ?? "",
        model: text(event["model"]) ?? "",
      };
    case "message": {
      const role = event["role"] === "user" ? "user" : "assistant";
      return {
        kind: "message",
        role,
        content: text(event["content"]) ?? "",
        delta: event["delta"] === true,
      };
    }
    case "tool_use":
      return {
        kind: "tool_use",
        toolName: text(event["tool_name"]) ?? "?",
        toolId: text(event["tool_id"]) ?? "",
      };
    case "tool_result": {
      const failed = event["status"] === "error";
      return {
        kind: "tool_result",
        toolId: text(event["tool_id"]) ?? "",
        status: failed ? "error" : "success",
        errorMessage: failed ? (errorDetail(event["error"])?.message ?? null) : null,
      };
    }
    case "error":
      return {
        kind: "error",
        severity: event["severity"] === "warning" ? "warning" : "error",
        message: text(event["message"]) ?? "",
      };
    case "result":
      return {
        kind: "result",
        status: event["status"] === "success" ? "success" : "error",
        error: errorDetail(event["error"]),
        stats: stats(event["stats"]),
      };
    default:
      return { kind: "unknown", type };
  }
}

/**
 * Répartition des tokens pour le ledger. `total_tokens` inclut ce qui n'est ni entrée ni
 * sortie (raisonnement, appels d'outils côté modèle) : ce reste est rangé en `unexposed`.
 */
export function tokenBreakdown(
  stats: GeminiStreamStats,
): Readonly<Partial<Record<TokenCategory, number>>> {
  const rest = stats.totalTokens - stats.inputTokens - stats.outputTokens;
  return {
    input: stats.freshInputTokens,
    cached_input: stats.cachedTokens,
    output: stats.outputTokens,
    ...(rest > 0 ? { unexposed: rest } : {}),
  };
}

/**
 * Codes de sortie de la CLI. `0`, `1`, `42`, `53` sont documentés (« Headless mode ») ;
 * les autres viennent des classes `Fatal*Error` de la source officielle
 * (`packages/core/src/utils/errors.ts`).
 */
export const GEMINI_EXIT_CODES = {
  success: 0,
  general: 1,
  authentication: 41,
  input: 42,
  sandbox: 44,
  config: 52,
  turnLimit: 53,
  toolExecution: 54,
  untrustedWorkspace: 55,
  cancelled: 130,
} as const;

export type AdapterErrorCode = "auth_failed" | "incompatible" | "transient" | "fatal";

export type ErrorClass =
  | { readonly kind: "rate_limited"; readonly retryAfterMs: number | null }
  | { readonly kind: "error"; readonly code: AdapterErrorCode };

/**
 * Limitation fournisseur. La CLI classe les 429 en `TerminalQuotaError` (quota du jour)
 * ou `RetryableQuotaError` (par minute) et formule les messages « You have exhausted your
 * daily quota on this model. » et « Suggested retry after <n>s. » (source officielle
 * `googleQuotaErrors.ts`). Ces textes ne sont pas un contrat documenté : à revérifier à
 * chaque mise à jour de la CLI.
 */
const QUOTA_PATTERN =
  /QuotaError|quota|RESOURCE_EXHAUSTED|rate.?limit|\b429\b|capacity exceeded|exhausted your capacity/i;
const AUTH_PATTERN =
  /AuthenticationError|\b401\b|unauthenticated|not authenticated|login required|invalid.*credential/i;

/** Délai suggéré par le message, s'il en contient un (« retry after 30s », « retry in 2.5s »). */
export function retryDelayMs(message: string): number | null {
  const match = /retry (?:after|in) (\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(message);
  if (match === null) return null;
  const amount = Number(match[1]);
  return Math.round(match[2]?.toLowerCase() === "ms" ? amount : amount * 1000);
}

/** Classe une erreur signalée par la CLI (événement `error`, `result` en échec). */
export function classifyError(type: string, message: string): ErrorClass {
  const both = `${type} ${message}`;
  if (QUOTA_PATTERN.test(both))
    return { kind: "rate_limited", retryAfterMs: retryDelayMs(message) };
  if (AUTH_PATTERN.test(both)) return { kind: "error", code: "auth_failed" };
  return { kind: "error", code: "transient" };
}

/** Classe un code de sortie non nul, quand le flux ne l'a pas déjà expliqué. */
export function classifyExitCode(exitCode: number): {
  readonly code: AdapterErrorCode;
  readonly reason: string;
} {
  switch (exitCode) {
    case GEMINI_EXIT_CODES.authentication:
      return { code: "auth_failed", reason: "authentification refusée par la CLI" };
    case GEMINI_EXIT_CODES.input:
      return { code: "incompatible", reason: "arguments ou prompt refusés par la CLI" };
    case GEMINI_EXIT_CODES.config:
      return { code: "incompatible", reason: "configuration refusée par la CLI" };
    case GEMINI_EXIT_CODES.untrustedWorkspace:
      return { code: "incompatible", reason: "espace de travail non approuvé par la CLI" };
    case GEMINI_EXIT_CODES.sandbox:
      return { code: "fatal", reason: "erreur de la sandbox propre à la CLI" };
    case GEMINI_EXIT_CODES.toolExecution:
      return { code: "fatal", reason: "erreur fatale d'exécution d'outil" };
    default:
      return { code: "transient", reason: `sortie de la CLI en code ${String(exitCode)}` };
  }
}
