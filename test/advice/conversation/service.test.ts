/**
 * Règles du service de conversation en processus unique, avec horloge simulée.
 */

import { describe, expect, it } from "vitest";
import { digest, opaque } from "../../../services/advice/conversation/capability.js";
import {
  MemoryExchangeEventSink,
  type ConversationEvent,
  type ExchangeEventSink,
} from "../../../services/advice/conversation/events.js";
import { LIMITS } from "../../../services/advice/conversation/protocol.js";
import {
  ConversationError,
  ConversationService,
  type GatewayConfig,
} from "../../../services/advice/conversation/service.js";

const GUIDE_KEY = "guide-key-0123456789abcdef";
const GUEST_KEY = "guest-key-0123456789abcdef";
const OPERATOR_KEY = "operator-key-0123456789ab";
const INVITATION = opaque("inv");

function setup(options: { retain?: boolean; sink?: ExchangeEventSink } = {}) {
  let now = Date.parse("2026-10-29T10:00:00.000Z");
  const config: GatewayConfig = {
    guides: [{ privateId: "alice@example.com", keyDigest: digest(GUIDE_KEY) }],
    invitations: [
      {
        invitation: INVITATION,
        sessionRef: "sess_unit",
        topic: "unit",
        ownerPrivateId: "bob@example.org",
        guestKeyDigest: digest(GUEST_KEY),
      },
    ],
    operatorKeyDigest: digest(OPERATOR_KEY),
    encounterTtlMs: 60_000,
    retainTranscriptAfterClose: options.retain ?? false,
  };
  const memory = new MemoryExchangeEventSink();
  const service = new ConversationService(config, options.sink ?? memory, { now: () => now });
  const guide = service.authenticate("guide", GUIDE_KEY);
  const guest = service.authenticate("guest", GUEST_KEY, INVITATION);
  const hello = service.attachGuest(guest);
  const opened = service.open(guide, INVITATION, "open-unit-0001");
  return {
    service,
    memory,
    guide,
    guest,
    g: { encounterId: hello.encounterId, capability: hello.capability },
    h: { encounterId: opened.encounterId, capability: opened.capability },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof ConversationError) return error.code;
    throw error;
  }
  return undefined;
}

describe("ConversationService", () => {
  it("expire paresseusement à l'échéance et n'émet l'expiration qu'une fois", () => {
    const { service, memory, guide, h, advance } = setup();
    advance(59_999);
    expect(service.status(guide, h).state).toBe("open");
    advance(1);
    expect(code(() => service.status(guide, h))).toBe("encounter_closed");
    service.sweep();
    expect(memory.events.filter((e) => e.type === "encounter_expired")).toHaveLength(1);
  });

  it("n'enregistre rien si l'émission de l'événement échoue ; le retry réussit une fois", () => {
    const emitted: ConversationEvent[] = [];
    let fail = false;
    const sink: ExchangeEventSink = {
      emit(event) {
        if (fail) throw new Error("disque plein");
        emitted.push(event);
      },
    };
    const { service, guide, h } = setup({ sink });
    const input = {
      ...h,
      idempotencyKey: "retry-key-0001",
      text: "Try X.",
      authorship: "human_verbatim" as const,
    };
    fail = true;
    expect(() => service.send(guide, input)).toThrow("disque plein");
    fail = false;
    const sent = service.send(guide, input);
    expect(sent.duplicate).toBe(false);
    expect(service.send(guide, input).duplicate).toBe(true);
    expect(emitted.filter((e) => e.type === "human_contribution_accepted")).toHaveLength(1);
  });

  it("refuse vide, réponse à soi-même et dépassement du nombre de messages", () => {
    const { service, guide, h } = setup();
    const send = (key: string, text: string, inReplyTo?: string) =>
      service.send(guide, {
        ...h,
        idempotencyKey: key,
        text,
        authorship: "human_verbatim",
        inReplyTo,
      });
    expect(code(() => send("empty-key-0001", "   "))).toBe("empty_message");
    const own = send("first-key-0001", "First.");
    expect(code(() => send("self-key-00001", "Self reply.", own.messageId))).toBe(
      "unknown_reference",
    );
    for (
      let i = 0;
      service.status(guide, h).messages.human + 1 < LIMITS.maxMessagesPerEncounter;
      i++
    ) {
      send(`fill-key-${String(i).padStart(5, "0")}`, `Fill ${String(i)}.`);
    }
    expect(code(() => send("over-key-00001", "One too many."))).toBe("limit_reached");
  });

  it("conserve les corps après clôture seulement si la configuration le demande", () => {
    for (const retain of [false, true]) {
      const { service, guide, h } = setup({ retain });
      service.send(guide, {
        ...h,
        idempotencyKey: "keep-key-0001",
        text: "Keep?",
        authorship: "human_verbatim",
      });
      service.close(guide, { ...h, idempotencyKey: "close-key-001", reason: "completed" });
      const operator = service.authenticate("operator", OPERATOR_KEY);
      const audit = service.audit(operator, h.encounterId);
      expect(audit.entries.every((e) => e.bodyRetained === retain)).toBe(true);
    }
  });

  it("le guest ne peut parler qu'une fois la rencontre ouverte par le guide", () => {
    const config = setup();
    const { service, guest, g } = config;
    expect(service.status(guest, g).state).toBe("open");
    const fresh = new ConversationService(
      {
        guides: [],
        invitations: [
          {
            invitation: INVITATION,
            sessionRef: "sess_unit",
            topic: "unit",
            ownerPrivateId: "bob@example.org",
            guestKeyDigest: digest(GUEST_KEY),
          },
        ],
        operatorKeyDigest: digest(OPERATOR_KEY),
        encounterTtlMs: 1000,
        retainTranscriptAfterClose: false,
      },
      new MemoryExchangeEventSink(),
    );
    const early = fresh.authenticate("guest", GUEST_KEY, INVITATION);
    const hello = fresh.attachGuest(early);
    expect(
      code(() =>
        fresh.send(early, {
          encounterId: hello.encounterId,
          capability: hello.capability,
          idempotencyKey: "early-key-0001",
          text: "Anyone?",
        }),
      ),
    ).toBe("encounter_not_open");
  });
});
