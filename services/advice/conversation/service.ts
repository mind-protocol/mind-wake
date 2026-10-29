/**
 * Autorité de conversation SIMULÉE (G2) : rencontres, capacités, messages, idempotence et
 * émission d'événements. État en mémoire du processus passerelle ; aucune persistance,
 * aucun comptage d'échanges, aucun règlement (ces responsabilités sont celles de G1).
 *
 * Chaque appel est autorisé côté serveur à partir du principal authentifié de la
 * connexion et de la capacité présentée : une capacité copiée par un autre principal, ou
 * présentée après clôture, révocation ou expiration, est refusée sans dépendre de la
 * coopération d'un participant (SPEC §14.5, §15.4).
 */

import * as z from "zod";
import { digest, opaque, pseudonym, sameDigest } from "./capability.js";
import {
  CONVERSATION_EVENT_SCHEMA_VERSION,
  type ConversationEvent,
  type ConversationEventType,
  type ExchangeEventSink,
} from "./events.js";
import { checkMessageText } from "./guard.js";
import {
  LIMITS,
  TERMINAL_STATES,
  invitationSchema,
  type ArtifactRef,
  type AuditResult,
  type Authorship,
  type CloseReason,
  type DeliveredMessage,
  type EncounterState,
  type ErrorCode,
  type GuestHelloResult,
  type OpenResult,
  type Provenance,
  type ReceiveResult,
  type SendResult,
  type StatusResult,
} from "./protocol.js";

export class ConversationError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly state: EncounterState | undefined;

  constructor(code: ErrorCode, message: string, retryable = false, state?: EncounterState) {
    super(message);
    this.name = "ConversationError";
    this.code = code;
    this.retryable = retryable;
    this.state = state;
  }
}

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Configuration simulée de la passerelle. Les identités privées n'y figurent que pour
 * être tenues à l'écart des messages ; seules les empreintes des clés de liaison y sont.
 */
export const gatewayConfigSchema = z.strictObject({
  guides: z.array(z.strictObject({ privateId: z.string().min(1), keyDigest: sha256Hex })),
  invitations: z.array(
    z.strictObject({
      invitation: invitationSchema,
      sessionRef: z.string().regex(/^[A-Za-z0-9_-]{4,80}$/),
      topic: z.string().min(1).max(200),
      ownerPrivateId: z.string().min(1),
      guestKeyDigest: sha256Hex,
    }),
  ),
  operatorKeyDigest: sha256Hex,
  encounterTtlMs: z.int().min(1),
  retainTranscriptAfterClose: z.boolean(),
});
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

export type Principal =
  | { readonly kind: "guide"; readonly guideRef: string }
  | { readonly kind: "guest"; readonly invitation: string }
  | { readonly kind: "operator" };

interface StoredMessage {
  readonly messageId: string;
  readonly sequence: number;
  readonly provenance: Provenance;
  readonly author: string;
  /** `null` une fois le corps purgé selon la règle de conservation. */
  text: string | null;
  readonly at: string;
  readonly inReplyTo: string | null;
  readonly authorship: Authorship | null;
  readonly artifacts: readonly ArtifactRef[];
}

interface Encounter {
  readonly id: string;
  readonly invitation: string;
  readonly sessionRef: string;
  readonly topic: string;
  readonly ownerPrivateId: string;
  readonly guidePseudonym: string;
  readonly agentPseudonym: string;
  state: EncounterState;
  guideRef: string | null;
  openRequestId: string | null;
  guideCapDigest: string | null;
  guestCapDigest: string | null;
  guestGeneration: number;
  guestConnected: boolean;
  expiresAt: number | null;
  readonly messages: StoredMessage[];
  readonly idempotency: Map<string, { readonly payload: string; readonly messageId: string }>;
  close: { readonly principal: string; readonly key: string } | null;
  readonly waiters: Set<() => void>;
}

export interface SendInput {
  readonly encounterId: string;
  readonly capability: string;
  readonly idempotencyKey: string;
  readonly text: string;
  readonly inReplyTo?: string | undefined;
  readonly authorship?: Authorship | undefined;
  readonly artifacts?: readonly ArtifactRef[] | undefined;
}

