/**
 * Règlement simulé sous mandat : T05, P03 (même processus), P09, P20, reçu sans contenu
 * privé. Les variantes multi-processus et les crashs réels sont dans `process.test.ts`.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ledgerIsBalanced, type ContractId } from "../../../services/advice/session/index.js";
import {
  completeExchange,
  drain,
  exchangeEvents,
  GUIDE,
  harness,
  MANDATE,
  mandateFor,
  offerFor,
  openSession,
  POOL,
  TERMS,
  type Harness,
} from "./support.js";

let h: Harness | undefined;
afterEach(() => {
  h?.close();
  h?.dir.remove();
  h = undefined;
});

function readyToSettle(harnessed: Harness, id: string, exchanges = 3): ContractId {
  const contractId = openSession(harnessed.service, id);
  for (let i = 1; i <= exchanges; i += 1) {
    completeExchange(harnessed.service, contractId, `x${String(i)}`);
  }
  harnessed.service.close(contractId, "guide_stop");
  harnessed.service.approve(contractId);
  return contractId;
}

describe("T05 — règlement sous mandat", () => {
  it("cas normal : un seul effet, même avec workers, préparations et drains répétés", async () => {
    h = harness();
    const { service, rail } = h;
    const id = readyToSettle(h, "c-normal");
    expect(service.prepareSettlement(id).status).toBe("prepared");
    expect(service.prepareSettlement(id).status).toBe("already_prepared");
    await Promise.all([drain(service, "w1"), drain(service, "w2")]);
    await drain(service, "w3");
    expect(rail.effects()).toHaveLength(1);
    expect(rail.effects()[0]).toMatchObject({
      key: `stl-${id}`,
      guidePrincipalId: GUIDE,
      amount: "6",
    });
    expect(ledgerIsBalanced(h.db)).toBe(true);
  });

  it("hors plafond, bénéficiaire hors règle ou mandat révoqué : refusés avant réservation", () => {
    h = harness();
    const { service } = h;
    const ref = { mandateId: MANDATE, version: 1 };
    expect(() => service.offer("r1", offerFor("c1", { unitPrice: "11" }), ref)).toThrow(
      expect.objectContaining({ code: "over_exchange_cap" }),
    );
    expect(() =>
      service.offer("r2", offerFor("c2", { unitPrice: "10", maxExchanges: 6 }), ref),
    ).toThrow(expect.objectContaining({ code: "over_session_cap" }));
    expect(() => service.offer("r3", offerFor("c3", { agentId: "agent-autre" }), ref)).toThrow(
      expect.objectContaining({ code: "mandate_agent_mismatch" }),
    );
    service.registerMandate(
      mandateFor({ version: 2, guideRule: { kind: "allow_list", guides: [GUIDE] } }),
    );
    expect(() =>
      service.offer("r4", offerFor("c4", { guidePrincipalId: "guide-inattendu" }), {
        mandateId: MANDATE,
        version: 2,
      }),
    ).toThrow(expect.objectContaining({ code: "guide_not_allowed" }));

    const contract = service.offer("r5", offerFor("c5"), ref);
    service.accept(contract.contractId, contract.guidePrincipalId, TERMS);
    service.revokeMandate(MANDATE, 1);
    expect(() => {
      service.reserve(contract.contractId);
    }).toThrow(expect.objectContaining({ code: "mandate_revoked" }));
    expect(service.poolBalances(POOL).available).toBe(100n);
  });

  it("bénéficiaire substitué après préparation : gel avant émission, aucun effet", async () => {
    h = harness();
    const { service, rail, db } = h;
    const id = readyToSettle(h, "c-subst");
    service.prepareSettlement(id);
    // Compromission simulée du stockage : le payload désigne un autre bénéficiaire.
    const intent = db
      .prepare<[string], { payload: string }>(
        "SELECT payload FROM settlement_intents WHERE contract_id = ?",
      )
      .get(id);
    const tampered = (intent?.payload ?? "").replace(GUIDE, "guide-pirate");
    db.prepare("UPDATE settlement_intents SET payload = ? WHERE contract_id = ?").run(tampered, id);
    await drain(service);
    expect(rail.effects()).toEqual([]);
    expect(service.status(id).settlement).toMatchObject({ state: "frozen" });
    expect(service.status(id).settlement?.frozenReason).toMatch(/bénéficiaire/);
    expect(service.receipt(id).status).toBe("frozen_simulated");
    expect(service.poolBalances(POOL)).toMatchObject({ due: 6n, available: 94n });
  });

  it("refuse une deuxième rencontre simultanée pour le même agent ou guide", () => {
    h = harness();
    const { service } = h;
    openSession(service, "c-live");
    const second = service.offer("r-second", offerFor("c-second"), {
      mandateId: MANDATE,
      version: 1,
    });
    service.accept(second.contractId, second.guidePrincipalId, TERMS);
    expect(() => {
      service.reserve(second.contractId);
    }).toThrow(expect.objectContaining({ code: "party_already_in_session" }));
    expect(service.poolBalances(POOL)).toMatchObject({ available: 90n, reserved: 10n });
  });
});

describe("P03 — réservations au-delà de l'enveloppe (même processus)", () => {
  it("n'accepte que les réservations intégralement couvertes, sans solde négatif", () => {
    h = harness({ fund: 25n });
    const { service } = h;
    const results: string[] = [];
    for (const i of [1, 2, 3, 4]) {
      const contract = service.offer(
        `r-${String(i)}`,
        offerFor(`c-${String(i)}`, { guidePrincipalId: `guide-${String(i)}`, agentId: "agent-1" }),
        { mandateId: MANDATE, version: 1 },
      );
      service.accept(contract.contractId, contract.guidePrincipalId, TERMS);
      try {
        service.reserve(contract.contractId);
        service.activate(contract.contractId);
        service.close(contract.contractId, "agent_stop");
        results.push("reserved");
      } catch (error) {
        results.push((error as { code: string }).code);
      }
    }
    expect(results).toEqual([
      "reserved",
      "reserved",
      "insufficient_fictive_funds",
      "insufficient_fictive_funds",
    ]);
    expect(service.poolBalances(POOL)).toMatchObject({ available: 5n, reserved: 20n });
  });

  it("respecte le plafond de période du mandat", () => {
    h = harness({ fund: 1_000n });
    const { service } = h;
    service.registerMandate(mandateFor({ version: 3, perPeriodCap: "15" }));
    const ref = { mandateId: MANDATE, version: 3 };
    const a = service.offer("ra", offerFor("ca"), ref);
    service.accept(a.contractId, a.guidePrincipalId, TERMS);
    service.reserve(a.contractId);
    service.activate(a.contractId);
    service.close(a.contractId, "agent_stop");
    const b = service.offer("rb", offerFor("cb", { guidePrincipalId: "guide-b" }), ref);
    service.accept(b.contractId, b.guidePrincipalId, TERMS);
    expect(() => {
      service.reserve(b.contractId);
    }).toThrow(expect.objectContaining({ code: "over_period_cap" }));
    // L'excédent libéré à l'approbation redevient engageable dans la période.
    service.approve(a.contractId);
    service.reserve(b.contractId);
    expect(service.status(b.contractId).state).toBe("reserved");
  });
});

describe("P09 — timeout et fenêtre d'idempotence expirée", () => {
  it("timeout après acceptation : statut inconnu rapproché, aucun second transfert", async () => {
    h = harness({ rail: { faults: { timeoutAfterAccept: 1 } } });
    const { service, rail } = h;
    const id = readyToSettle(h, "c-timeout");
    service.prepareSettlement(id);
    const first = await service.runWorker("w1");
    expect(first.handled[0]?.result).toBe("unknown_after_timeout");
    expect(service.status(id)).toMatchObject({
      settlement: { state: "unknown" },
      reservation: { state: "uncertain" },
    });
    expect(service.poolBalances(POOL)).toMatchObject({ due: 6n, available: 94n });
    expect(service.receipt(id).status).toBe("settling_simulated");
    h.clock.advance(31_000);
    await drain(service, "w2");
    expect(rail.effects()).toHaveLength(1);
    expect(service.status(id)).toMatchObject({
      state: "settled",
      settlement: { state: "finalized" },
    });
    expect(service.poolBalances(POOL)).toEqual({
      available: 94n,
      reserved: 0n,
      due: 0n,
      settling: 0n,
    });
  });

  it("fenêtre expirée : absence non probante, intention gelée plutôt que réémise", async () => {
    h = harness({ rail: { lookupRetentionMs: 60_000, faults: { timeoutAfterAccept: 1 } } });
    const { service, rail } = h;
    const id = readyToSettle(h, "c-window");
    service.prepareSettlement(id);
    await service.runWorker("w1");
    expect(rail.effects()).toHaveLength(1);
    // Le rail a oublié la clé ; une réémission créerait un second transfert.
    h.clock.advance(120_000);
    await drain(service, "w2");
    expect(rail.effects()).toHaveLength(1);
    expect(service.status(id).settlement).toMatchObject({ state: "frozen" });
    expect(service.status(id).settlement?.frozenReason).toMatch(/irrésoluble/);
    expect(service.status(id).reservation?.state).toBe("uncertain");
    expect(service.poolBalances(POOL)).toMatchObject({ due: 6n, available: 94n });
  });

  it("recherche indisponible : reste incertain sans émission", async () => {
    h = harness({ rail: { faults: { timeoutBeforeAccept: 1, lookupUnavailable: 2 } } });
    const { service, rail } = h;
    const id = readyToSettle(h, "c-unavail");
    service.prepareSettlement(id);
    await service.runWorker("w1");
    h.clock.advance(31_000);
    expect((await service.runWorker("w2")).handled[0]?.result).toBe("lookup_unavailable");
    h.clock.advance(31_000);
    expect((await service.runWorker("w3")).handled[0]?.result).toBe("lookup_unavailable");
    expect(rail.effects()).toEqual([]);
    expect(service.status(id).settlement?.state).toBe("unknown");
    // Recherche rétablie : absence probante dans la fenêtre, émission unique.
    h.clock.advance(31_000);
    await drain(service, "w4");
    expect(rail.effects()).toHaveLength(1);
    expect(service.status(id).state).toBe("settled");
  });
});

describe("P20 — gel d'urgence et reprise", () => {
  it("bloque nouveaux engagements et soumissions, rapproche ce qui est parti, reprise explicite", async () => {
    h = harness({ rail: { finalityDelayMs: 10_000 } });
    const { service, rail } = h;
    // Un règlement déjà soumis avant le gel.
    const sent = readyToSettle(h, "c-sent");
    service.prepareSettlement(sent);
    await service.runWorker("w0");
    expect(service.status(sent).settlement?.state).toBe("confirming");
    // Un règlement préparé mais pas encore émis.
    const queued = readyToSettle(h, "c-queued", 1);
    service.prepareSettlement(queued);

    service.freeze("ops-1", "écart de rapprochement simulé");
    expect(service.isFrozen()).toBe(true);
    const c = service.offer("r-new", offerFor("c-new"), { mandateId: MANDATE, version: 1 });
    service.accept(c.contractId, c.guidePrincipalId, TERMS);
    expect(() => {
      service.reserve(c.contractId);
    }).toThrow(expect.objectContaining({ code: "frozen" }));
    const late = openSessionAfterFreeze(h);
    expect(() => service.prepareSettlement(late)).toThrow(
      expect.objectContaining({ code: "frozen" }),
    );

    h.clock.advance(31_000);
    await drain(service, "w1");
    // Le transfert déjà parti est rapproché et finalisé ; le nouveau n'est pas émis.
    expect(service.status(sent).state).toBe("settled");
    expect(service.status(queued).settlement?.state).toBe("prepared");
    expect(rail.effects()).toHaveLength(1);

    service.unfreeze("ops-1", "rapprochement vérifié");
    await drain(service, "w2");
    expect(service.status(queued).settlement?.state).toBe("confirming");
    h.clock.advance(10_000);
    await drain(service, "w3");
    expect(service.status(queued).state).toBe("settled");
    expect(rail.effects()).toHaveLength(2);
    service.reserve(c.contractId);
    expect(service.journalEntries().map((e) => e.kind)).toEqual(
      expect.arrayContaining(["freeze", "unfreeze"]),
    );
  });

  it("refuse la reprise tant qu'un statut incertain n'est pas rapproché", async () => {
    h = harness({ rail: { faults: { timeoutAfterAccept: 1, lookupUnavailable: 1 } } });
    const { service } = h;
    const id = readyToSettle(h, "c-freeze-unknown");
    service.prepareSettlement(id);
    await service.runWorker("w1");
    service.freeze("ops-1", "incident");
    expect(() => {
      service.unfreeze("ops-1", "trop tôt");
    }).toThrow(expect.objectContaining({ code: "reconcile_first" }));
    h.clock.advance(31_000);
    await service.runWorker("w2"); // recherche indisponible : toujours incertain
    expect(() => {
      service.unfreeze("ops-1", "trop tôt");
    }).toThrow(expect.objectContaining({ code: "reconcile_first" }));
    h.clock.advance(31_000);
    await drain(service, "w3"); // rapproché pendant le gel : transfert trouvé
    expect(service.status(id).state).toBe("settled");
    service.unfreeze("ops-1", "rapproché");
    expect(service.isFrozen()).toBe(false);
    expect(h.rail.effects()).toHaveLength(1);
  });
});

function openSessionAfterFreeze(harnessed: Harness): ContractId {
  // Réservée avant le gel (engagement existant), clôturée pendant le gel.
  const { service } = harnessed;
  service.unfreeze("ops-1", "fenêtre de test");
  const id = openSession(service, "c-late", { guidePrincipalId: "guide-late", agentId: "agent-1" });
  service.freeze("ops-1", "regel");
  completeExchange(service, id, "y1", "guide-late");
  service.close(id, "guide_stop");
  service.approve(id);
  return id;
}

describe("reçu et données privées", () => {
  it("ne contient aucun contenu de conversation ni libellé de paiement réel", async () => {
    h = harness();
    const { service, dir } = h;
    const id = openSession(service, "c-privacy");
    const [point, contribution, reply, checkpoint] = exchangeEvents(id, "x1");
    service.ingest(point);
    service.ingest({
      kind: "free_text_claim",
      producer: "channel",
      eventId: "secret-claim",
      contractId: id,
      claim: "mon mot de passe est hunter2-TEMOIN et mon IBAN FR76TEMOIN",
    });
    service.ingest(contribution);
    service.ingest(reply);
    service.ingest(checkpoint);
    service.close(id, "guide_stop");
    service.approve(id);
    service.prepareSettlement(id);
    await drain(service);
    const receipt = service.receipt(id);
    const text = JSON.stringify(receipt);
    for (const forbidden of ["x1-h", "x1-r", "x1-q", "x1-ckpt", "émergents", "TEMOIN"]) {
      expect(text).not.toContain(forbidden);
    }
    // Aucune affirmation de paiement réel, d'actif réel ou de garantie.
    expect(text).not.toMatch(/\bpay[ée]s?\b|\bpaid\b|\$MIND|garanti/i);
    expect(receipt.notice).toMatch(/aucun fonds réel, wallet ou transfert/);
    expect(receipt.label).toBe("SIMULÉ — unités fictives, aucun paiement réel");
    expect(receipt.notice).toMatch(/pas un escrow/);
    h.close();
    for (const file of [dir.dbPath, dir.railPath]) {
      expect(readFileSync(file).includes("TEMOIN")).toBe(false);
    }
    h = harness({ dir, fund: null });
    // Les dumps WAL peuvent avoir été intégrés à la base : la vérification reste valable.
    expect(JSON.stringify(h.db.prepare("SELECT * FROM inbox").all())).not.toContain("TEMOIN");
  });
});
