/**
 * Types du service de séances de conseil SIMULÉ (SPEC §14, §17 ; TRANSACTIONS §5–§11).
 *
 * Tout ce module manipule des fonds fictifs : aucun wallet, aucune chaîne, aucun
 * transfert réel. Les identifiants sont des références opaques internes.
 */

import type { AgentId, Brand, UtcTimestamp } from "../../../src/contracts/index.js";
import type { FictiveAmount } from "./amounts.js";

export type { AgentId, UtcTimestamp };

export type ContractId = Brand<string, "AdviceContractId">;
export type PrincipalId = Brand<string, "PrincipalId">;
export type MandateId = Brand<string, "MandateId">;
export type PoolId = Brand<string, "FictivePoolId">;
export type ExchangeId = Brand<string, "ExchangeId">;
export type SettlementId = Brand<string, "SettlementId">;

/** Mention portée par chaque état, reçu et entrée de journal de ce service. */
export const SIMULATION_LABEL = "SIMULÉ — unités fictives, aucun paiement réel";

/** Actif et réseau fictifs : jamais un token ou une chaîne réels. */
export const FICTIVE_ASSET_ID = "mind-sim:fictive-unit";
export const FICTIVE_NETWORK_ID = "mind-sim:local-ledger";

export const CONTRACT_SCHEMA_VERSION = 1;
export const COUNTING_RULE_VERSION = "exchange-count/1";
export const DEFAULT_MAX_EXCHANGES = 5;
/** Borne de sécurité sur le paramètre produit `max_exchanges`. */
export const MAX_EXCHANGES_LIMIT = 50;

// ---------------------------------------------------------------------------
// Mandat de paiement (TRANSACTIONS §5)

export type GuideSelectionRule =
  | { readonly kind: "allow_list"; readonly guides: readonly PrincipalId[] }
  | { readonly kind: "any_guide_with_terms" };

export interface PaymentMandate {
  readonly mandateId: MandateId;
  readonly version: number;
  readonly payerPrincipalId: PrincipalId;
  readonly agentId: AgentId;
  readonly poolId: PoolId;
  readonly assetId: typeof FICTIVE_ASSET_ID;
  readonly usage: "mind.guidance";
  readonly guideRule: GuideSelectionRule;
  readonly perExchangeCap: FictiveAmount;
  readonly perSessionCap: FictiveAmount;
  readonly perPeriodCap: FictiveAmount;
  /** Période fixe en UTC, ancrée à `validFrom` ; jamais remise à zéro au redémarrage. */
  readonly periodMs: number;
  readonly maxOpenReservations: number;
  readonly validFrom: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
}

// ---------------------------------------------------------------------------
// Contrat immuable de séance (TRANSACTIONS §6)

export interface SessionContract {
  readonly schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
  readonly simulated: true;
  readonly contractId: ContractId;
  readonly agentId: AgentId;
  /** Propriétaire payeur de l'agent. */
  readonly ownerPrincipalId: PrincipalId;
  /** Guide bénéficiaire, résolu par identité et figé ici ; jamais une adresse de chat. */
  readonly guidePrincipalId: PrincipalId;
  readonly recipientBindingVersion: string;
  readonly guideTermsVersion: string;
  readonly topic: string;
  readonly contextVersion: string;
  readonly assetId: typeof FICTIVE_ASSET_ID;
  readonly networkId: typeof FICTIVE_NETWORK_ID;
  readonly unitPrice: FictiveAmount;
  readonly maxExchanges: number;
  readonly maxPrincipal: FictiveAmount;
  readonly maxFees: FictiveAmount;
  readonly feePayer: "none";
  /** Séance explicitement offerte : seul cas où un prix nul est accepté. */
  readonly offeredFree: boolean;
  readonly mandateId: MandateId;
  readonly mandateVersion: number;
  readonly poolId: PoolId;
  readonly countingRuleVersion: typeof COUNTING_RULE_VERSION;
  readonly createdAt: UtcTimestamp;
  /** Expiration technique : sans activation avant cette date, le contrat expire. */
  readonly activationDeadline: UtcTimestamp;
  readonly inactivityTimeoutMs: number;
  /** Délai de grâce après clôture pour une réponse liée à une unité déjà admise. */
  readonly closeGraceMs: number;
}