export interface ServiceOptions {
  readonly now?: () => number;
}

export class ConversationService {
  readonly #config: GatewayConfig;
  readonly #sink: ExchangeEventSink;
  readonly #now: () => number;
  readonly #byId = new Map<string, Encounter>();
  readonly #byInvitation = new Map<string, Encounter>();
  /** guideRef opaque → identifiant privé ; jamais exposé hors de ce module. */
  readonly #guidePrivateIds = new Map<string, string>();
  readonly #guideRefByDigest = new Map<string, string>();

  constructor(config: GatewayConfig, sink: ExchangeEventSink, options: ServiceOptions = {}) {
    this.#config = config;
    this.#sink = sink;
    this.#now = options.now ?? Date.now;
    for (const guide of config.guides) {
      const ref = opaque("gref");
      this.#guidePrivateIds.set(ref, guide.privateId);
      this.#guideRefByDigest.set(guide.keyDigest, ref);
    }
    for (const inv of config.invitations) {
      const encounter: Encounter = {
        id: opaque("enc"),
        invitation: inv.invitation,
        sessionRef: inv.sessionRef,
        topic: inv.topic,
        ownerPrivateId: inv.ownerPrivateId,
        guidePseudonym: pseudonym("guide"),
        agentPseudonym: pseudonym("agent"),
        state: "invited",
        guideRef: null,
        openRequestId: null,
        guideCapDigest: null,
        guestCapDigest: null,
        guestGeneration: 0,
        guestConnected: false,
        expiresAt: null,
        messages: [],
        idempotency: new Map(),
        close: null,
        waiters: new Set(),
      };
      this.#byId.set(encounter.id, encounter);
      this.#byInvitation.set(inv.invitation, encounter);
    }
  }

