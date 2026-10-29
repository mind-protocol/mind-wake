/**
 * Démo SIMULÉE de bout en bout du conseil guest distant (SPEC §17, piste G3).
 *
 * « Faisons une session de conseil MIND » → matching factice → contrat → réservation
 * fictive → réveil de l'agent chez lui → première question → au plus N échanges → clôture
 * → règlement simulé des seuls échanges accomplis → reçu marqué SIMULÉ.
 *
 * Trois rôles, trois sortes de processus :
 * - le service MIND simulé (ce processus) : séances G1, passerelle G2, adaptateur ;
 * - le guide : son client MCP ici, l'adaptateur MCP `mcp-server.ts` dans son processus ;
 * - l'agent guest : `fake-guest.ts` dans son propre processus et son dossier privé.
 *
 * Aucun argent, wallet, réseau public, bot ni publication : pipe nommé local et fichiers
 * SQLite temporaires seulement.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { digest, opaque } from "../conversation/capability.js";
import { localPipePath } from "../conversation/framing.js";
import { startGateway, type Gateway } from "../conversation/gateway.js";
import type { Authorship } from "../conversation/protocol.js";
import { ConversationService, type GatewayConfig } from "../conversation/service.js";
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
  type ContractStatus,
  type MandateId,
  type PrincipalId,
  type Receipt,
  type SimulatedRailFaults,
  type UtcTimestamp,
} from "../session/index.js";
import { AgentHost, type AwakeGuest, type WakeOptions } from "./agent-host.js";
import { SessionLedgerBridge, type BridgeRecord } from "./bridge.js";
import { matchGuest, type GuestListing, type MatchRequest, type Rejection } from "./matching.js";
import { CONVERSATION_DIR, NODE_ARGS, until } from "./runtime.js";

export const DEMO_SENTENCE = "Faisons une session de conseil MIND";
export const GUIDE_PRINCIPAL = "guide-demo" as PrincipalId;
const GUIDE_PRIVATE_ID = "guide.demo@example.invalid";
const GUIDE_TERMS = "guide-terms-1";
const HOUR = 3_600_000;

export type DemoLineKind = "step" | "money" | "agent" | "guide" | "service" | "warn";

export interface DemoLine {
  readonly kind: DemoLineKind;
  readonly text: string;
}

export interface DemoOptions {
  readonly dir: string;
  readonly catalog: readonly GuestListing[];
  readonly log?: (line: DemoLine) => void;
  readonly closeGraceMs?: number;
  readonly railFaults?: SimulatedRailFaults;
  /** Trace chaque traduction de l'adaptateur (diagnostic). */
  readonly onBridgeRecord?: (record: BridgeRecord) => void;
}

/** Ce que le guide voit d'un message, tel que l'adaptateur MCP le lui présente. */
export interface GuideMessage {
  readonly messageId: string;
  readonly provenance: "human" | "agent" | "technical";
  readonly author: string;
  readonly text: string;
  readonly trust: string;
  readonly inReplyTo?: string;
}

export type StartResult =
  | { readonly status: "started"; readonly session: DemoSession }
  | { readonly status: "not_understood" }
  | { readonly status: "no_candidate"; readonly rejected: readonly Rejection[] }
  | { readonly status: "wake_failed"; readonly contractId: ContractId; readonly receipt: Receipt };

export interface StartOptions {
  readonly request?: MatchRequest;
  readonly guest?: Omit<WakeOptions, "pipe" | "invitation" | "linkKey">;
  readonly wakeTimeoutMs?: number;
}

/** Service MIND simulé : séances G1, fonds fictifs, catalogue d'agents. */
export class AdviceDemo {
  readonly dir: string;
  readonly db: AdviceDatabase;
  readonly rail: SimulatedSettlementRail;
  readonly service: AdviceSessionService;
  readonly catalog: readonly GuestListing[];
  readonly #log: (line: DemoLine) => void;
  readonly #closeGraceMs: number;
  readonly #onBridgeRecord: ((record: BridgeRecord) => void) | undefined;
  readonly #busy = new Set<string>();
  readonly #sessions = new Set<DemoSession>();
  #skew = 0;
  #count = 0;

