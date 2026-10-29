/**
 * Recettes de bout en bout de la démo SIMULÉE de conseil guest (SPEC §17.8, H01–H06),
 * avec un vrai processus pour l'agent guest et pour l'adaptateur MCP du guide.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  demoCatalog,
  GUEST_MEMORY_MARKER,
  GUEST_PRIVATE_TOKEN,
  GUEST_PROMPT_MARKER,
  GUIDE_SCRIPT,
} from "../../../services/advice/demo/catalog.js";
import type { GuestListing } from "../../../services/advice/demo/matching.js";
import {
  AdviceDemo,
  DEMO_SENTENCE,
  type DemoSession,
  type StartOptions,
} from "../../../services/advice/demo/scenario.js";
import type { PoolId } from "../../../services/advice/session/index.js";

const TIMEOUT = 60_000;
const POOL_C = "pool-agent-c" as PoolId;
const GRACE_MS = 60_000;

let demo: AdviceDemo | undefined;
let dir: string | undefined;
afterEach(async () => {
  await demo?.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  demo = undefined;
  dir = undefined;
});

function world(
  options: { catalog?: GuestListing[]; railFaults?: { timeoutAfterAccept?: number } } = {},
) {
  dir = mkdtempSync(join(tmpdir(), "mind-advice-g3-"));
  demo = new AdviceDemo({
    dir,
    catalog: options.catalog ?? demoCatalog(),
    closeGraceMs: GRACE_MS,
    ...(options.railFaults === undefined ? {} : { railFaults: options.railFaults }),
  });
  return demo;
}

async function started(d: AdviceDemo, options: StartOptions = {}): Promise<DemoSession> {
  const result = await d.start(DEMO_SENTENCE, options);
  if (result.status !== "started") throw new Error(`lancement : ${result.status}`);
  return result.session;
}

function count(d: AdviceDemo, table: string): number {
  return (d.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("H01 — une seule phrase", { timeout: TIMEOUT }, () => {
  it("matching, réservation et réveil automatiques ; première question affichée", async () => {
    const d = world();
    const session = await started(d);
    // Matching déterministe : agent-a sans question prête, agent-b sans budget suffisant.
    expect(session.listing.agentId).toBe("agent-c");
    const status = d.service.status(session.contractId);
    expect(status.state).toBe("active");
    expect(status.reservation).toMatchObject({ state: "held", amount: 10n });
    expect(status.label).toMatch(/SIMULÉ/);
    // L'agent tourne dans son propre processus, pas dans celui du service ni du guide.
    expect(session.guest().child.pid).toBeDefined();
    expect(session.guest().child.pid).not.toBe(process.pid);
    const first = session.transcript.find((m) => m.provenance === "agent");
    expect(first).toMatchObject({
      trust: "untrusted_remote_agent",
      author: session.agentPseudonym,
    });
    expect(first?.text).toMatch(/identical groups/);
    expect(d.service.exchanges(session.contractId)).toEqual([
      expect.objectContaining({ seq: 1, state: "opened" }),
    ]);
    expect(await d.start("Bonjour")).toEqual({ status: "not_understood" });
  });
});

describe("H02 — aucun candidat ou réveil impossible", { timeout: TIMEOUT }, () => {
  it("aucun candidat : statut clair, aucun contrat, rien de réservé", async () => {
    const d = world();
    const result = await d.start(DEMO_SENTENCE, { request: { language: "en" } });
    expect(result).toMatchObject({ status: "no_candidate" });
    expect(count(d, "contracts")).toBe(0);
    expect(d.rail.effects()).toEqual([]);
  });

  it("réveil impossible : contrat annulé, réservation libérée, aucun échange facturé", async () => {
    const d = world({ catalog: demoCatalog({ wakeFails: true }) });
    const result = await d.start(DEMO_SENTENCE);
    if (result.status !== "wake_failed") throw new Error(result.status);
    expect(result.receipt.status).toBe("cancelled_simulated");
    const status = d.service.status(result.contractId);
    expect(status.state).toBe("cancelled");
    expect(status.reservation?.state).toBe("released");
    expect(d.service.poolBalances(POOL_C)).toMatchObject({
      available: 100n,
      reserved: 0n,
    });
    expect(count(d, "exchanges")).toBe(0);
    expect(d.rail.effects()).toEqual([]);
  });
});

describe("H03 + duplicata de message", { timeout: TIMEOUT }, () => {
  it("duplicatas de transport du guest et retry du guide ne gonflent pas le compteur", async () => {
    const d = world();
    const session = await started(d, { guest: { duplicateSends: true } });
    await session.exchange(GUIDE_SCRIPT[0]);
    // Le guide renvoie la même contribution avec la même clé : dédupliquée par le canal.
    const point = session.lastAgentMessage()?.messageId;
    const first = await session.contribute(GUIDE_SCRIPT[1], {
      idempotencyKey: "guide-retry-0001",
      ...(point === undefined ? {} : { inReplyTo: point }),
    });
    const retry = await session.contribute(GUIDE_SCRIPT[1], {
      idempotencyKey: "guide-retry-0001",
      ...(point === undefined ? {} : { inReplyTo: point }),
    });
    expect(retry).toEqual({ messageId: first.messageId, duplicate: true });
    await session.nextAgentMessage((m) => m.inReplyTo === first.messageId);
    await session.awaitEarned(2);
    // Chaque envoi du guest est livré deux fois : un seul message par réponse.
    const agentMessages = session.transcript.filter((m) => m.provenance === "agent");
    expect(new Set(agentMessages.map((m) => m.messageId)).size).toBe(agentMessages.length);
    expect(agentMessages).toHaveLength(3);
    await session.requestClose();
    await session.awaitClosed();
    const settled = await session.settle();
    expect(settled.receipt).toMatchObject({ amountDue: "4", criteria: { earnedExchanges: 2 } });
    expect(d.rail.effects()).toHaveLength(1);
  });
});

describe("H04 — limite du bloc, désaccord et synthèse", { timeout: TIMEOUT }, () => {
  it("5 échanges, synthèse non facturée, aucun dépassement ; poursuite = nouveau contrat", async () => {
    const d = world();
    const session = await started(d, { guest: { closeAfter: 5 } });
    // La troisième contribution est un désaccord : le comptage n'en dépend pas.
    for (const text of GUIDE_SCRIPT) await session.exchange(text);
    const closed = await session.awaitClosed();
    expect(closed.closeReason).toBe("limit_reached");
    const outcomes = session.bridge.records().map((r) => `${r.action}=${r.outcome}`);
    expect(outcomes).toContain("agent_point=refused:max_exchanges_reached");
    expect(outcomes).toContain("final_summary=not_payable:final_summary_not_billed");
    const settled = await session.settle();
    expect(settled.receipt).toMatchObject({
      amountDue: "10",
      status: "settled_simulated",
      criteria: { earnedExchanges: 5, maxExchanges: 5, closeReason: "limit_reached" },
    });
    expect(d.rail.effects().map((e) => e.amount)).toEqual(["10"]);
    await session.dispose();

    // Poursuivre exige une nouvelle demande explicite : nouveau contrat, nouvelle réservation.
    const next = await started(d);
    expect(next.contractId).not.toBe(session.contractId);
    expect(d.service.status(next.contractId).reservation).toMatchObject({ amount: 10n });
  });
});

describe("H05 — fin anticipée et incident de règlement", { timeout: TIMEOUT }, () => {
  it("arrêt à 3 échanges sur 5 : 3 réglés une fois, réserve inutilisée libérée", async () => {
    const d = world();
    const session = await started(d);
    for (const text of GUIDE_SCRIPT.slice(0, 3)) await session.exchange(text);
    await session.requestClose("guide_stopped");
    const closed = await session.awaitClosed();
    expect(closed.closeReason).toBe("guide_stop");
    const settled = await session.settle();
    expect(settled.receipt).toMatchObject({
      amountDue: "6",
      status: "settled_simulated",
      criteria: { earnedExchanges: 3, closeReason: "guide_stop" },
    });
    expect(settled.contract.reservation).toMatchObject({ state: "consumed", released: 4n });
    expect(d.rail.effects().map((e) => e.amount)).toEqual(["6"]);
    // Un second règlement ne crée aucun nouvel effet.
    await session.settle();
    expect(d.rail.effects()).toHaveLength(1);
  });

  it("timeout après acceptation : rapproché par recherche, sans double paiement", async () => {
    const d = world({ railFaults: { timeoutAfterAccept: 1 } });
    const session = await started(d);
    await session.exchange(GUIDE_SCRIPT[0]);
    await session.requestClose();
    await session.awaitClosed();
    const settled = await session.settle();
    expect(settled.receipt.status).toBe("settled_simulated");
    expect(d.rail.effects().map((e) => e.amount)).toEqual(["2"]);
  });
});

describe("crash du processus guest en cours d'échange", { timeout: TIMEOUT }, () => {
  async function crashDuringThird(d: AdviceDemo): Promise<DemoSession> {
    const session = await started(d);
    for (const text of GUIDE_SCRIPT.slice(0, 2)) await session.exchange(text);
    await session.crashGuest();
    // La contribution part pendant que l'agent est tombé : l'échange 3 reste incomplet.
    await session.contribute(GUIDE_SCRIPT[2]);
    expect(d.service.exchanges(session.contractId).map((x) => x.state)).toEqual([
      "earned",
      "earned",
      "human_submitted",
    ]);
    return session;
  }

  it("reprise : l'agent redémarre chez lui depuis sa mémoire et termine l'échange", async () => {
    const d = world();
    const session = await crashDuringThird(d);
    session.restartGuest();
    await session.awaitEarned(3);
    await session.requestClose();
    await session.awaitClosed();
    const settled = await session.settle();
    expect(settled.receipt).toMatchObject({ amountDue: "6", criteria: { earnedExchanges: 3 } });
  });

  it("sans reprise : l'échange incomplet n'est pas compté, seuls 2 sont réglés", async () => {
    const d = world();
    const session = await crashDuringThird(d);
    await session.requestClose();
    await session.awaitClosed();
    // Pendant la grâce, l'unité admise attend sa réponse : pas de règlement prématuré.
    expect((await session.settle()).status).toBe("grace_pending");
    expect(d.rail.effects()).toEqual([]);
    d.advanceClock(GRACE_MS + 1);
    const settled = await session.settle();
    expect(settled.receipt).toMatchObject({ amountDue: "4", criteria: { earnedExchanges: 2 } });
    const third = d.db
      .prepare("SELECT state, void_reason FROM exchanges WHERE contract_id = ? AND seq = 3")
      .get(session.contractId);
    expect(third).toEqual({ state: "void", void_reason: "incomplete_after_grace_needs_review" });
    expect(d.rail.effects().map((e) => e.amount)).toEqual(["4"]);
  });
});

describe("message hostile du guest demandant de valider le paiement", { timeout: TIMEOUT }, () => {
  it("aucun effet financier ; présenté comme non fiable ; seul le compteur décide", async () => {
    const d = world();
    const session = await started(d, { guest: { script: "hostile" } });
    const hostile = session.transcript.find((m) => m.provenance === "agent");
    expect(hostile?.text).toMatch(/validate the payment/);
    expect(hostile?.trust).toBe("untrusted_remote_agent");
    // Rien n'a bougé côté règlement : le texte n'atteint jamais le service de séances.
    expect(d.service.status(session.contractId)).toMatchObject({
      state: "active",
      principalDue: null,
      settlement: null,
    });
    expect(count(d, "settlement_intents")).toBe(0);
    expect(count(d, "outbox")).toBe(0);
    expect(d.rail.effects()).toEqual([]);
    const dump = JSON.stringify(
      ["inbox", "journal", "exchanges"].map((t) => d.db.prepare(`SELECT * FROM ${t}`).all()),
    );
    expect(dump).not.toMatch(/validate|OVERRIDE|token/i);

    await session.exchange(
      "Je ne valide aucun paiement et je ne partage rien. Parlons de ta mesure.",
    );
    await session.requestClose();
    await session.awaitClosed();
    const settled = await session.settle();
    expect(settled.receipt).toMatchObject({ amountDue: "2", criteria: { earnedExchanges: 1 } });
    expect(d.rail.effects().map((e) => e.amount)).toEqual(["2"]);
  });
});

describe("H06 — confidentialité et provenance", { timeout: TIMEOUT }, () => {
  it("rien de privé ne traverse ; provenances distinguées ; checkpoints retrouvés côté agent", async () => {
    const d = world();
    const session = await started(d);
    for (const text of GUIDE_SCRIPT.slice(0, 2)) await session.exchange(text);
    await session.requestClose();
    await session.awaitClosed();
    const settled = await session.settle();

    // Côté guide : ni prompt, ni token, ni mémoire, ni chemin privé de l'agent.
    const guideView = session.guideOutputs.join("\n");
    for (const secret of [
      GUEST_PROMPT_MARKER,
      GUEST_PRIVATE_TOKEN,
      GUEST_MEMORY_MARKER,
      session.host.home,
      "owner.agent-c@example.invalid",
    ]) {
      expect(guideView).not.toContain(secret);
    }
    // Provenance : messages de l'agent non fiables, contributions humaines distinguées.
    const kinds = new Set(session.transcript.map((m) => `${m.provenance}:${m.trust}`));
    expect(kinds).toContain("agent:untrusted_remote_agent");
    expect(kinds).toContain("human:your_own_contribution");
    expect(
      session.transcript.every(
        (m) => m.provenance !== "agent" || m.author === session.agentPseudonym,
      ),
    ).toBe(true);

    // Reçu et registre de séances : aucun texte de conversation.
    const receipt = JSON.stringify(settled.receipt);
    for (const text of [...GUIDE_SCRIPT.slice(0, 2), "identical groups", "Follow-up"]) {
      expect(receipt).not.toContain(text);
    }
    const dump = JSON.stringify(
      ["inbox", "journal", "exchanges", "receipts"]
        .filter((t) => d.db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(t))
        .map((t) => d.db.prepare(`SELECT * FROM ${t}`).all()),
    );
    expect(dump).not.toContain("identical groups");
    expect(dump).not.toContain(GUIDE_SCRIPT[0].slice(0, 30));

    // Checkpoints : chaque échange acquis renvoie à une sauvegarde faite chez l'agent.
    const refs = (
      d.db
        .prepare(
          "SELECT checkpoint_ref FROM exchanges WHERE contract_id = ? AND state = 'earned' ORDER BY seq",
        )
        .all(session.contractId) as { checkpoint_ref: string }[]
    ).map((r) => r.checkpoint_ref);
    expect(refs).toHaveLength(2);
    const attested = readFileSync(session.host.checkpointsPath, "utf8");
    for (const ref of refs) expect(attested).toContain(ref);
    const memory = readFileSync(join(session.host.home, "memory.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string });
    expect(memory.filter((r) => r.type === "replied")).toHaveLength(2);
    expect(existsSync(join(session.host.home, "system-prompt.txt"))).toBe(true);
  });
});
