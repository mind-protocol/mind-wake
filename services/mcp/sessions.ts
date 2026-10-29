/**
 * Séances de conseil SIMULÉES ouvertes par la mise en relation. Ne compte rien et ne
 * règle rien lui-même : le canal est celui de G2 (`ConversationService`, en processus),
 * le comptage et le règlement fictif ceux de G1 (`AdviceSessionService`), reliés par
 * l'adaptateur existant de G3 (`SessionLedgerBridge`).
 *
 * Le hub joue les deux connexions du canal (guide et guest) pour le compte des parties
 * authentifiées ; les capacités et clés de liaison restent dans ce processus. Une séance
 * ne s'ouvre qu'après l'acceptation explicite du guide (`open` n'est appelé que depuis
 * `respond_invitation`), et G1 vérifie de nouveau que l'acceptant est le guide du contrat.
 *
 * Unités fictives uniquement : aucun wallet, aucun argent, aucun réseau.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { digest, opaque } from "../advice/conversation/capability.js";
import type { Authorship, DeliveredMessage } from "../advice/conversation/protocol.js";
import {
  ConversationError,
  ConversationService,
  type Principal,
} from "../advice/conversation/service.js";
import { SessionLedgerBridge, type CheckpointAttestation } from "../advice/demo/bridge.js";
import {
  AdviceError,
  AdviceSessionService,
  buildMandate,
  formatAmount,
  multiplyAmount,
  openAdviceDatabase,
  parseAmount,
  SIMULATION_LABEL,
  SimulatedSettlementRail,
  type AdviceDatabase,
  type ContractId,
  type MandateId,
  type PoolId,
  type PrincipalId,
  type Receipt,
  type UtcTimestamp,
} from "../advice/session/index.js";
import { HubError, type HelpStatus } from "./protocol.js";

const HOUR = 3_600_000;
/** Bornes fixes du mandat : un redémarrage du hub doit retrouver le même mandat. */
const MANDATE_VALID_FROM = "2026-01-01T00:00:00.000Z" as UtcTimestamp;
const MANDATE_EXPIRES_AT = "2027-12-31T23:59:59.000Z" as UtcTimestamp;

export interface FundedAgent {
  readonly ref: string;
  readonly privateId: string;
  readonly funding: string;
  readonly unitPrice: string;
  readonly maxExchanges: number;
}

export interface OpenInput {
  readonly sessionId: string;
  readonly topic: string;
  readonly maxExchanges: number;
  readonly agent: FundedAgent;
  readonly guide: { readonly ref: string; readonly privateId: string; readonly terms: string };
}

type Role = "agent" | "guide";

interface Live {
  readonly sessionId: string;
  readonly contractId: ContractId;
  readonly agentRef: string;
  readonly guideRef: string;
  readonly conversation: ConversationService;
  readonly bridge: SessionLedgerBridge;
  readonly encounterId: string;
  readonly guide: { readonly principal: Principal; readonly capability: string };
  readonly agent: { readonly principal: Principal; readonly capability: string };
  readonly pendingCheckpoints: CheckpointAttestation[];
  settled: boolean;
}

export interface SessionView {
  readonly sessionId: string;
  readonly label: typeof SIMULATION_LABEL;
  readonly you: Role;
  readonly channelState: string;
  readonly contractState: string;
  readonly maxExchanges: number;
  readonly unitPrice: string;
  readonly earnedExchanges: number;
  readonly settlement: "not_closed" | "pending" | "settled";
  readonly receipt: Receipt | null;
}

export class AdviceSessions {
  readonly #db: AdviceDatabase;
  readonly #rail: SimulatedSettlementRail;
  readonly service: AdviceSessionService;
  readonly #closeGraceMs: number;
  readonly #live = new Map<string, Live>();

