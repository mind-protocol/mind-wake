/**
 * Adaptateur canal G2 → séances G1, en processus unique : traduction des faits de
 * conversation, comptage au plus une fois (H03), limite du bloc (H04), clôtures.
 */

import { afterEach, describe, expect, it } from "vitest";
import { digest, opaque } from "../../../services/advice/conversation/capability.js";
import type { ConversationEvent } from "../../../services/advice/conversation/events.js";
import {
  ConversationService,
  type GatewayConfig,
  type Principal,
} from "../../../services/advice/conversation/service.js";
import { SessionLedgerBridge, toRef } from "../../../services/advice/demo/bridge.js";
import {
  drain,
  GUIDE,
  harness,
  MANDATE,
  offerFor,
  TERMS,
  type Harness,
} from "../session/support.js";

const GUIDE_KEY = "guide-key-0123456789abcdef";
const GUEST_KEY = "guest-key-0123456789abcdef";
const LONG = "A substantive answer that discusses the proposed test in some detail.";

let h: Harness | undefined;
afterEach(() => {
  h?.close();
  h?.dir.remove();
  h = undefined;
});

function setup(contract = "c-bridge", sessionRef: string = contract) {
  h = harness();
  const { service } = h;
  const offered = service.offer(`req-${contract}`, offerFor(contract), {
    mandateId: MANDATE,
    version: 1,
  });
  service.accept(offered.contractId, GUIDE, TERMS);
  service.reserve(offered.contractId);
  const contractId = offered.contractId;

  const events: ConversationEvent[] = [];
  const bridge = new SessionLedgerBridge(service);
  bridge.bind(contract, { contractId, guidePrincipalId: GUIDE });
  const invitation = opaque("inv");
  const config: GatewayConfig = {
    guides: [{ privateId: "guide@example.invalid", keyDigest: digest(GUIDE_KEY) }],
    invitations: [
      {
        invitation,
        sessionRef,
        topic: "unit",
        ownerPrivateId: "owner@example.invalid",
        guestKeyDigest: digest(GUEST_KEY),
      },
    ],
    operatorKeyDigest: digest("operator-key-0123456789ab"),
    encounterTtlMs: 600_000,
    retainTranscriptAfterClose: false,
  };
  const channel = new ConversationService(config, {
    emit: (event) => {
      bridge.emit(event);
      events.push(event);
    },
  });
  const guide = channel.authenticate("guide", GUIDE_KEY);
  const guest = channel.authenticate("guest", GUEST_KEY, invitation);
  const g = channel.attachGuest(guest);
  const o = channel.open(guide, invitation, "open-unit-0001");
  let n = 0;
  const send = (who: Principal, text: string, extra: Record<string, unknown> = {}) => {
    n += 1;
    const cap = who.kind === "guide" ? o.capability : g.capability;
    return channel.send(who, {
      encounterId: o.encounterId,
      capability: cap,
      idempotencyKey: `key-${String(n)}-unit`,
      text,
      ...(who.kind === "guide" ? { authorship: "human_verbatim" } : {}),
      ...extra,
    });
  };
  const attest = (humanMessageId: string) => {
    bridge.attest({
      encounterId: o.encounterId,
      inReplyTo: humanMessageId,
      checkpointRef: `ckpt-${humanMessageId.slice(4, 20).replace(/_/g, "x")}`,
    });
  };
  const exchanges = () => service.exchanges(contractId);
  const earned = () => exchanges().filter((x) => x.state === "earned").length;
  /** Un échange payable complet à partir du point `point`. Retourne la réponse. */
  const full = (point: string): string => {
    const human = send(guide, "Try a fixed seed and vary only the rule.", { inReplyTo: point });
    const reply = send(guest, LONG, { inReplyTo: human.messageId });
    attest(human.messageId);
    return reply.messageId;
  };
  return {
    service,
    contractId: contractId,
    bridge,
    channel,
    events,
    guide,
    guest,
    g,
    o,
    send,
    attest,
    exchanges,
    earned,
    full,
  };
}

describe("traduction des faits de conversation", () => {
  it("active à l'ouverture, ouvre l'échange suivant seulement après la sauvegarde", () => {
    const s = setup();
    expect(s.service.status(s.contractId).state).toBe("active");
    const question = s.send(s.guest, "My question about identical groups, with what I tried.");
    expect(s.exchanges()).toEqual([
      { exchangeId: `x.${toRef(question.messageId)}`, seq: 1, state: "opened" },
    ]);
    const human = s.send(s.guide, "Measure on a random state first.", {
      inReplyTo: question.messageId,
    });
    expect(s.exchanges()[0]?.state).toBe("human_submitted");
    s.send(s.guest, LONG, { inReplyTo: human.messageId });
    expect(s.exchanges().map((x) => x.state)).toEqual(["agent_replied"]);
    s.attest(human.messageId);
    // Échange acquis ; la réponse, qui porte la question suivante, ouvre l'échange 2.
    expect(s.exchanges().map((x) => x.state)).toEqual(["earned", "opened"]);
  });

  it("refuse une séance non liée : la passerelle ne stocke rien", () => {
    expect(() => setup("c-bridge", "unbound-ref")).toThrow(/séance inconnue/);
  });
});

