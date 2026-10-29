/**
 * Validation des événements de conversation entrants. Ils viennent d'un canal non fiable
 * (G2, relié par G3) : la forme est vérifiée à l'exécution et aucun texte libre n'est
 * conservé.
 */

import { canonicalJson, sha256 } from "./contract.js";
import type {
  ContributionProvenance,
  ExchangeEvent,
  ExchangeEventKind,
  ExchangeEventProducer,
  TechnicalSubtype,
} from "./types.js";

export class InvalidEventError extends Error {
  override readonly name = "InvalidEventError";
}

const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CLAIM_LENGTH = 2_000;

const PROVENANCES: readonly ContributionProvenance[] = [
  "human_explicit",
  "assistant_draft",
  "tool_output",
  "guest_text",
];
const TECHNICAL: readonly TechnicalSubtype[] = [
  "tool_call",
  "tool_result",
  "notification",
  "ack",
  "greeting",
  "error",
  "delivery_retry",
  "typing",
];

/** Producteur autorisé à attester chaque type d'événement. */
const PRODUCERS: Readonly<Record<ExchangeEventKind, readonly ExchangeEventProducer[]>> = {
  agent_point: ["agent_runtime"],
  human_contribution: ["channel"],
  agent_clarification: ["agent_runtime"],
  agent_reply: ["agent_runtime"],
  agent_checkpoint: ["agent_runtime"],
  technical: ["channel", "agent_runtime"],
  final_summary: ["agent_runtime"],
  free_text_claim: ["channel", "agent_runtime"],
};

function ref(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== "string" || !REF.test(value)) {
    throw new InvalidEventError(`${field} : référence opaque attendue`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new InvalidEventError(`${field} invalide`);
  }
  return value as T;
}

export function parseExchangeEvent(input: unknown): ExchangeEvent {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidEventError("événement : objet attendu");
  }
  const raw = input as Record<string, unknown>;
  const kind = oneOf(raw["kind"], Object.keys(PRODUCERS) as ExchangeEventKind[], "kind");
  const producer = oneOf(raw["producer"], ["channel", "agent_runtime"] as const, "producer");
  if (!PRODUCERS[kind].includes(producer)) {
    throw new InvalidEventError(`${producer} ne peut pas attester ${kind}`);
  }
  const base = { eventId: ref(raw, "eventId"), producer, contractId: ref(raw, "contractId") };
  switch (kind) {
    case "agent_point":
    case "agent_clarification":
      return {
        ...base,
        kind,
        exchangeId: ref(raw, "exchangeId"),
        messageId: ref(raw, "messageId"),
      } as ExchangeEvent;
    case "human_contribution":
      return {
        ...base,
        kind,
        exchangeId: ref(raw, "exchangeId"),
        messageId: ref(raw, "messageId"),
        authorPrincipalId: ref(raw, "authorPrincipalId"),
        provenance: oneOf(raw["provenance"], PROVENANCES, "provenance"),
      } as ExchangeEvent;
    case "agent_reply": {
      const part = raw["part"] as Record<string, unknown> | null | undefined;
      if (
        part === null ||
        typeof part !== "object" ||
        !Number.isSafeInteger(part["index"]) ||
        (part["index"] as number) < 0 ||
        typeof part["final"] !== "boolean" ||
        typeof raw["substantive"] !== "boolean"
      ) {
        throw new InvalidEventError("agent_reply : part {index, final} et substantive requis");
      }
      return {
        ...base,
        kind,
        exchangeId: ref(raw, "exchangeId"),
        messageId: ref(raw, "messageId"),
        part: { index: part["index"] as number, final: part["final"] },
        substantive: raw["substantive"],
      } as ExchangeEvent;
    }
    case "agent_checkpoint":
      return {
        ...base,
        kind,
        exchangeId: ref(raw, "exchangeId"),
        checkpointRef: ref(raw, "checkpointRef"),
      } as ExchangeEvent;
    case "technical":
      return {
        ...base,
        kind,
        subtype: oneOf(raw["subtype"], TECHNICAL, "subtype"),
        ...(raw["exchangeId"] === undefined ? {} : { exchangeId: ref(raw, "exchangeId") }),
      } as ExchangeEvent;
    case "final_summary":
      return { ...base, kind, messageId: ref(raw, "messageId") } as ExchangeEvent;
    case "free_text_claim": {
      const claim = raw["claim"];
      if (typeof claim !== "string" || claim.length > MAX_CLAIM_LENGTH) {
        throw new InvalidEventError("free_text_claim : texte borné attendu");
      }
      return { ...base, kind, claim } as ExchangeEvent;
    }
  }
}

/**
 * Empreinte de déduplication. Le texte libre est exclu : un hash d'une phrase courte
 * resterait devinable (TRANSACTIONS §15) et ce texte n'a aucune autorité.
 */
export function eventDigest(event: ExchangeEvent): string {
  const material = event.kind === "free_text_claim" ? { ...event, claim: "[non conservé]" } : event;
  return sha256(canonicalJson(material));
}