  authenticate(role: Principal["kind"], key: string, invitation?: string): Principal {
    const keyDigest = digest(key);
    if (role === "guide") {
      for (const [candidate, guideRef] of this.#guideRefByDigest) {
        if (sameDigest(candidate, keyDigest)) return { kind: "guide", guideRef };
      }
    } else if (role === "guest") {
      const inv = this.#config.invitations.find((i) => i.invitation === invitation);
      if (inv !== undefined && sameDigest(inv.guestKeyDigest, keyDigest)) {
        return { kind: "guest", invitation: inv.invitation };
      }
    } else if (sameDigest(this.#config.operatorKeyDigest, keyDigest)) {
      return { kind: "operator" };
    }
    throw new ConversationError("not_authenticated", "Authentification refusée.");
  }

  /** Rattache (ou rattache de nouveau) le guest : nouvelle capacité, l'ancienne est invalidée. */
  attachGuest(principal: Principal): GuestHelloResult & { readonly generation: number } {
    if (principal.kind !== "guest") throw new ConversationError("wrong_role", "Réservé au guest.");
    const enc = this.#byInvitation.get(principal.invitation);
    if (enc === undefined) throw unavailable();
    this.#expireIfDue(enc);
    if (isTerminal(enc.state)) throw unavailable();
    const capability = opaque("cap", 32);
    enc.guestCapDigest = digest(capability);
    enc.guestGeneration += 1;
    const wasDisconnected = !enc.guestConnected;
    enc.guestConnected = true;
    if (enc.state === "open" && wasDisconnected && enc.guestGeneration > 1) {
      this.#technical(enc, "The agent reconnected.");
    }
    return {
      encounterId: enc.id,
      capability,
      selfPseudonym: enc.agentPseudonym,
      counterpartPseudonym: enc.guidePseudonym,
      state: enc.state,
      generation: enc.guestGeneration,
    };
  }

  detachGuest(invitation: string, generation: number): void {
    const enc = this.#byInvitation.get(invitation);
    if (enc === undefined || enc.guestGeneration !== generation || !enc.guestConnected) return;
    enc.guestConnected = false;
    if (enc.state === "open") this.#technical(enc, "The agent disconnected.");
  }

  open(principal: Principal, invitation: string, requestId: string): OpenResult {
    if (principal.kind !== "guide") throw new ConversationError("wrong_role", "Réservé au guide.");
    const enc = this.#byInvitation.get(invitation);
    if (enc === undefined) throw unavailable();
    this.#expireIfDue(enc);
    let reopened = false;
    if (enc.state === "invited") {
      this.#emit(enc, "encounter_opened", `evt_${enc.id}_opened`, {});
      enc.state = "open";
      enc.guideRef = principal.guideRef;
      enc.openRequestId = requestId;
      enc.expiresAt = this.#now() + this.#config.encounterTtlMs;
      this.#technical(enc, "Encounter opened. Only messages explicitly sent here are shared.");
    } else if (
      enc.state === "open" &&
      enc.guideRef === principal.guideRef &&
      enc.openRequestId === requestId
    ) {
      // Reprise d'une ouverture déjà acceptée : même rencontre, nouvelle capacité, aucun événement.
      reopened = true;
    } else {
      throw unavailable();
    }
    const capability = opaque("cap", 32);
    enc.guideCapDigest = digest(capability);
    return {
      encounterId: enc.id,
      capability,
      selfPseudonym: enc.guidePseudonym,
      counterpartPseudonym: enc.agentPseudonym,
      topic: enc.topic,
      expiresAt: new Date(enc.expiresAt ?? 0).toISOString(),
      reopened,
    };
  }

  send(principal: Principal, input: SendInput): SendResult {
    const enc = this.#access(principal, input.encounterId, input.capability);
    if (enc.state !== "open") {
      throw new ConversationError("encounter_not_open", "La rencontre n'est pas ouverte.", true);
    }
    const provenance: Provenance = principal.kind === "guide" ? "human" : "agent";
    if (provenance === "human" && input.authorship === undefined) {
      throw new ConversationError("bad_request", "Une contribution humaine déclare sa rédaction.");
    }
    if (provenance === "agent" && input.authorship !== undefined) {
      throw new ConversationError("bad_request", "Un message d'agent ne peut se déclarer humain.");
    }
    const artifacts = input.artifacts ?? [];
    const payload = digest(
      JSON.stringify([input.text, input.inReplyTo ?? null, input.authorship ?? null, artifacts]),
    );
    const idemKey = `${provenance}:${input.idempotencyKey}`;
    const previous = enc.idempotency.get(idemKey);
    if (previous !== undefined) {
      if (previous.payload !== payload) {
        throw new ConversationError(
          "idempotency_conflict",
          "Clé d'idempotence déjà utilisée avec un contenu différent.",
        );
      }
      const stored = enc.messages.find((m) => m.messageId === previous.messageId);
      return { messageId: previous.messageId, sequence: stored?.sequence ?? 0, duplicate: true };
    }
    const privateIds = this.#privateIdsOf(enc);
    for (const text of [input.text, ...artifacts.map((a) => a.title)]) {
      const verdict = checkMessageText(text, privateIds);
      if (!verdict.ok) throw new ConversationError(verdict.code, verdict.message);
    }
    if (input.inReplyTo !== undefined) {
      const expected: Provenance = provenance === "human" ? "agent" : "human";
      const target = enc.messages.find((m) => m.messageId === input.inReplyTo);
      if (target?.provenance !== expected) {
        throw new ConversationError(
          "unknown_reference",
          "Le message cité n'appartient pas à la contrepartie de cette rencontre.",
          true,
        );
      }
    }
    if (enc.messages.length >= LIMITS.maxMessagesPerEncounter) {
      throw new ConversationError("limit_reached", "Nombre maximal de messages atteint.");
    }
    const message: StoredMessage = {
      messageId: opaque("msg"),
      sequence: enc.messages.length + 1,
      provenance,
      author: provenance === "human" ? enc.guidePseudonym : enc.agentPseudonym,
      text: input.text,
      at: this.#iso(),
      inReplyTo: input.inReplyTo ?? null,
      authorship: input.authorship ?? null,
      artifacts,
    };
    // Événement d'abord : si l'émission échoue, rien n'est stocké et un retry reste sûr.
    this.#emit(
      enc,
      provenance === "human" ? "human_contribution_accepted" : "agent_message_accepted",
      `evt_${message.messageId}`,
      {
        message: {
          messageId: message.messageId,
          sequence: message.sequence,
          provenance,
          author: message.author,
          idempotencyKey: input.idempotencyKey,
          inReplyTo: message.inReplyTo,
          authorship: message.authorship,
          bodyChars: input.text.length,
          artifactCount: artifacts.length,
        },
      },
    );
    enc.messages.push(message);
    enc.idempotency.set(idemKey, { payload, messageId: message.messageId });
    wake(enc);
    return { messageId: message.messageId, sequence: message.sequence, duplicate: false };
  }

