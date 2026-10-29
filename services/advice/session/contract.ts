/**
 * Contrat immuable de séance : construction validée, sérialisation canonique exacte,
 * digest et machine à états (TRANSACTIONS §6 et §9).
 */

import { createHash } from "node:crypto";
import { parseAmount, multiplyAmount, formatAmount, AmountError } from "./amounts.js";
import {
  CONTRACT_SCHEMA_VERSION,
  COUNTING_RULE_VERSION,
  DEFAULT_MAX_EXCHANGES,
  FICTIVE_ASSET_ID,
  FICTIVE_NETWORK_ID,
  MAX_EXCHANGES_LIMIT,
  type AgentId,
  type ContractId,
  type ContractState,
  type MandateId,
  type PaymentMandate,
  type PoolId,
  type PrincipalId,
  type SessionContract,
  type UtcTimestamp,
} from "./types.js";

export class ContractError extends Error {
  override readonly name = "ContractError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TOPIC_LENGTH = 200;

export function assertOpaqueId(value: unknown, field: string): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new ContractError("invalid_id", `${field} : identifiant opaque attendu`);
  }
  return value;
}

/** Paramètres d'une offre ; montants en chaîne décimale ou `bigint`, jamais `number`. */
export interface ContractOffer {
  readonly contractId: string;
  readonly agentId: string;
  readonly guidePrincipalId: string;
  readonly recipientBindingVersion: string;
  readonly guideTermsVersion: string;
  readonly topic: string;
  readonly contextVersion: string;
  readonly unitPrice: string | bigint;
  readonly maxExchanges?: number;
  readonly offeredFree?: boolean;
  readonly activationDeadline: UtcTimestamp;
  readonly inactivityTimeoutMs: number;
  readonly closeGraceMs: number;
}

/**
 * Construit le contrat à partir d'une offre et du mandat applicable. Toute valeur hors
 * bornes est refusée ; rien n'est arrondi ni tronqué.
 */
export function buildContract(
  offer: ContractOffer,
  mandate: PaymentMandate,
  createdAt: UtcTimestamp,
): SessionContract {
  const maxExchanges = offer.maxExchanges ?? DEFAULT_MAX_EXCHANGES;
  if (
    !Number.isSafeInteger(maxExchanges) ||
    maxExchanges < 1 ||
    maxExchanges > MAX_EXCHANGES_LIMIT
  ) {
    throw new ContractError(
      "invalid_max_exchanges",
      `max_exchanges doit être un entier entre 1 et ${String(MAX_EXCHANGES_LIMIT)}`,
    );
  }
  let unitPrice: bigint;
  let maxPrincipal: bigint;
  try {
    unitPrice = parseAmount(offer.unitPrice, "prix unitaire");
    maxPrincipal = multiplyAmount(unitPrice, maxExchanges, "montant maximal");
  } catch (error) {
    if (error instanceof AmountError) throw new ContractError("invalid_amount", error.message);
    throw error;
  }
  const offeredFree = offer.offeredFree ?? false;
  if (unitPrice === 0n && !offeredFree) {
    throw new ContractError(
      "zero_price_not_offered",
      "prix nul refusé : une séance gratuite doit être explicitement offerte",
    );
  }
  if (unitPrice !== 0n && offeredFree) {
    throw new ContractError("free_with_price", "une séance offerte ne peut pas avoir de prix");
  }
  for (const [field, value] of [
    ["inactivityTimeoutMs", offer.inactivityTimeoutMs],
    ["closeGraceMs", offer.closeGraceMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ContractError("invalid_duration", `${field} : entier positif attendu`);
    }
  }
  if (typeof offer.topic !== "string" || offer.topic.length === 0) {
    throw new ContractError("invalid_topic", "sujet requis");
  }
  if (offer.topic.length > MAX_TOPIC_LENGTH || /[\r\n\t]/.test(offer.topic)) {
    throw new ContractError("invalid_topic", "sujet sur une ligne, 200 caractères au plus");
  }
  return Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    simulated: true,
    contractId: assertOpaqueId(offer.contractId, "contractId") as ContractId,
    agentId: assertOpaqueId(offer.agentId, "agentId") as AgentId,
    ownerPrincipalId: mandate.payerPrincipalId,
    guidePrincipalId: assertOpaqueId(offer.guidePrincipalId, "guidePrincipalId") as PrincipalId,
    recipientBindingVersion: assertOpaqueId(
      offer.recipientBindingVersion,
      "recipientBindingVersion",
    ),
    guideTermsVersion: assertOpaqueId(offer.guideTermsVersion, "guideTermsVersion"),
    topic: offer.topic,
    contextVersion: assertOpaqueId(offer.contextVersion, "contextVersion"),
    assetId: FICTIVE_ASSET_ID,
    networkId: FICTIVE_NETWORK_ID,
    unitPrice,
    maxExchanges,
    maxPrincipal,
    maxFees: 0n,
    feePayer: "none",
    offeredFree,
    mandateId: mandate.mandateId,
    mandateVersion: mandate.version,
    poolId: mandate.poolId,
    countingRuleVersion: COUNTING_RULE_VERSION,
    createdAt,
    activationDeadline: offer.activationDeadline,
    inactivityTimeoutMs: offer.inactivityTimeoutMs,
    closeGraceMs: offer.closeGraceMs,
  });
}