  constructor(options: DemoOptions) {
    this.dir = options.dir;
    this.catalog = options.catalog;
    this.#log = options.log ?? (() => undefined);
    this.#closeGraceMs = options.closeGraceMs ?? 60_000;
    this.#onBridgeRecord = options.onBridgeRecord;
    const now = (): number => Date.now() + this.#skew;
    mkdirSync(options.dir, { recursive: true });
    this.db = openAdviceDatabase(join(options.dir, "advice-simulated.sqlite"));
    this.rail = new SimulatedSettlementRail(join(options.dir, "rail-simulated.sqlite"), {
      now,
      ...(options.railFaults === undefined ? {} : { faults: options.railFaults }),
    });
    this.service = new AdviceSessionService({ db: this.db, rail: this.rail, now });
    const start = new Date(now() - HOUR).toISOString() as UtcTimestamp;
    const end = new Date(now() + 30 * 24 * HOUR).toISOString() as UtcTimestamp;
    for (const listing of options.catalog) {
      const payer = `owner-${listing.agentId}` as PrincipalId;
      this.service.createPool(listing.poolId, payer);
      this.service.fundPool(listing.poolId, listing.fictiveFunding, `fund:${listing.poolId}`);
      this.service.registerMandate(
        buildMandate({
          mandateId: `mandate-${listing.agentId}`,
          version: 1,
          payerPrincipalId: payer,
          agentId: listing.agentId,
          poolId: listing.poolId,
          guideRule: { kind: "any_guide_with_terms" },
          perExchangeCap: listing.unitPrice,
          perSessionCap: multiplyAmount(parseAmount(listing.unitPrice), listing.maxExchanges),
          perPeriodCap: listing.fictiveFunding,
          periodMs: 24 * HOUR,
          maxOpenReservations: 1,
          validFrom: start,
          expiresAt: end,
        }),
      );
    }
  }

  log(kind: DemoLineKind, text: string): void {
    this.#log({ kind, text });
  }

  /** Avance l'horloge du service de séances (délai de grâce, expirations). */
  advanceClock(ms: number): void {
    this.#skew += ms;
  }