  receive(
    principal: Principal,
    input: {
      readonly encounterId: string;
      readonly capability: string;
      readonly after: number;
      readonly limit: number;
    },
  ): ReceiveResult {
    const enc = this.#access(principal, input.encounterId, input.capability);
    const selfProvenance: Provenance = principal.kind === "guide" ? "human" : "agent";
    const batch = enc.messages
      .filter((m) => m.sequence > input.after)
      .slice(0, input.limit)
      .map((m) => deliver(m, selfProvenance));
    return { messages: batch, next: batch.at(-1)?.sequence ?? input.after, state: enc.state };
  }

  /** Attente bornée de nouveaux messages ou d'une fin de rencontre ; aucune boucle modèle. */
  async waitFor(encounterId: string, after: number, waitMs: number): Promise<void> {
    const enc = this.#byId.get(encounterId);
    if (enc === undefined || waitMs === 0) return;
    if (enc.messages.length > after || isTerminal(enc.state)) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        enc.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(waitMs, LIMITS.maxWaitMs));
      enc.waiters.add(done);
    });
  }

  close(
    principal: Principal,
    input: {
      readonly encounterId: string;
      readonly capability: string;
      readonly idempotencyKey: string;
      readonly reason: CloseReason;
    },
  ): { readonly state: EncounterState; readonly duplicate: boolean } {
    const enc = this.#access(principal, input.encounterId, input.capability, true);
    const who = principal.kind === "guide" ? "guide" : "agent";
    if (isTerminal(enc.state)) {
      if (enc.close?.principal === who && enc.close.key === input.idempotencyKey) {
        return { state: enc.state, duplicate: true };
      }
      throw closedError(enc.state);
    }
    this.#terminate(enc, "closed", "encounter_closed", { closedBy: who, reason: input.reason });
    enc.close = { principal: who, key: input.idempotencyKey };
    return { state: enc.state, duplicate: false };
  }

  status(
    principal: Principal,
    input: { readonly encounterId: string; readonly capability: string },
  ): StatusResult {
    const enc = this.#access(principal, input.encounterId, input.capability);
    const count = (p: Provenance): number => enc.messages.filter((m) => m.provenance === p).length;
    const guide = principal.kind === "guide";
    return {
      encounterId: enc.id,
      state: enc.state,
      selfPseudonym: guide ? enc.guidePseudonym : enc.agentPseudonym,
      counterpartPseudonym: guide ? enc.agentPseudonym : enc.guidePseudonym,
      guestConnected: enc.guestConnected,
      messages: { human: count("human"), agent: count("agent"), technical: count("technical") },
      expiresAt: enc.expiresAt === null ? null : new Date(enc.expiresAt).toISOString(),
    };
  }

  revoke(principal: Principal, encounterId: string): { readonly state: EncounterState } {
    if (principal.kind !== "operator") {
      throw new ConversationError("wrong_role", "Réservé à l'opérateur.");
    }
    const enc = this.#byId.get(encounterId);
    if (enc === undefined) throw new ConversationError("access_denied", "Accès refusé.");
    this.#expireIfDue(enc);
    if (!isTerminal(enc.state)) this.#terminate(enc, "revoked", "encounter_revoked", {});
    return { state: enc.state };
  }

  /** Vue opérateur sans contenu : montre l'application de la règle de conservation. */
  audit(principal: Principal, encounterId: string): AuditResult {
    if (principal.kind !== "operator") {
      throw new ConversationError("wrong_role", "Réservé à l'opérateur.");
    }
    const enc = this.#byId.get(encounterId);
    if (enc === undefined) throw new ConversationError("access_denied", "Accès refusé.");
    this.#expireIfDue(enc);
    return {
      state: enc.state,
      sessionRef: enc.sessionRef,
      entries: enc.messages.map((m) => ({
        messageId: m.messageId,
        sequence: m.sequence,
        provenance: m.provenance,
        bodyRetained: m.text !== null,
      })),
    };
  }

  /** Expire les rencontres échues ; appelé périodiquement par la passerelle. */
  sweep(): void {
    for (const enc of this.#byId.values()) this.#expireIfDue(enc);
  }

  #access(
    principal: Principal,
    encounterId: string,
    capability: string,
    allowTerminal = false,
  ): Encounter {
    const enc = this.#byId.get(encounterId);
    const denied = new ConversationError("access_denied", "Accès refusé.");
    if (enc === undefined) throw denied;
    let expected: string | null = null;
    if (principal.kind === "guide" && enc.guideRef === principal.guideRef) {
      expected = enc.guideCapDigest;
    } else if (principal.kind === "guest" && enc.invitation === principal.invitation) {
      expected = enc.guestCapDigest;
    }
    if (expected === null || !sameDigest(expected, digest(capability))) throw denied;
    this.#expireIfDue(enc);
    if (isTerminal(enc.state) && !allowTerminal) throw closedError(enc.state);
    return enc;
  }

  #expireIfDue(enc: Encounter): void {
    if (enc.state === "open" && enc.expiresAt !== null && this.#now() >= enc.expiresAt) {
      this.#terminate(enc, "expired", "encounter_expired", {});
    }
  }

  #terminate(
    enc: Encounter,
    state: EncounterState,
    type: ConversationEventType,
    extra: Pick<ConversationEvent, "closedBy" | "reason">,
  ): void {
    this.#emit(enc, type, `evt_${enc.id}_${state}`, extra);
    enc.state = state;
    if (!this.#config.retainTranscriptAfterClose) {
      for (const message of enc.messages) message.text = null;
    }
    enc.idempotency.clear();
    wake(enc);
  }

  #technical(enc: Encounter, text: string): void {
    if (enc.messages.length >= LIMITS.maxMessagesPerEncounter) return;
    enc.messages.push({
      messageId: opaque("msg"),
      sequence: enc.messages.length + 1,
      provenance: "technical",
      author: "service",
      text,
      at: this.#iso(),
      inReplyTo: null,
      authorship: null,
      artifacts: [],
    });
    wake(enc);
  }

  #emit(
    enc: Encounter,
    type: ConversationEventType,
    eventId: string,
    extra: Partial<Pick<ConversationEvent, "message" | "closedBy" | "reason">>,
  ): void {
    this.#sink.emit({
      schemaVersion: CONVERSATION_EVENT_SCHEMA_VERSION,
      eventId,
      type,
      encounterId: enc.id,
      sessionRef: enc.sessionRef,
      at: this.#iso(),
      ...extra,
    });
  }

  #privateIdsOf(enc: Encounter): string[] {
    const ids = [enc.ownerPrivateId];
    const guideId = enc.guideRef === null ? undefined : this.#guidePrivateIds.get(enc.guideRef);
    if (guideId !== undefined) ids.push(guideId);
    return ids;
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }
}

function isTerminal(state: EncounterState): boolean {
  return TERMINAL_STATES.includes(state);
}

function unavailable(): ConversationError {
  return new ConversationError("invitation_unavailable", "Invitation indisponible.");
}

function closedError(state: EncounterState): ConversationError {
  return new ConversationError("encounter_closed", `Rencontre terminée (${state}).`, false, state);
}

function wake(enc: Encounter): void {
  for (const waiter of [...enc.waiters]) waiter();
}

function deliver(m: StoredMessage, selfProvenance: Provenance): DeliveredMessage {
  return {
    messageId: m.messageId,
    sequence: m.sequence,
    provenance: m.provenance,
    author: m.author,
    fromSelf: m.provenance === selfProvenance,
    text: m.text ?? "",
    at: m.at,
    ...(m.inReplyTo === null ? {} : { inReplyTo: m.inReplyTo }),
    ...(m.authorship === null ? {} : { authorship: m.authorship }),
    ...(m.artifacts.length === 0 ? {} : { artifacts: m.artifacts }),
  };
}
