/**
 * P19 (montants exacts, bornes, cas gratuit explicite) et machine à états du contrat.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  AmountError,
  buildContract,
  canonicalJson,
  canTransition,
  ContractError,
  isTerminal,
  MAX_FICTIVE_AMOUNT,
  multiplyAmount,
  parseAmount,
  parseStoredContract,
  type ContractState,
} from "../../../services/advice/session/index.js";
import {
  completeExchange,
  drain,
  harness,
  iso,
  mandateFor,
  offerFor,
  openSession,
  T0,
  type Harness,
} from "./support.js";

let h: Harness | undefined;
afterEach(() => {
  h?.close();
  h?.dir.remove();
  h = undefined;
});

describe("P19 — montants exacts et paramètres bornés", () => {
  it("refuse number, décimales, exposants, signes, espaces et zéros non significatifs", () => {
    for (const bad of [1, 1.5, "1.5", "1e3", "-1", "01", " 1", "1 ", "+1", "", "0x10", null]) {
      expect(() => parseAmount(bad)).toThrow(AmountError);
    }
    expect(parseAmount("0")).toBe(0n);
    expect(parseAmount(7n)).toBe(7n);
    expect(parseAmount("999999999999999999999999999999")).toBe(MAX_FICTIVE_AMOUNT);
    expect(() => parseAmount("1000000000000000000000000000000")).toThrow(AmountError);
    expect(() => parseAmount(-1n)).toThrow(AmountError);
  });

  it("refuse un débordement au lieu de tronquer", () => {
    expect(() => multiplyAmount(MAX_FICTIVE_AMOUNT, 2)).toThrow(AmountError);
    expect(multiplyAmount(123_456_789_012_345_678_901_234n, 5)).toBe(
      617_283_945_061_728_394_506_170n,
    );
  });

  it("sérialise exactement de grands entiers, sans flottant", () => {
    const mandate = mandateFor({
      perExchangeCap: "999999999999999999999999",
      perSessionCap: "999999999999999999999999999",
    });
    const contract = buildContract(
      offerFor("c-big", { unitPrice: "123456789012345678901234", maxExchanges: 7 }),
      mandate,
      iso(T0),
    );
    const json = canonicalJson(contract);
    expect(json).toContain('"unitPrice":"123456789012345678901234"');
    expect(json).toContain('"maxPrincipal":"864197523086419752308638"');
    const back = parseStoredContract(json);
    expect(back.maxPrincipal).toBe(864_197_523_086_419_752_308_638n);
    expect(canonicalJson(back)).toBe(json);
  });

  it("refuse les compteurs hors bornes et garde 5 échanges par défaut", () => {
    const mandate = mandateFor();
    for (const maxExchanges of [0, -1, 2.5, 51, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildContract(offerFor("c", { maxExchanges }), mandate, iso(T0))).toThrow(
        ContractError,
      );
    }
    expect(buildContract(offerFor("c"), mandate, iso(T0)).maxExchanges).toBe(5);
    expect(() =>
      buildContract(offerFor("c", { inactivityTimeoutMs: -1 }), mandate, iso(T0)),
    ).toThrow(ContractError);
    expect(() =>
      buildContract(offerFor("c", { topic: "ligne\nsecrète" }), mandate, iso(T0)),
    ).toThrow(ContractError);
  });

  it("refuse un prix nul implicite et accepte une séance explicitement offerte", async () => {
    h = harness();
    const { service } = h;
    expect(() =>
      service.offer("req-zero", offerFor("c-zero", { unitPrice: "0" }), {
        mandateId: mandateFor().mandateId,
        version: 1,
      }),
    ).toThrow(expect.objectContaining({ code: "zero_price_not_offered" }));
    expect(() =>
      service.offer("req-num", offerFor("c-num", { unitPrice: 2 as unknown as string }), {
        mandateId: mandateFor().mandateId,
        version: 1,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_amount" }));

    const id = openSession(service, "c-free", { unitPrice: "0", offeredFree: true });
    completeExchange(service, id, "x1");
    service.close(id, "guide_stop");
    expect(service.approve(id)).toEqual({ earnedExchanges: 1, principalDue: 0n });
    expect(service.prepareSettlement(id).status).toBe("settled_without_transfer");
    await drain(service);
    expect(h.rail.effects()).toEqual([]);
    expect(service.status(id).state).toBe("settled");
    expect(service.receipt(id).status).toBe("none_due_simulated");
    expect(service.poolBalances(mandateFor().poolId).available).toBe(100n);
  });
});

describe("machine à états du contrat", () => {
  it("n'autorise que les transitions prévues", () => {
    const states: ContractState[] = [
      "offered",
      "accepted",
      "reserved",
      "active",
      "submitted",
      "approved",
      "settlement_pending",
      "settled",
      "cancelled",
      "expired",
      "disputed",
    ];
    expect(canTransition("offered", "accepted")).toBe(true);
    expect(canTransition("offered", "active")).toBe(false);
    expect(canTransition("active", "cancelled")).toBe(false);
    expect(canTransition("approved", "settled")).toBe(true);
    expect(canTransition("settled", "settlement_pending")).toBe(false);
    for (const terminal of ["settled", "cancelled", "expired", "disputed"] as const) {
      expect(isTerminal(terminal)).toBe(true);
      for (const to of states) expect(canTransition(terminal, to)).toBe(false);
    }
  });

  it("journalise chaque transition avec la mention SIMULÉ", async () => {
    h = harness();
    const { service } = h;
    const id = openSession(service, "c-journal");
    completeExchange(service, id, "x1");
    service.close(id, "agent_stop");
    service.approve(id);
    service.prepareSettlement(id);
    await drain(service);
    const transitions = service
      .journalEntries(id)
      .filter((e) => e.kind === "contract_transition")
      .map((e) => e.to);
    expect(transitions).toEqual([
      "offered",
      "accepted",
      "reserved",
      "active",
      "submitted",
      "approved",
      "settlement_pending",
      "settled",
    ]);
    for (const entry of service.journalEntries()) expect(entry.reason).toMatch(/^\[SIMULÉ\] /);
    expect(() => {
      h?.db.prepare("UPDATE journal SET reason = 'x'").run();
    }).toThrow(/append-only/);
  });

  it("refuse une transition hors table et garde le contrat immuable", () => {
    h = harness();
    const { service } = h;
    const contract = service.offer("req-a", offerFor("c-a"), {
      mandateId: mandateFor().mandateId,
      version: 1,
    });
    expect(() => {
      service.activate(contract.contractId);
    }).toThrow(expect.objectContaining({ code: "invalid_transition" }));
    expect(() => service.close(contract.contractId, "guide_stop")).toThrow(
      expect.objectContaining({ code: "invalid_transition" }),
    );
    // Même clé de demande, autres paramètres : conflit, pas de mutation.
    expect(() =>
      service.offer("req-a", offerFor("c-a", { unitPrice: "3" }), {
        mandateId: mandateFor().mandateId,
        version: 1,
      }),
    ).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(
      service.offer("req-a", offerFor("c-a"), { mandateId: mandateFor().mandateId, version: 1 }),
    ).toEqual(contract);
    expect(Object.isFrozen(contract)).toBe(true);
    expect(service.status(contract.contractId).contract.unitPrice).toBe(2n);
  });

  it("expire une offre non activée et libère sa réservation", () => {
    h = harness();
    const { service, clock: c } = h;
    const contract = service.offer("req-e", offerFor("c-e"), {
      mandateId: mandateFor().mandateId,
      version: 1,
    });
    service.accept(contract.contractId, contract.guidePrincipalId, contract.guideTermsVersion);
    service.reserve(contract.contractId);
    expect(service.poolBalances(contract.poolId).available).toBe(90n);
    c.advance(2 * 3_600_000);
    expect(service.sweep().expired).toEqual([contract.contractId]);
    expect(service.status(contract.contractId).state).toBe("expired");
    expect(service.status(contract.contractId).reservation?.state).toBe("released");
    expect(service.poolBalances(contract.poolId)).toMatchObject({ available: 100n, reserved: 0n });
  });

  it("clôt pour inactivité sans effacer les échanges acquis", async () => {
    h = harness();
    const { service, clock: c } = h;
    const id = openSession(service, "c-idle");
    completeExchange(service, id, "x1");
    c.advance(31 * 60_000);
    expect(service.sweep().closedForInactivity).toEqual([id]);
    expect(service.status(id).closeReason).toBe("inactivity_expired");
    expect(service.approve(id)).toEqual({ earnedExchanges: 1, principalDue: 2n });
    service.prepareSettlement(id);
    await drain(service);
    expect(service.status(id).state).toBe("settled");
  });
});