  /**
   * Point d'entrée en une phrase : matching, contrat, réservation, réveil, ouverture.
   * Retourne la séance avec la première question déjà affichée côté guide.
   */
  async start(sentence: string, options: StartOptions = {}): Promise<StartResult> {
    if (!/session de conseil mind/i.test(sentence)) return { status: "not_understood" };
    this.log("guide", `« ${sentence} »`);
    const request = options.request ?? { language: "fr" };
    const match = matchGuest(this.catalog, request, {
      available: (pool) => this.service.poolBalances(pool).available,
      busy: (agentId) => this.#busy.has(agentId),
    });
    for (const r of match.rejected)
      this.log("service", `matching : ${r.agentId} écarté (${r.reason})`);
    if (match.status === "no_candidate") {
      this.log(
        "step",
        "Aucun agent disponible : aucune séance lancée, rien de réservé ni facturé.",
      );
      return match;
    }
    const { listing } = match;
    this.log(
      "service",
      `matching : ${listing.agentId} retenu (question prête, budget fictif réservable)`,
    );

    this.#count += 1;
    const contractId = `sim-${listing.agentId}-${String(this.#count)}` as ContractId;
    const contract = this.service.offer(
      `req-${contractId}`,
      {
        contractId,
        agentId: listing.agentId,
        guidePrincipalId: GUIDE_PRINCIPAL,
        recipientBindingVersion: "binding-1",
        guideTermsVersion: GUIDE_TERMS,
        topic: listing.topic,
        contextVersion: "ctx-1",
        unitPrice: listing.unitPrice,
        maxExchanges: listing.maxExchanges,
        activationDeadline: new Date(Date.now() + this.#skew + HOUR).toISOString() as UtcTimestamp,
        inactivityTimeoutMs: 30 * 60_000,
        closeGraceMs: this.#closeGraceMs,
      },
      { mandateId: `mandate-${listing.agentId}` as MandateId, version: 1 },
    );
    this.service.accept(contractId, GUIDE_PRINCIPAL, GUIDE_TERMS);
    this.log(
      "money",
      `Contrat ${contractId} : ${String(contract.maxExchanges)} échanges max × ${formatAmount(contract.unitPrice)} unités fictives = ${formatAmount(contract.maxPrincipal)} au plus.`,
    );
    this.service.reserve(contractId);
    this.log(
      "money",
      `Réservation fictive de ${formatAmount(contract.maxPrincipal)} unités (verrou interne, pas un escrow).`,
    );
    this.#busy.add(listing.agentId);

    const session = await DemoSession.open(this, listing, contractId, {
      closeGraceMs: this.#closeGraceMs,
      onBridgeRecord: this.#onBridgeRecord,
      guest: options.guest ?? {},
      wakeTimeoutMs: options.wakeTimeoutMs ?? 10_000,
    });
    if (session === null) {
      this.service.cancel(contractId, "wake_failed");
      this.#busy.delete(listing.agentId);
      this.log("warn", "Réveil de l'agent impossible : séance annulée avant tout échange.");
      this.log("money", "Réservation fictive libérée en totalité ; aucun échange facturé.");
      return { status: "wake_failed", contractId, receipt: this.service.receipt(contractId) };
    }
    this.#sessions.add(session);
    return { status: "started", session };
  }

  release(agentId: string, session: DemoSession): void {
    this.#busy.delete(agentId);
    this.#sessions.delete(session);
  }

  async close(): Promise<void> {
    for (const session of [...this.#sessions]) await session.dispose();
    this.db.close();
    this.rail.close();
  }
}

/** Service de conversation dont le service MIND observe le rattachement du guest. */
class ObservedConversationService extends ConversationService {
  #attached: () => void = () => undefined;
  readonly attached = new Promise<void>((resolve) => {
    this.#attached = resolve;
  });

  override attachGuest(
    principal: Parameters<ConversationService["attachGuest"]>[0],
  ): ReturnType<ConversationService["attachGuest"]> {
    const result = super.attachGuest(principal);
    this.#attached();
    return result;
  }
}

interface SessionWiring {
  readonly closeGraceMs: number;
  readonly onBridgeRecord: ((record: BridgeRecord) => void) | undefined;
  readonly guest: Omit<WakeOptions, "pipe" | "invitation" | "linkKey">;
  readonly wakeTimeoutMs: number;
}

export interface SettleResult {
  readonly status: "settled" | "grace_pending";
  readonly receipt: Receipt;
  readonly contract: ContractStatus;
}

/** Une rencontre en cours : passerelle, agent réveillé chez lui, adaptateur MCP du guide. */
export class DemoSession {
  readonly demo: AdviceDemo;
  readonly listing: GuestListing;
  readonly contractId: ContractId;
  readonly host: AgentHost;
  readonly bridge: SessionLedgerBridge;
  readonly encounterId: string;
  readonly agentPseudonym: string;
  /** Tous les messages vus par le guide, dans l'ordre. */
  readonly transcript: GuideMessage[] = [];
  /** Sorties brutes des outils MCP du guide (contrôle de confidentialité). */
  readonly guideOutputs: string[] = [];
  readonly #gateway: Gateway;
  readonly #client: Client;
  readonly #invitation: string;
  readonly #guestKey: string;
  readonly #pipe: string;
  readonly #wiring: SessionWiring;
  #guest: AwakeGuest;
  #disposed = false;
  readonly #read = new Set<string>();

  private constructor(fields: {
    demo: AdviceDemo;
    listing: GuestListing;
    contractId: ContractId;
    host: AgentHost;
    bridge: SessionLedgerBridge;
    gateway: Gateway;
    client: Client;
    guest: AwakeGuest;
    invitation: string;
    guestKey: string;
    pipe: string;
    wiring: SessionWiring;
    encounterId: string;
    agentPseudonym: string;
  }) {
    this.demo = fields.demo;
    this.listing = fields.listing;
    this.contractId = fields.contractId;
    this.host = fields.host;
    this.bridge = fields.bridge;
    this.#gateway = fields.gateway;
    this.#client = fields.client;
    this.#guest = fields.guest;
    this.#invitation = fields.invitation;
    this.#guestKey = fields.guestKey;
    this.#pipe = fields.pipe;
    this.#wiring = fields.wiring;
    this.encounterId = fields.encounterId;
    this.agentPseudonym = fields.agentPseudonym;
  }

  static async open(
    demo: AdviceDemo,
    listing: GuestListing,
    contractId: ContractId,
    wiring: SessionWiring,
  ): Promise<DemoSession | null> {
    const key = (): string => randomBytes(24).toString("base64url");
    const guideKey = key();
    const guestKey = key();
    const invitation = opaque("inv");
    const pipe = localPipePath("mind-advice-demo");
    const host = new AgentHost(join(demo.dir, `agent-${listing.agentId}`), listing.persona);
    const bridge = new SessionLedgerBridge(demo.service, {
      pullCheckpoints: () => host.pullCheckpoints(),
      ...(wiring.onBridgeRecord === undefined ? {} : { onRecord: wiring.onBridgeRecord }),
    });
    bridge.bind(contractId, { contractId, guidePrincipalId: GUIDE_PRINCIPAL });
    const config: GatewayConfig = {
      guides: [{ privateId: GUIDE_PRIVATE_ID, keyDigest: digest(guideKey) }],
      invitations: [
        {
          invitation,
          sessionRef: contractId,
          topic: listing.topic,
          ownerPrivateId: `owner.${listing.agentId}@example.invalid`,
          guestKeyDigest: digest(guestKey),
        },
      ],
      operatorKeyDigest: digest(key()),
      encounterTtlMs: 30 * 60_000,
      retainTranscriptAfterClose: false,
    };
    const conversation = new ObservedConversationService(config, bridge);
    const gateway = await startGateway(conversation, pipe);

    // Réveil par le serveur d'origine de l'agent, chez lui.
    demo.log(
      "step",
      `Réveil de l'agent ${listing.agentId} dans son propre processus (côté agent).`,
    );
    const guest = host.wake({
      ...wiring.guest,
      ...(listing.wakeFails === true ? { failWake: true } : {}),
      pipe,
      invitation,
      linkKey: guestKey,
    });
    const woke = await Promise.race([
      conversation.attached.then(() => "attached" as const),
      guest.exited.then(() => "exited" as const),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => {
          resolve("timeout");
        }, wiring.wakeTimeoutMs).unref(),
      ),
    ]);
    if (woke !== "attached") {
      await guest.kill();
      await gateway.close();
      return null;
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...NODE_ARGS, join(CONVERSATION_DIR, "mcp-server.ts")],
      env: { MIND_ADVICE_PIPE: pipe, MIND_ADVICE_LINK_KEY: guideKey },
      stderr: "pipe",
    });
    const client = new Client({ name: "guide-session-demo", version: "0.0.0" });
    await client.connect(transport);
    const opened = await callTool(client, "open_encounter", { invitation_ref: invitation });
    const encounterId = String(opened.data["encounter_id"]);
    const agentPseudonym = String(opened.data["agent"]);
    const session = new DemoSession({
      demo,
      listing,
      contractId,
      host,
      bridge,
      gateway,
      client,
      guest,
      invitation,
      guestKey,
      pipe,
      wiring,
      encounterId,
      agentPseudonym,
    });
    session.guideOutputs.push(opened.raw);
    const contract = demo.service.status(contractId).contract;
    demo.log(
      "money",
      `Cadrage : agent ${agentPseudonym} · sujet « ${listing.topic} » · jusqu'à ${String(contract.maxExchanges)} échanges · ${formatAmount(contract.unitPrice)} unités fictives par échange accompli.`,
    );
    const first = await session.nextAgentMessage();
    demo.log("agent", `${first.author} [${first.trust}] : ${first.text}`);
    return session;
  }

  /** Échanges acquis selon G1 (après application des sauvegardes attestées). */
  earned(): number {
    this.bridge.sync();
    return this.demo.service
      .exchanges(this.contractId)
      .filter((exchange) => exchange.state === "earned").length;
  }

  async awaitEarned(count: number): Promise<void> {
    await until(() => (this.earned() >= count ? true : undefined), "sauvegarde attestée");
  }

  lastAgentMessage(): GuideMessage | undefined {
    return this.transcript.filter((m) => m.provenance === "agent").at(-1);
  }

  /** Récupère explicitement les nouveaux messages (pas de notification spontanée). */
  async receive(waitSeconds = 1): Promise<{ state: string; messages: GuideMessage[] }> {
    const result = await this.#call("receive_messages", {
      encounter_id: this.encounterId,
      wait_seconds: waitSeconds,
    });
    const messages = (result.data["messages"] ?? []) as GuideMessage[];
    this.transcript.push(...messages);
    return { state: String(result.data["state"]), messages };
  }

  /** Premier message d'agent pas encore lu qui satisfait `accept`. */
  async nextAgentMessage(
    accept: (message: GuideMessage) => boolean = () => true,
  ): Promise<GuideMessage> {
    const unread = (): GuideMessage | undefined =>
      this.transcript.find(
        (m) => m.provenance === "agent" && !this.#read.has(m.messageId) && accept(m),
      );
    const message = await until(
      async () => unread() ?? (await this.receive(), unread()),
      "message de l'agent",
    );
    this.#read.add(message.messageId);
    return message;
  }

  async contribute(
    text: string,
    options: { authorship?: Authorship; idempotencyKey?: string; inReplyTo?: string } = {},
  ): Promise<{ messageId: string; duplicate: boolean }> {
    const target = options.inReplyTo ?? this.lastAgentMessage()?.messageId;
    const sent = await this.#call("send_contribution", {
      encounter_id: this.encounterId,
      text,
      authorship: options.authorship ?? "human_verbatim",
      idempotency_key: options.idempotencyKey ?? `guide-${opaque("k", 9)}`,
      ...(target === undefined ? {} : { in_reply_to: target }),
    });
    if (sent.isError) throw new Error(`contribution refusée : ${sent.raw}`);
    return {
      messageId: String(sent.data["message_id"]),
      duplicate: sent.data["duplicate"] === true,
    };
  }

  /** Un échange complet du point de vue du guide : contribution, réponse, sauvegarde. */
  async exchange(text: string): Promise<GuideMessage> {
    const before = this.earned();
    this.demo.log("guide", text);
    const { messageId } = await this.contribute(text);
    const reply = await this.nextAgentMessage((m) => m.inReplyTo === messageId);
    this.demo.log("agent", `${reply.author} [${reply.trust}] : ${reply.text}`);
    await this.awaitEarned(before + 1);
    const contract = this.demo.service.status(this.contractId).contract;
    const earned = this.earned();
    this.demo.log(
      "money",
      `${String(earned)}/${String(contract.maxExchanges)} échanges · acquis : ${formatAmount(contract.unitPrice * BigInt(earned))} unités fictives (non réglé).`,
    );
    return reply;
  }

  async requestClose(reason: "guide_stopped" | "switch_agent" = "guide_stopped"): Promise<void> {
    const result = await this.#call("request_close", { encounter_id: this.encounterId, reason });
    if (result.isError) throw new Error(`clôture refusée : ${result.raw}`);
  }

  /** Attend que la fin de la rencontre ait clôturé le contrat. */
  async awaitClosed(): Promise<ContractStatus> {
    return until(() => {
      this.bridge.sync();
      const status = this.demo.service.status(this.contractId);
      return status.closeReason === null ? undefined : status;
    }, "clôture du contrat");
  }

  async crashGuest(): Promise<void> {
    await this.#guest.kill();
  }

  /** Redémarre l'agent chez lui : il reprend depuis sa mémoire privée. */
  restartGuest(): void {
    this.#guest = this.host.wake({
      ...this.#wiring.guest,
      pipe: this.#pipe,
      invitation: this.#invitation,
      linkKey: this.#guestKey,
    });
  }

  guest(): AwakeGuest {
    return this.#guest;
  }

  /**
   * Validation sous mandat, préparation et exécution du règlement SIMULÉ des seuls
   * échanges acquis, puis reçu. Une unité admise en attente pendant la grâce est signalée.
   */
  async settle(): Promise<SettleResult> {
    const { service } = this.demo;
    this.bridge.sync();
    try {
      const approved = service.approve(this.contractId);
      this.demo.log(
        "money",
        `Compteur figé : ${String(approved.earnedExchanges)} échange(s), dû ${formatAmount(approved.principalDue)} unités fictives ; excédent de réservation libéré.`,
      );
    } catch (error) {
      if (error instanceof AdviceError && error.code === "grace_pending") {
        this.demo.log("warn", "Une unité admise attend encore sa réponse : règlement différé.");
        return {
          status: "grace_pending",
          receipt: service.receipt(this.contractId),
          contract: service.status(this.contractId),
        };
      }
      throw error;
    }
    service.prepareSettlement(this.contractId);
    for (let i = 0; i < 10; i += 1) {
      const report = await service.runWorker("demo-worker");
      if (report.handled.length === 0) break;
    }
    const receipt = service.receipt(this.contractId);
    this.demo.log("money", `Règlement simulé : ${receipt.status} (${SIMULATION_LABEL}).`);
    return { status: "settled", receipt, contract: service.status(this.contractId) };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#client.close().catch(() => undefined);
    await this.host.stop();
    await this.#gateway.close();
    this.demo.release(this.listing.agentId, this);
  }

  async #call(name: string, args: Record<string, unknown>) {
    const result = await callTool(this.#client, name, args);
    this.guideOutputs.push(result.raw);
    return result;
  }
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ data: Record<string, unknown>; isError: boolean; raw: string }> {
  const result = await client.callTool({ name, arguments: args });
  const first = (result.content as { type: string; text?: string }[])[0];
  const raw = first?.text ?? "";
  return {
    data: JSON.parse(raw) as Record<string, unknown>,
    isError: result.isError === true,
    raw,
  };
}
