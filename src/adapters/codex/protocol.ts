/**
 * Sous-ensemble du protocole `codex app-server` employé par l'adapter, vérifié sur les
 * schémas JSON officiels de la version de référence (`codex-rs/app-server-protocol/schema/json`,
 * tag `rust-v0.165.0`) et la page « App server » de la documentation Codex, le
 * 29 octobre 2026. Transport : JSON-RPC 2.0 sans champ `jsonrpc`, une ligne JSON par
 * message sur stdio.
 *
 * Tout ce qui arrive du processus est une donnée non fiable : chaque champ est vérifié
 * avant usage, un champ inattendu est ignoré.
 */

import type { ProviderQuotaSnapshot, TokenCategory, UtcTimestamp } from "../../contracts/index.js";

/** Version de référence des essais enregistrés ; aucune égalité de version exigée. */
export const CODEX_SUPPORTED_VERSION = "0.165.0";

export type JsonRecord = Readonly<Record<string, unknown>>;

export function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function parseLine(line: string): JsonRecord | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Version annoncée par `codex --version` (`codex-cli 0.165.0`). */
export function parseCodexVersion(output: string): string | null {
  const match = /^codex(?:-cli)?\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/i.exec(output);
  return match?.[1] ?? null;
}

/** `TokenUsageBreakdown` (camelCase), cumul d'un fil ou d'une réponse. */
export interface TokenBreakdown {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

export function parseTokenBreakdown(value: unknown): TokenBreakdown | null {
  const r = asRecord(value);
  if (r === null) return null;
  const inputTokens = nonNegativeInt(r["inputTokens"]);
  const cachedInputTokens = nonNegativeInt(r["cachedInputTokens"]);
  const outputTokens = nonNegativeInt(r["outputTokens"]);
  const reasoningOutputTokens = nonNegativeInt(r["reasoningOutputTokens"]);
  const totalTokens = nonNegativeInt(r["totalTokens"]);
  if (
    inputTokens === null ||
    cachedInputTokens === null ||
    outputTokens === null ||
    reasoningOutputTokens === null ||
    totalTokens === null
  ) {
    return null;
  }
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

export const ZERO_BREAKDOWN: TokenBreakdown = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

/** Différence entre deux cumuls ; `null` si un compteur recule (cumul incohérent). */
export function subtractBreakdown(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown | null {
  const d = {
    inputTokens: a.inputTokens - b.inputTokens,
    cachedInputTokens: a.cachedInputTokens - b.cachedInputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens - b.reasoningOutputTokens,
    totalTokens: a.totalTokens - b.totalTokens,
  };
  return Object.values(d).every((v) => v >= 0) ? d : null;
}

/**
 * Catégories Wake. Convention de l'API Responses : `input` inclut le cache et `output`
 * inclut le raisonnement ; on les sépare pour ne rien compter deux fois.
 */
export function tokenCategories(b: TokenBreakdown): Partial<Record<TokenCategory, number>> {
  return {
    input: Math.max(0, b.inputTokens - b.cachedInputTokens),
    cached_input: b.cachedInputTokens,
    output: Math.max(0, b.outputTokens - b.reasoningOutputTokens),
    reasoning: b.reasoningOutputTokens,
  };
}

/** Une fenêtre lue sans durée ou sans date de remise à zéro : inutilisable par la garde. */
export interface IncompleteQuotaWindow {
  readonly windowKey: string;
  readonly reason: string;
}

export interface QuotaReading {
  readonly snapshots: readonly ProviderQuotaSnapshot[];
  readonly incomplete: readonly IncompleteQuotaWindow[];
  /** `rateLimitReachedType` non nul : le fournisseur signale une limite atteinte. */
  readonly limitReached: boolean;
}

/**
 * Convertit un `RateLimitSnapshot` (`primary`, `secondary` : `usedPercent` entier,
 * `windowDurationMins`, `resetsAt` en secondes Unix) en lectures de fenêtre. Seule une
 * fenêtre complète devient une lecture `measured` ; aucune valeur n'est devinée.
 */
export function quotaFromRateLimits(
  snapshot: unknown,
  observedAt: UtcTimestamp,
  fallbackLimitId = "codex",
): QuotaReading {
  const r = asRecord(snapshot);
  if (r === null) return { snapshots: [], incomplete: [], limitReached: false };
  const limitId = typeof r["limitId"] === "string" ? r["limitId"] : fallbackLimitId;
  const snapshots: ProviderQuotaSnapshot[] = [];
  const incomplete: IncompleteQuotaWindow[] = [];
  for (const slot of ["primary", "secondary"] as const) {
    const w = asRecord(r[slot]);
    if (w === null) continue;
    const windowKey = `${limitId}:${slot}`;
    const used = nonNegativeInt(w["usedPercent"]);
    const mins = nonNegativeInt(w["windowDurationMins"]);
    const resets = nonNegativeInt(w["resetsAt"]);
    if (used === null || mins === null || resets === null) {
      incomplete.push({ windowKey, reason: "usedPercent, windowDurationMins ou resetsAt absent" });
      continue;
    }
    snapshots.push({
      windowKey,
      windowDurationMs: mins * 60_000,
      usedBasisPoints: Math.min(10_000, used * 100),
      resetsAt: new Date(resets * 1000).toISOString() as UtcTimestamp,
      observedAt,
      provenance: "measured",
    });
  }
  const reached = r["rateLimitReachedType"];
  return { snapshots, incomplete, limitReached: reached !== null && reached !== undefined };
}

/** Réponse `account/rateLimits/read` : vue multi-fenêtres si présente, sinon vue simple. */
export function quotaFromRateLimitsResponse(
  result: unknown,
  observedAt: UtcTimestamp,
): QuotaReading {
  const r = asRecord(result);
  if (r === null) return { snapshots: [], incomplete: [], limitReached: false };
  const byId = asRecord(r["rateLimitsByLimitId"]);
  if (byId !== null && Object.keys(byId).length > 0) {
    const parts = Object.entries(byId).map(([id, s]) => quotaFromRateLimits(s, observedAt, id));
    return {
      snapshots: parts.flatMap((p) => p.snapshots),
      incomplete: parts.flatMap((p) => p.incomplete),
      limitReached: parts.some((p) => p.limitReached),
    };
  }
  return quotaFromRateLimits(r["rateLimits"], observedAt);
}

/** Classement d'un `CodexErrorInfo` (chaîne camelCase ou objet à clé unique). */
export type CodexErrorClass =
  | { readonly kind: "auth_failed" }
  | { readonly kind: "rate_limited" }
  | { readonly kind: "transient" }
  | { readonly kind: "incompatible" }
  | { readonly kind: "fatal" };

const RATE_LIMITED = new Set(["usageLimitExceeded", "rateLimitExceeded"]);
const TRANSIENT = new Set([
  "serverOverloaded",
  "internalServerError",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
  "flexUnavailable",
]);
const INCOMPATIBLE = new Set(["modelNotFound", "badRequest", "contextWindowExceeded"]);

export function codexErrorKey(info: unknown): string | null {
  if (typeof info === "string") return info;
  const r = asRecord(info);
  if (r === null) return null;
  const keys = Object.keys(r);
  return keys.length === 1 ? (keys[0] ?? null) : null;
}

export function httpStatusOf(info: unknown): number | null {
  const r = asRecord(info);
  if (r === null) return null;
  for (const value of Object.values(r)) {
    const status = nonNegativeInt(asRecord(value)?.["httpStatusCode"]);
    if (status !== null) return status;
  }
  return null;
}

/**
 * Code de l'API Responses repris dans le message quand `codexErrorInfo` vaut `other`
 * (observé avec 0.147.0 : `"code":"model_not_found"`, statut 400).
 */
function upstreamCode(message: string | undefined): string | null {
  if (message === undefined) return null;
  return /"code"\s*:\s*"([a-z_]+)"/.exec(message)?.[1] ?? null;
}

export function classifyCodexError(info: unknown, message?: string): CodexErrorClass {
  const key = upstreamCode(message) === "model_not_found" ? "modelNotFound" : codexErrorKey(info);
  const status = httpStatusOf(info);
  if (key === "unauthorized" || status === 401 || status === 403) return { kind: "auth_failed" };
  if ((key !== null && RATE_LIMITED.has(key)) || status === 429) return { kind: "rate_limited" };
  if (key !== null && TRANSIENT.has(key)) return { kind: "transient" };
  if (key !== null && INCOMPATIBLE.has(key)) return { kind: "incompatible" };
  return { kind: "fatal" };
}

/** `TurnError` : message borné, code éventuel. */
export function parseTurnError(value: unknown): { message: string; info: unknown } | null {
  const r = asRecord(value);
  if (r === null) return null;
  const message = typeof r["message"] === "string" ? r["message"] : "erreur Codex sans message";
  return { message: message.slice(0, 500), info: r["codexErrorInfo"] ?? null };
}
