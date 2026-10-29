/**
 * Port de sortie vers le service de séances (G1) : événements de conversation dont le
 * registre d'échanges a besoin pour compter. Ce module ne compte rien et ne règle rien
 * (TRANSACTIONS §8) ; il garantit seulement qu'un fait de conversation n'est émis qu'une
 * fois, quels que soient les duplicatas ou le désordre de livraison.
 *
 * Minimisation : un événement ne porte ni texte, ni identité privée, ni capacité.
 */

import { appendFileSync } from "node:fs";
import type { Authorship, CloseReason, Provenance } from "./protocol.js";

export const CONVERSATION_EVENT_SCHEMA_VERSION = 1;

export const CONVERSATION_EVENT_TYPES = [
  "encounter_opened",
  "human_contribution_accepted",
  "agent_message_accepted",
  "encounter_closed",
  "encounter_revoked",
  "encounter_expired",
] as const;
export type ConversationEventType = (typeof CONVERSATION_EVENT_TYPES)[number];

export interface ConversationMessageFacts {
  readonly messageId: string;
  readonly sequence: number;
  readonly provenance: Exclude<Provenance, "technical">;
  /** Pseudonyme de rencontre de l'auteur. */
  readonly author: string;
  readonly idempotencyKey: string;
  readonly inReplyTo: string | null;
  readonly authorship: Authorship | null;
  readonly bodyChars: number;
  readonly artifactCount: number;
}

export interface ConversationEvent {
  readonly schemaVersion: typeof CONVERSATION_EVENT_SCHEMA_VERSION;
  /** Stable et déterministe : un rejeu produirait le même identifiant. */
  readonly eventId: string;
  readonly type: ConversationEventType;
  readonly encounterId: string;
  /** Référence opaque du contrat de séance de G1. */
  readonly sessionRef: string;
  readonly at: string;
  readonly message?: ConversationMessageFacts;
  readonly closedBy?: "guide" | "agent";
  readonly reason?: CloseReason;
}

/** Port de sortie. `emit` est appelé au plus une fois par `eventId`. */
export interface ExchangeEventSink {
  emit(event: ConversationEvent): void;
}

export class MemoryExchangeEventSink implements ExchangeEventSink {
  readonly events: ConversationEvent[] = [];

  emit(event: ConversationEvent): void {
    this.events.push(event);
  }
}

/** Une ligne JSON par événement, ajoutée de façon synchrone avant la réponse au client. */
export class JsonlFileExchangeEventSink implements ExchangeEventSink {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  emit(event: ConversationEvent): void {
    appendFileSync(this.#path, `${JSON.stringify(event)}\n`, "utf8");
  }
}
