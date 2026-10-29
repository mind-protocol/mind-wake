/**
 * Mise en forme d'un événement avant écriture : expurgation puis bornage de taille.
 * L'expurgation précède toujours la troncature, pour qu'une découpe ne laisse jamais un
 * secret partiellement reconnaissable.
 */

import type { JsonObject, JsonValue } from "../contracts/index.js";
import { isSensitiveKey, REDACTED, redactString } from "./redact.js";

export interface MetadataLimits {
  readonly maxDepth: number;
  readonly maxKeys: number;
  readonly maxArrayItems: number;
  readonly maxStringLength: number;
  readonly maxKeyLength: number;
  /** Taille maximale du JSON sérialisé, en octets UTF-8. */
  readonly maxTotalBytes: number;
}

export const DEFAULT_METADATA_LIMITS: MetadataLimits = {
  maxDepth: 5,
  maxKeys: 32,
  maxArrayItems: 32,
  maxStringLength: 512,
  maxKeyLength: 64,
  maxTotalBytes: 4096,
};

export const MAX_REASON_LENGTH = 500;

const TRUNCATION_MARK = "…[tronqué]";

/** Clé ajoutée à un objet dont des entrées ont été retirées. */
export const TRUNCATED_KEY = "_tronque";

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - TRUNCATION_MARK.length)) + TRUNCATION_MARK;
}

function sanitizeString(value: string, limits: MetadataLimits): string {
  return truncate(redactString(value), limits.maxStringLength);
}

function sanitizeNode(value: unknown, depth: number, limits: MetadataLimits): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      return sanitizeString(value, limits);
    case "number":
      return Number.isFinite(value) ? value : null;
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return null;
    default:
      break;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (value instanceof Error) {
    return sanitizeString(`${value.name}: ${value.message}`, limits);
  }
  if (depth >= limits.maxDepth) return "[profondeur maximale atteinte]";
  if (Array.isArray(value)) {
    const items = value
      .slice(0, limits.maxArrayItems)
      .map((item: unknown) => sanitizeNode(item, depth + 1, limits));
    if (value.length > limits.maxArrayItems) {
      items.push(`[${String(value.length - limits.maxArrayItems)} éléments omis]`);
    }
    return items;
  }
  return sanitizeObject(value as Record<string, unknown>, depth, limits);
}

function sanitizeObject(
  value: Record<string, unknown>,
  depth: number,
  limits: MetadataLimits,
): JsonObject {
  const out: Record<string, JsonValue> = {};
  const entries = Object.entries(value);
  for (const [key, item] of entries.slice(0, limits.maxKeys)) {
    const safeKey = truncate(redactString(key), limits.maxKeyLength);
    out[safeKey] = isSensitiveKey(key) ? REDACTED : sanitizeNode(item, depth + 1, limits);
  }
  if (entries.length > limits.maxKeys) {
    out[TRUNCATED_KEY] = `${String(entries.length - limits.maxKeys)} clés omises`;
  }
  return out;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Expurge et borne des métadonnées. Le résultat est toujours un objet JSON valide dont
 * la sérialisation tient dans `limits.maxTotalBytes`.
 */
export function sanitizeMetadata(
  metadata: unknown,
  limits: MetadataLimits = DEFAULT_METADATA_LIMITS,
): JsonObject {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return metadata === undefined ? {} : { valeur: sanitizeNode(metadata, 1, limits) };
  }
  const bounded = sanitizeObject(metadata as Record<string, unknown>, 0, limits);
  const bytes = utf8Bytes(JSON.stringify(bounded));
  if (bytes <= limits.maxTotalBytes) return bounded;
  return { [TRUNCATED_KEY]: `métadonnées omises : ${String(bytes)} octets après bornage` };
}

/** Motif lisible : expurgé, borné, sur une seule ligne. */
export function sanitizeReason(reason: string): string {
  const singleLine = reason.replace(/[\r\n\t]+/g, " ");
  return truncate(redactString(singleLine), MAX_REASON_LENGTH);
}