// ---------------------------------------------------------------------------
// Sérialisation canonique : clés triées, montants en chaînes décimales exactes.

type Canonical = string | number | boolean | null | Canonical[] | { [key: string]: Canonical };

function toCanonical(value: unknown): Canonical {
  if (typeof value === "bigint") return formatAmount(value);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new ContractError("not_canonical", "nombre non entier");
    return value;
  }
  if (Array.isArray(value)) return value.map(toCanonical);
  if (typeof value === "object") {
    const out: { [key: string]: Canonical } = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) out[key] = toCanonical(entry);
    }
    return out;
  }
  throw new ContractError("not_canonical", `type non sérialisable : ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonical(value));
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function contractDigest(contract: SessionContract): string {
  return sha256(canonicalJson(contract));
}

const AMOUNT_FIELDS = ["unitPrice", "maxPrincipal", "maxFees"] as const;

/** Relit un contrat persisté ; les montants redeviennent des `bigint` exacts. */
export function parseStoredContract(json: string): SessionContract {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  for (const field of AMOUNT_FIELDS) out[field] = parseAmount(raw[field], field);
  return Object.freeze(out) as unknown as SessionContract;
}

const MANDATE_AMOUNT_FIELDS = ["perExchangeCap", "perSessionCap", "perPeriodCap"] as const;

export function parseStoredMandate(json: string): PaymentMandate {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  for (const field of MANDATE_AMOUNT_FIELDS) out[field] = parseAmount(raw[field], field);
  return Object.freeze(out) as unknown as PaymentMandate;
}

/** Normalise un mandat fourni de l'extérieur (montants exacts, bornes). */
export function buildMandate(input: {
  readonly mandateId: string;
  readonly version: number;
  readonly payerPrincipalId: string;
  readonly agentId: string;
  readonly poolId: string;
  readonly guideRule: PaymentMandate["guideRule"];
  readonly perExchangeCap: string | bigint;
  readonly perSessionCap: string | bigint;
  readonly perPeriodCap: string | bigint;
  readonly periodMs: number;
  readonly maxOpenReservations: number;
  readonly validFrom: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
}): PaymentMandate {
  for (const [field, value] of [
    ["version", input.version],
    ["periodMs", input.periodMs],
    ["maxOpenReservations", input.maxOpenReservations],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ContractError("invalid_mandate", `${field} : entier strictement positif attendu`);
    }
  }
  try {
    return Object.freeze({
      mandateId: assertOpaqueId(input.mandateId, "mandateId") as MandateId,
      version: input.version,
      payerPrincipalId: assertOpaqueId(input.payerPrincipalId, "payerPrincipalId") as PrincipalId,
      agentId: assertOpaqueId(input.agentId, "agentId") as AgentId,
      poolId: assertOpaqueId(input.poolId, "poolId") as PoolId,
      assetId: FICTIVE_ASSET_ID,
      usage: "mind.guidance",
      guideRule: input.guideRule,
      perExchangeCap: parseAmount(input.perExchangeCap, "perExchangeCap"),
      perSessionCap: parseAmount(input.perSessionCap, "perSessionCap"),
      perPeriodCap: parseAmount(input.perPeriodCap, "perPeriodCap"),
      periodMs: input.periodMs,
      maxOpenReservations: input.maxOpenReservations,
      validFrom: input.validFrom,
      expiresAt: input.expiresAt,
    });
  } catch (error) {
    if (error instanceof AmountError) throw new ContractError("invalid_mandate", error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Machine à états du contrat (TRANSACTIONS §9)

const TRANSITIONS: Readonly<Record<ContractState, readonly ContractState[]>> = {
  offered: ["accepted", "cancelled", "expired"],
  accepted: ["reserved", "cancelled", "expired"],
  reserved: ["active", "cancelled", "expired"],
  active: ["submitted", "disputed"],
  submitted: ["approved", "disputed"],
  // `settled` directement si rien n'est dû : clôture sans transfert.
  approved: ["settlement_pending", "settled", "disputed"],
  settlement_pending: ["settled", "disputed"],
  settled: [],
  cancelled: [],
  expired: [],
  disputed: [],
};

export function canTransition(from: ContractState, to: ContractState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: ContractState): boolean {
  return TRANSITIONS[state].length === 0;
}