  constructor(dir: string, agents: readonly FundedAgent[], closeGraceMs: number) {
    this.#db = openAdviceDatabase(join(dir, "advice-simulated.sqlite"));
    this.#rail = new SimulatedSettlementRail(join(dir, "rail-simulated.sqlite"));
    this.service = new AdviceSessionService({ db: this.#db, rail: this.#rail });
    this.#closeGraceMs = closeGraceMs;
    for (const agent of agents) {
      const payer = `owner-${agent.ref}` as PrincipalId;
      const pool = poolOf(agent.ref);
      this.service.createPool(pool, payer);
      this.service.fundPool(pool, agent.funding, `fund-${agent.ref}-${agent.funding}`);
      this.service.registerMandate(
        buildMandate({
          mandateId: mandateOf(agent.ref),
          version: 1,
          payerPrincipalId: payer,
          agentId: agent.ref,
          poolId: pool,
          guideRule: { kind: "any_guide_with_terms" },
          perExchangeCap: agent.unitPrice,
          perSessionCap: multiplyAmount(parseAmount(agent.unitPrice), agent.maxExchanges),
          perPeriodCap: agent.funding,
          periodMs: 24 * HOUR,
          maxOpenReservations: 1,
          validFrom: MANDATE_VALID_FROM,
          expiresAt: MANDATE_EXPIRES_AT,
        }),
      );
    }
  }

  busy(ref: string): boolean {
    for (const live of this.#live.values()) {
      if (!live.settled && (live.agentRef === ref || live.guideRef === ref)) return true;
    }
    return false;
  }

  /**
   * Ouvre la séance après acceptation du guide : offre, acceptation G1 par le guide,
   * réservation fictive, rencontre G2 ouverte et guest rattaché. En cas d'échec, rien
   * ne reste réservé.
   */
  open(input: OpenInput): { readonly contractId: ContractId } {
    const contractId = `ses-${randomBytes(9).toString("hex")}` as ContractId;
    const guidePrincipal = input.guide.ref as PrincipalId;
    const maxExchanges = Math.min(input.maxExchanges, input.agent.maxExchanges);
    try {
      this.service.offer(
        `req-${contractId}`,
        {
          contractId,
          agentId: input.agent.ref,
          guidePrincipalId: guidePrincipal,
          recipientBindingVersion: "binding-1",
          guideTermsVersion: input.guide.terms,
          topic: input.topic,
          contextVersion: "ctx-1",
          unitPrice: input.agent.unitPrice,
          maxExchanges,
          activationDeadline: new Date(Date.now() + HOUR).toISOString() as UtcTimestamp,
          inactivityTimeoutMs: 30 * 60_000,
          closeGraceMs: this.#closeGraceMs,
        },
        { mandateId: mandateOf(input.agent.ref), version: 1 },
      );
      this.service.accept(contractId, guidePrincipal, input.guide.terms);
      this.service.reserve(contractId);
    } catch (error) {
      if (error instanceof AdviceError) {
        this.#cancelQuietly(contractId);
        throw new HubError("session_unavailable", `Séance impossible : ${error.code}.`);
      }
      throw error;
    }

    const guideKey = randomBytes(24).toString("base64url");
    const guestKey = randomBytes(24).toString("base64url");
    const invitation = opaque("inv");
    const pending: CheckpointAttestation[] = [];
    const bridge = new SessionLedgerBridge(this.service, {
      pullCheckpoints: () => pending.splice(0),
    });
    bridge.bind(contractId, { contractId, guidePrincipalId: guidePrincipal });
    const conversation = new ConversationService(
      {
        guides: [{ privateId: input.guide.privateId, keyDigest: digest(guideKey) }],
        invitations: [
          {
            invitation,
            sessionRef: contractId,
            topic: input.topic,
            ownerPrivateId: input.agent.privateId,
            guestKeyDigest: digest(guestKey),
          },
        ],
        operatorKeyDigest: digest(randomBytes(24).toString("base64url")),
        encounterTtlMs: 30 * 60_000,
        retainTranscriptAfterClose: false,
      },
      bridge,
    );
    const guide = conversation.authenticate("guide", guideKey);
    const opened = conversation.open(guide, invitation, `open-${input.sessionId}`);
    const guest = conversation.authenticate("guest", guestKey, invitation);
    const attached = conversation.attachGuest(guest);
    this.#live.set(input.sessionId, {
      sessionId: input.sessionId,
      contractId,
      agentRef: input.agent.ref,
      guideRef: input.guide.ref,
      conversation,
      bridge,
      encounterId: opened.encounterId,
      guide: { principal: guide, capability: opened.capability },
      agent: { principal: guest, capability: attached.capability },
      pendingCheckpoints: pending,
      settled: false,
    });
    return { contractId };
  }

  send(
    sessionId: string,
    role: Role,
    input: {
      readonly text: string;
      readonly idempotencyKey: string;
      readonly inReplyTo?: string | undefined;
      readonly authorship?: Authorship | undefined;
    },
  ): { messageId: string; sequence: number; duplicate: boolean } {
    const live = this.#get(sessionId);
    if (role === "guide" && input.authorship === undefined) {
      throw new HubError("bad_request", "Le guide déclare la rédaction (authorship).");
    }
    if (role === "agent" && input.authorship !== undefined) {
      throw new HubError("bad_request", "Un message d'agent ne peut se déclarer humain.");
    }
    const party = live[role];
    return channel(() =>
      live.conversation.send(party.principal, {
        encounterId: live.encounterId,
        capability: party.capability,
        idempotencyKey: input.idempotencyKey,
        text: input.text,
        inReplyTo: input.inReplyTo,
        authorship: input.authorship,
      }),
    );
  }