describe("H03 — une contribution et sa réponse comptent au plus une fois", () => {
  it("ignore duplicata, clarifications, brouillon d'assistant, réponse courte et rejeu", () => {
    const s = setup();
    const question = s.send(s.guest, "My question about identical groups, with what I tried.");
    // Clarification de l'agent avant toute contribution : même échange, non payable.
    s.send(s.guest, "To be precise: the groups have the same size every run.");
    // Brouillon d'assistant approuvé : non compté comme contribution humaine explicite.
    const draft = s.send(s.guide, "Maybe check the metric?", {
      inReplyTo: question.messageId,
      authorship: "human_approved_draft",
    });
    s.send(s.guest, LONG, { inReplyTo: draft.messageId });
    expect(s.exchanges().map((x) => x.state)).toEqual(["opened"]);
    // Contribution humaine explicite.
    const human = s.send(s.guide, "Compute your metric on a shuffled state.", {
      inReplyTo: question.messageId,
    });
    // Clarification du guide sur la même question : même échange.
    s.send(s.guide, "And keep the seed fixed while you do it.", { inReplyTo: question.messageId });
    // Accusé court : pas une réponse substantielle.
    s.send(s.guest, "ok", { inReplyTo: human.messageId });
    expect(s.exchanges().map((x) => x.state)).toEqual(["human_submitted"]);
    const reply = s.send(s.guest, LONG, { inReplyTo: human.messageId });
    // Duplicata de transport : même clé, même contenu, aucun nouvel événement.
    const before = s.events.length;
    const again = s.channel.send(s.guest, {
      encounterId: s.o.encounterId,
      capability: s.g.capability,
      idempotencyKey: "key-8-unit",
      text: LONG,
      inReplyTo: human.messageId,
    });
    expect(again).toMatchObject({ messageId: reply.messageId, duplicate: true });
    expect(s.events.length).toBe(before);
    s.attest(human.messageId);
    s.attest(human.messageId);
    expect(s.earned()).toBe(1);

    // Rejeu complet des événements du canal : rien ne change.
    for (const event of s.events) s.bridge.emit(event);
    expect(s.bridge.records().filter((r) => r.outcome === "duplicate_ignored")).toHaveLength(
      s.events.length,
    );
    expect(s.earned()).toBe(1);
    // Rejeu direct dans G1 d'un événement traduit : dédupliqué par G1.
    expect(
      s.service.ingest({
        kind: "agent_checkpoint",
        producer: "agent_runtime",
        eventId: `g3.ck.ckpt-${human.messageId.slice(4, 20).replace(/_/g, "x")}`,
        contractId: s.contractId,
        exchangeId: `x.${toRef(question.messageId)}`,
        checkpointRef: `ckpt-${human.messageId.slice(4, 20).replace(/_/g, "x")}`,
      }).status,
    ).toBe("duplicate");
    const outcomes = s.bridge.records().map((r) => `${r.action}=${r.outcome}`);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        "agent_clarification=not_payable:clarification_same_exchange",
        "human_contribution=not_payable:provenance:assistant_draft",
        "agent_reply=refused:no_human_contribution",
        "human_contribution=not_payable:same_exchange_clarification",
        "agent_reply=not_payable:non_substantive_reply",
        "agent_checkpoint=duplicate(applied:exchange_earned)",
      ]),
    );
  });
});

describe("H04 — limite du bloc et synthèse", () => {
  it("n'ouvre pas de sixième échange ; la synthèse n'est pas facturée ; clôture limit_reached", async () => {
    const s = setup();
    let point = s.send(s.guest, "My question about identical groups, with what I tried.").messageId;
    for (let i = 0; i < 5; i += 1) point = s.full(point);
    expect(s.earned()).toBe(5);
    expect(s.bridge.records().at(-1)).toMatchObject({
      action: "agent_point",
      outcome: "refused:max_exchanges_reached",
    });
    // Une contribution de plus, sans point ouvert, n'est pas comptée.
    s.send(s.guide, "One more idea for you.", { inReplyTo: point });
    s.send(s.guest, "Summary: I will separate the metric test from rule changes.");
    expect(s.bridge.records().at(-1)).toMatchObject({
      action: "final_summary",
      outcome: "not_payable:final_summary_not_billed",
    });
    s.channel.close(s.guest, {
      encounterId: s.o.encounterId,
      capability: s.g.capability,
      idempotencyKey: "close-unit-0001",
      reason: "completed",
    });
    expect(s.service.status(s.contractId).closeReason).toBe("limit_reached");
    expect(s.service.approve(s.contractId)).toEqual({ earnedExchanges: 5, principalDue: 10n });
    s.service.prepareSettlement(s.contractId);
    await drain(s.service);
    expect(s.service.receipt(s.contractId)).toMatchObject({
      amountDue: "10",
      status: "settled_simulated",
    });
  });

  it("arrêt du guide : échange ouvert sans contribution annulé, motif guide_stop", () => {
    const s = setup();
    let point = s.send(s.guest, "My question about identical groups, with what I tried.").messageId;
    point = s.full(point);
    expect(s.exchanges().map((x) => x.state)).toEqual(["earned", "opened"]);
    s.channel.close(s.guide, {
      encounterId: s.o.encounterId,
      capability: s.o.capability,
      idempotencyKey: "close-unit-0002",
      reason: "guide_stopped",
    });
    expect(s.service.status(s.contractId).closeReason).toBe("guide_stop");
    expect(s.exchanges().map((x) => x.state)).toEqual(["earned", "void"]);
    expect(point).toMatch(/^msg_/);
  });
});