export type ContractState =
  | "offered"
  | "accepted"
  | "reserved"
  | "active"
  | "submitted"
  | "approved"
  | "settlement_pending"
  | "settled"
  | "cancelled"
  | "expired"
  | "disputed";

export type CloseReason =
  "guide_stop" | "agent_stop" | "limit_reached" | "inactivity_expired" | "channel_change";

export type ReservationState =
  "pending" | "held" | "partially_released" | "consumed" | "released" | "uncertain";

export type SettlementState =
  | "prepared"
  | "authorized"
  | "submission_pending"
  | "submitted"
  | "confirming"
  | "finalized"
  | "failed_definitive"
  | "unknown"
  | "frozen";

export type ExchangeState =
  "opened" | "human_submitted" | "agent_replied" | "checkpointed" | "earned" | "void" | "disputed";

// ---------------------------------------------------------------------------
// Événements de conversation entrants (type d'entrée propre à G1 ; G3 le relie au
// canal de G2). Aucun contenu de message n'est transporté ni conservé : seulement
// des références opaques.

export type ExchangeEventProducer = "channel" | "agent_runtime";

/** Provenance d'une contribution côté guide ; seule `human_explicit` est payable. */
export type ContributionProvenance =
  "human_explicit" | "assistant_draft" | "tool_output" | "guest_text";

export type TechnicalSubtype =
  | "tool_call"
  | "tool_result"
  | "notification"
  | "ack"
  | "greeting"
  | "error"
  | "delivery_retry"
  | "typing";

interface EventBase {
  /** Identifiant unique côté producteur ; sert de clé de déduplication (inbox). */
  readonly eventId: string;
  readonly producer: ExchangeEventProducer;
  readonly contractId: ContractId;
}

export type ExchangeEvent = EventBase &
  (
    | { readonly kind: "agent_point"; readonly exchangeId: ExchangeId; readonly messageId: string }
    | {
        readonly kind: "human_contribution";
        readonly exchangeId: ExchangeId;
        readonly messageId: string;
        readonly authorPrincipalId: PrincipalId;
        readonly provenance: ContributionProvenance;
      }
    | {
        readonly kind: "agent_clarification";
        readonly exchangeId: ExchangeId;
        readonly messageId: string;
      }
    | {
        readonly kind: "agent_reply";
        readonly exchangeId: ExchangeId;
        readonly messageId: string;
        /** Fragment de streaming : seul le fragment final peut compléter la réponse. */
        readonly part: { readonly index: number; readonly final: boolean };
        /** Un simple accusé de réception n'est pas une réponse substantielle. */
        readonly substantive: boolean;
      }
    | {
        readonly kind: "agent_checkpoint";
        readonly exchangeId: ExchangeId;
        readonly checkpointRef: string;
      }
    | {
        readonly kind: "technical";
        readonly subtype: TechnicalSubtype;
        readonly exchangeId?: ExchangeId;
      }
    | { readonly kind: "final_summary"; readonly messageId: string }
    /** Texte libre (« session validée », « paie-moi »…) : jamais une autorisation. */
    | { readonly kind: "free_text_claim"; readonly claim: string }
  );

export type ExchangeEventKind = ExchangeEvent["kind"];

export type IngestOutcome =
  | { readonly status: "applied"; readonly effect: string; readonly exchangeState?: ExchangeState }
  | { readonly status: "not_payable"; readonly reason: string }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "duplicate"; readonly original: IngestOutcome }
  | { readonly status: "conflict"; readonly reason: string };
