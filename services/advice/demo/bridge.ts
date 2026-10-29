/**
 * Adaptateur fin entre le canal de conversation (G2) et le service de séances (G1) :
 * implémente le port `ExchangeEventSink` de G2 et traduit chaque fait de conversation en
 * `ExchangeEvent` de G1. Il ne compte rien lui-même : G1 décide de ce qui est payable.
 *
 * SIMULÉ. Les producteurs ne sont pas authentifiés cryptographiquement (P15) : un message
 * d'agent relayé par la passerelle est attesté `agent_runtime` parce que la passerelle a
 * authentifié la clé de liaison du guest, et une sauvegarde est attestée par le runtime
 * de l'agent via une référence opaque. Aucun texte ne traverse cet adaptateur.
 *
 * Traduction (SPEC §17.3) :
 * - le premier message de l'agent, puis chaque réponse qui contient la question suivante,
 *   devient le point (`agent_point`) de l'échange suivant, ouvert seulement quand
 *   l'échange précédent est sauvegardé ;
 * - une contribution humaine qui cite ce point devient `human_contribution` ; seule une
 *   rédaction `human_verbatim` vaut `human_explicit`, un brouillon approuvé reste
 *   `assistant_draft` (non payable) ;
 * - un message d'agent qui cite une contribution devient `agent_reply` ; un message sans
 *   citation pendant un échange ouvert est une clarification, sinon une synthèse ;
 * - une attestation de sauvegarde devient `agent_checkpoint` ;
 * - l'ouverture de la rencontre active le contrat, sa fin le clôture.
 */

import type {
  ConversationEvent,
  ConversationMessageFacts,
  ExchangeEventSink,
} from "../conversation/events.js";
import type { CloseReason as EncounterCloseReason } from "../conversation/protocol.js";
import {
  AdviceError,
  type AdviceSessionService,
  type CloseReason,
  type ContractId,
  type ContributionProvenance,
  type ExchangeEvent,
  type ExchangeId,
  type IngestOutcome,
  type PrincipalId,
} from "../session/index.js";

/** Une réponse plus courte qu'un accusé de réception n'est pas substantielle. */
export const MIN_SUBSTANTIVE_CHARS = 40;

const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Les identifiants de G2 (`msg_…`, base64url) contiennent `_`, refusé par G1. `.` n'existe
 * pas dans leur alphabet : la substitution est injective.
 */
export function toRef(id: string): string {
  const ref = id.replace(/_/g, ".");
  if (!REF.test(ref)) throw new Error(`identifiant non convertible en référence : ${id}`);
  return ref;
}

/** Sauvegarde attestée par le runtime de l'agent (fichier GUEST_CHECKPOINTS). */
export interface CheckpointAttestation {
  readonly encounterId: string;
  /** Contribution humaine traitée par la réponse sauvegardée. */
  readonly inReplyTo: string;
  readonly checkpointRef: string;
}

export interface BridgeBinding {
  readonly contractId: ContractId;
  readonly guidePrincipalId: PrincipalId;
}

export interface BridgeRecord {
  /** Fait source : identifiant d'événement G2 ou référence de sauvegarde. */
  readonly source: string;
  readonly action: string;
  readonly outcome: string;
}

interface Exchange {
  readonly exchangeId: ExchangeId;
  human: string | null;
  checkpointed: boolean;
}

interface Track {
  readonly binding: BridgeBinding;
  readonly exchanges: Exchange[];
  readonly byPoint: Map<string, Exchange>;
  /** Toute contribution humaine rattachée à un échange, payable ou non. */
  readonly byHuman: Map<string, Exchange>;
  /** Message d'agent en attente d'ouvrir l'échange suivant. */
  candidate: string | null;
  /** Contributions qui citent un point pas encore ouvert. */
  readonly deferred: ConversationMessageFacts[];
  closed: boolean;
}

export class SessionLedgerBridge implements ExchangeEventSink {
  readonly #service: AdviceSessionService;
  readonly #bindings = new Map<string, BridgeBinding>();
  readonly #tracks = new Map<string, Track>();
  readonly #seen = new Set<string>();
  readonly #records: BridgeRecord[] = [];
  readonly #onRecord: ((record: BridgeRecord) => void) | undefined;
  readonly #pull: (() => readonly CheckpointAttestation[]) | undefined;

  constructor(
    service: AdviceSessionService,
    options: {
      onRecord?: (record: BridgeRecord) => void;
      /** Nouvelles attestations de sauvegarde, lues avant chaque fait de conversation. */
      pullCheckpoints?: () => readonly CheckpointAttestation[];
    } = {},
  ) {
    this.#service = service;
    this.#onRecord = options.onRecord;
    this.#pull = options.pullCheckpoints;
  }