  async receive(
    sessionId: string,
    role: Role,
    after: number,
    waitSeconds: number,
  ): Promise<{ state: string; next: number; messages: readonly DeliveredMessage[] }> {
    const live = this.#get(sessionId);
    const party = live[role];
    await live.conversation.waitFor(live.encounterId, after, waitSeconds * 1000);
    return channel(() =>
      live.conversation.receive(party.principal, {
        encounterId: live.encounterId,
        capability: party.capability,
        after,
        limit: 50,
      }),
    );
  }

  /** Sauvegarde attestée par l'agent après sa réponse : rend l'échange acquis (G1). */
  checkpoint(sessionId: string, inReplyTo: string, checkpointRef: string): void {
    const live = this.#get(sessionId);
    live.pendingCheckpoints.push({ encounterId: live.encounterId, inReplyTo, checkpointRef });
    live.bridge.sync();
  }

  close(sessionId: string, role: Role, reason: "completed" | "stopped"): void {
    const live = this.#get(sessionId);
    const party = live[role];
    channel(() =>
      live.conversation.close(party.principal, {
        encounterId: live.encounterId,
        capability: party.capability,
        idempotencyKey: `close-${role}-${sessionId}`,
        reason:
          reason === "completed"
            ? "completed"
            : role === "guide"
              ? "guide_stopped"
              : "agent_stopped",
      }),
    );
  }

  /**
   * Après clôture, validation sous mandat puis règlement SIMULÉ des seuls échanges
   * acquis. Déclenché par la fin de la rencontre, jamais par le contenu d'un message.
   */
  async view(sessionId: string, role: Role): Promise<SessionView> {
    const live = this.#get(sessionId);
    live.bridge.sync();
    let channelState: string;
    try {
      channelState = live.conversation.status(live[role].principal, {
        encounterId: live.encounterId,
        capability: live[role].capability,
      }).state;
    } catch (error) {
      // Le canal refuse toute opération après la fin ; l'état terminal reste lisible ici.
      if (!(error instanceof ConversationError) || error.state === undefined) throw error;
      channelState = error.state;
    }
    let status = this.service.status(live.contractId);
    if (status.closeReason !== null && !live.settled) {
      try {
        const approved = this.service.approve(live.contractId);
        if (approved.principalDue > 0n) {
          this.service.prepareSettlement(live.contractId);
          for (let i = 0; i < 10; i += 1) {
            const report = await this.service.runWorker(`hub-${sessionId}`);
            if (report.handled.length === 0) break;
          }
        }
        const final = this.service.receipt(live.contractId).status;
        live.settled = final === "settled_simulated" || final === "none_due_simulated";
      } catch (error) {
        if (!(error instanceof AdviceError && error.code === "grace_pending")) throw error;
      }
      status = this.service.status(live.contractId);
    }
    const earned = this.service
      .exchanges(live.contractId)
      .filter((exchange) => exchange.state === "earned").length;
    return {
      sessionId,
      label: SIMULATION_LABEL,
      you: role,
      channelState,
      contractState: status.state,
      maxExchanges: status.contract.maxExchanges,
      unitPrice: formatAmount(status.contract.unitPrice),
      earnedExchanges: earned,
      settlement: status.closeReason === null ? "not_closed" : live.settled ? "settled" : "pending",
      receipt: status.closeReason === null ? null : this.service.receipt(live.contractId),
    };
  }

  /** Statut final de la demande d'aide une fois la rencontre terminée. */
  requestStatusAfter(sessionId: string): HelpStatus {
    const live = this.#get(sessionId);
    return this.service.status(live.contractId).closeReason === null ? "taken" : "closed";
  }

  shutdown(): void {
    this.#db.close();
    this.#rail.close();
  }

  #get(sessionId: string): Live {
    const live = this.#live.get(sessionId);
    if (live === undefined) {
      throw new HubError(
        "session_unavailable",
        "Séance inconnue de ce hub (fermée, ou perdue au redémarrage du hub).",
      );
    }
    return live;
  }

  #cancelQuietly(contractId: ContractId): void {
    try {
      this.service.cancel(contractId, "session_open_failed");
    } catch {
      // Contrat jamais créé ou déjà terminal : rien à libérer.
    }
  }
}

function poolOf(ref: string): PoolId {
  return `pool-${ref}` as PoolId;
}

function mandateOf(ref: string): MandateId {
  return `mandate-${ref}` as MandateId;
}

/** Traduit les refus du canal en erreurs du hub, sans détail interne. */
function channel<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ConversationError) {
      const code =
        error.code === "sensitive_content_refused" ||
        error.code === "private_identifier_refused" ||
        error.code === "empty_message" ||
        error.code === "idempotency_conflict" ||
        error.code === "unknown_reference" ||
        error.code === "limit_reached"
          ? error.code
          : error.code === "bad_request"
            ? "bad_request"
            : "invalid_state";
      throw new HubError(code, error.message, error.retryable);
    }
    throw error;
  }
}