  /** Applique les attestations de sauvegarde parues depuis le dernier appel. */
  sync(): void {
    for (const attestation of this.#pull?.() ?? []) this.attest(attestation);
  }

  /** Lie la référence de séance de l'invitation G2 au contrat G1. */
  bind(sessionRef: string, binding: BridgeBinding): void {
    this.#bindings.set(sessionRef, binding);
  }

  records(): readonly BridgeRecord[] {
    return this.#records;
  }

  /**
   * Appelé par la passerelle AVANT qu'elle n'écrive son état. Une erreur d'infrastructure
   * remonte (rien n'est stocké côté canal, le retry est sûr) ; un refus métier de G1 est
   * seulement consigné : la conversation reste possible, elle n'est simplement pas payable.
   */
  emit(event: ConversationEvent): void {
    const binding = this.#bindings.get(event.sessionRef);
    if (binding === undefined) {
      throw new Error("séance inconnue : aucun contrat lié à cette invitation");
    }
    // Une sauvegarde déjà attestée précède toujours le fait suivant de l'agent.
    this.sync();
    if (this.#seen.has(event.eventId)) {
      this.#record(event.eventId, "replay", "duplicate_ignored");
      return;
    }
    const track = this.#track(event.encounterId, binding);
    switch (event.type) {
      case "encounter_opened":
        this.#service.activate(binding.contractId);
        this.#record(event.eventId, "activate", "active");
        break;
      case "human_contribution_accepted":
        if (event.message !== undefined) this.#onHuman(track, event.eventId, event.message);
        break;
      case "agent_message_accepted":
        if (event.message !== undefined) this.#onAgent(track, event.eventId, event.message);
        break;
      case "encounter_closed":
      case "encounter_revoked":
      case "encounter_expired":
        this.#onEnd(track, event);
        break;
    }
    this.#seen.add(event.eventId);
  }

  /** Sauvegarde attestée par le runtime de l'agent. Idempotente. */
  attest(attestation: CheckpointAttestation): void {
    const track = this.#tracks.get(attestation.encounterId);
    const exchange = track?.byHuman.get(attestation.inReplyTo);
    const source = `checkpoint:${attestation.checkpointRef}`;
    if (track === undefined || exchange === undefined) {
      this.#record(source, "agent_checkpoint", "ignored:unknown_exchange");
      return;
    }
    const outcome = this.#ingest(source, track, {
      kind: "agent_checkpoint",
      producer: "agent_runtime",
      eventId: `g3.ck.${toRef(attestation.checkpointRef)}`,
      exchangeId: exchange.exchangeId,
      checkpointRef: toRef(attestation.checkpointRef),
    });
    if (outcome.status === "applied" || isAlreadyEarned(outcome)) {
      exchange.checkpointed = true;
      this.#tryOpen(track);
    }
  }

  #track(encounterId: string, binding: BridgeBinding): Track {
    let track = this.#tracks.get(encounterId);
    if (track === undefined) {
      track = {
        binding,
        exchanges: [],
        byPoint: new Map(),
        byHuman: new Map(),
        candidate: null,
        deferred: [],
        closed: false,
      };
      this.#tracks.set(encounterId, track);
    }
    return track;
  }

  #onAgent(track: Track, source: string, message: ConversationMessageFacts): void {
    const ref = toRef(message.messageId);
    const answered = message.inReplyTo === null ? undefined : track.byHuman.get(message.inReplyTo);
    if (answered !== undefined) {
      this.#ingest(source, track, {
        kind: "agent_reply",
        producer: "agent_runtime",
        eventId: `g3.rp.${ref}`,
        exchangeId: answered.exchangeId,
        messageId: ref,
        part: { index: 0, final: true },
        substantive: message.bodyChars >= MIN_SUBSTANTIVE_CHARS,
      });
      // Une réponse à la contribution payable porte la question suivante : elle ouvrira
      // l'échange suivant. Une réponse à une contribution non payable reste dans l'échange.
      if (answered.human === message.inReplyTo) {
        track.candidate = message.messageId;
        this.#tryOpen(track);
      }
      return;
    }
    const current = track.exchanges.at(-1);
    if (current === undefined && track.candidate === null) {
      track.candidate = message.messageId;
      this.#tryOpen(track);
    } else if (current !== undefined && current.human === null && track.candidate === null) {
      this.#ingest(source, track, {
        kind: "agent_clarification",
        producer: "agent_runtime",
        eventId: `g3.cl.${ref}`,
        exchangeId: current.exchangeId,
        messageId: ref,
      });
    } else {
      this.#ingest(source, track, {
        kind: "final_summary",
        producer: "agent_runtime",
        eventId: `g3.fs.${ref}`,
        messageId: ref,
      });
    }
  }

  #onHuman(track: Track, source: string, message: ConversationMessageFacts): void {
    const target = message.inReplyTo;
    let exchange = target === null ? undefined : track.byPoint.get(target);
    if (exchange === undefined && track.candidate !== null) {
      // Le point cité attend la sauvegarde de l'échange précédent.
      track.deferred.push(message);
      this.#record(source, "human_contribution", "deferred:point_not_open");
      return;
    }
    exchange ??= track.exchanges.at(-1);
    if (exchange === undefined) {
      this.#record(source, "human_contribution", "ignored:no_open_exchange");
      return;
    }
    this.#contribute(track, source, exchange, message);
  }

  #contribute(
    track: Track,
    source: string,
    exchange: Exchange,
    message: ConversationMessageFacts,
  ): void {
    const provenance: ContributionProvenance =
      message.authorship === "human_verbatim" ? "human_explicit" : "assistant_draft";
    const outcome = this.#ingest(source, track, {
      kind: "human_contribution",
      producer: "channel",
      eventId: `g3.hc.${toRef(message.messageId)}`,
      exchangeId: exchange.exchangeId,
      messageId: toRef(message.messageId),
      // La passerelle a authentifié le guide de cette rencontre ; la configuration
      // simulée n'en admet qu'un, celui du contrat.
      authorPrincipalId: track.binding.guidePrincipalId,
      provenance,
    });
    track.byHuman.set(message.messageId, exchange);
    if (outcome.status === "applied") exchange.human = message.messageId;
  }

  #tryOpen(track: Track): void {
    const candidate = track.candidate;
    if (candidate === null || track.closed) return;
    const previous = track.exchanges.at(-1);
    if (previous !== undefined && !previous.checkpointed) return;
    const ref = toRef(candidate);
    const exchangeId = `x.${ref}` as ExchangeId;
    const outcome = this.#ingest(`point:${candidate}`, track, {
      kind: "agent_point",
      producer: "agent_runtime",
      eventId: `g3.pt.${ref}`,
      exchangeId,
      messageId: ref,
    });
    track.candidate = null;
    if (outcome.status !== "applied") return;
    const exchange: Exchange = { exchangeId, human: null, checkpointed: false };
    track.exchanges.push(exchange);
    track.byPoint.set(candidate, exchange);
    for (const message of track.deferred.splice(0)) {
      this.#contribute(track, `deferred:${message.messageId}`, exchange, message);
    }
  }

  #onEnd(track: Track, event: ConversationEvent): void {
    track.closed = true;
    const reason = closeReasonFor(event, this.#earned(track), this.#maxExchanges(track));
    try {
      const closed = this.#service.close(track.binding.contractId, reason);
      this.#record(event.eventId, `close:${reason}`, closed.status);
    } catch (error) {
      // Contrat déjà sorti de l'état actif : la clôture du canal ne doit pas être bloquée.
      if (!(error instanceof AdviceError)) throw error;
      this.#record(event.eventId, `close:${reason}`, `refused:${error.code}`);
    }
  }

  #earned(track: Track): number {
    return this.#service
      .exchanges(track.binding.contractId)
      .filter((exchange) => exchange.state === "earned").length;
  }

  #maxExchanges(track: Track): number {
    return this.#service.status(track.binding.contractId).contract.maxExchanges;
  }

  #ingest(source: string, track: Track, event: ExchangeEventInput): IngestOutcome {
    const outcome = this.#service.ingest({ ...event, contractId: track.binding.contractId });
    this.#record(source, event.kind, describe(outcome));
    return outcome;
  }

  #record(source: string, action: string, outcome: string): void {
    const record = { source, action, outcome };
    this.#records.push(record);
    this.#onRecord?.(record);
  }
}

type ExchangeEventInput = ExchangeEvent extends infer E
  ? E extends ExchangeEvent
    ? Omit<E, "contractId">
    : never
  : never;

function isAlreadyEarned(outcome: IngestOutcome): boolean {
  return (
    (outcome.status === "not_payable" && outcome.reason === "already_earned") ||
    (outcome.status === "duplicate" && outcome.original.status === "applied")
  );
}

export function describe(outcome: IngestOutcome): string {
  switch (outcome.status) {
    case "applied":
      return `applied:${outcome.effect}`;
    case "duplicate":
      return `duplicate(${describe(outcome.original)})`;
    default:
      return `${outcome.status}:${outcome.reason}`;
  }
}

function closeReasonFor(event: ConversationEvent, earned: number, max: number): CloseReason {
  if (event.type === "encounter_expired") return "inactivity_expired";
  if (event.type === "encounter_revoked") return "channel_change";
  const reason: EncounterCloseReason | undefined = event.reason;
  switch (reason) {
    case "guide_stopped":
      return "guide_stop";
    case "agent_stopped":
      return "agent_stop";
    case "switch_agent":
      return "channel_change";
    case "completed":
    case undefined:
      if (earned >= max) return "limit_reached";
      return event.closedBy === "guide" ? "guide_stop" : "agent_stop";
  }
}
