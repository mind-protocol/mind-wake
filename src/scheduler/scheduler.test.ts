/**
 * Scheduler sur SQLite réel avec horloge simulée, faits et lanceur factices (aucun
 * runner, aucun modèle, aucun daemon).
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROFILE,
  THURSDAY_10H_PARIS,
  bench,
  iso,
  seedProfile,
  type Bench,
  type SeedOptions,
} from "../../test/fixtures/scheduler/setup.js";
import { tempDir, type TempDir } from "../../test/fixtures/store-ledger/setup.js";
import {
  isProfileTransitionAllowed,
  type ProfileState,
  type UtcTimestamp,
} from "../contracts/index.js";
import { openStore, type Store } from "../store/index.js";
import { FakeClock } from "./clock.js";
import { InstanceLockError, acquireInstanceLock } from "./instance-lock.js";
import type { TickResult } from "./scheduler.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let dir: TempDir;
let store: Store;
let b: Bench;
let created = false;

function setup(seed: SeedOptions = {}, options: Parameters<typeof bench>[2] = {}): Bench {
  seedProfile(store.uow, seed);
  b = bench(store, join(dir.path, "scheduler.lock"), options);
  created = true;
  return b;
}

function state(): ProfileState {
  return store.uow.profiles.get(PROFILE)?.state ?? "disabled";
}

function nextWake(): UtcTimestamp | null {
  return store.uow.profiles.get(PROFILE)?.nextWakeAt ?? null;
}

async function tickFresh(): Promise<TickResult> {
  b.freshPriority();
  return b.scheduler.tick();
}

/** Chaque changement d'état journalisé respecte la table des transitions. */
function expectTransitionsAllowed(): void {
  for (const event of b.events("profile_state_changed")) {
    const { from, to } = event.metadata as { from: ProfileState; to: ProfileState };
    expect(isProfileTransitionAllowed(from, to), `${from} → ${to}`).toBe(true);
  }
}

beforeEach(() => {
  created = false;
  dir = tempDir();
  store = openStore(dir.dbPath);
});

afterEach(() => {
  if (created) b.close();
  store.close();
  dir.remove();
});

describe("réveil autorisé", () => {
  it("réserve, crée la session et passe en running dans une transaction, puis lance", async () => {
    setup();
    const result = await tickFresh();
    expect(result.kind).toBe("launched");
    expect(state()).toBe("running");
    expect(b.launcher.tickets).toHaveLength(1);
    const ticket = b.launcher.tickets[0];
    expect(ticket?.deadline).toBe(iso(THURSDAY_10H_PARIS + 600_000));
    expect(ticket?.maxima).toEqual([
      { unit: "tokens", amount: 3_000 },
      { unit: "sessions", amount: 1 },
    ]);
    const open = store.uow.sessions.listOpen(PROFILE);
    expect(open.map((s) => s.id)).toEqual([ticket?.sessionId]);
    expect(store.uow.ledger.getReservation(ticket?.reservationId ?? ("" as never))?.status).toBe(
      "open",
    );
    expect(b.events("budget_reserved")).toHaveLength(1);
    expect(b.events("profile_state_changed").map((e) => e.metadata)).toEqual([
      expect.objectContaining({ from: "ready", to: "running" }),
    ]);
    expect(nextWake()).toBeNull();
    expectTransitionsAllowed();
  });

  it("ne réévalue pas pendant une session en cours", async () => {
    setup();
    await tickFresh();
    expect(await tickFresh()).toMatchObject({ kind: "inactive" });
    expect(b.launcher.tickets).toHaveLength(1);
  });
});

describe("fenêtre horaire", () => {
  it("fenêtre fermée : hibernation sans session, réveil persisté à l'ouverture en UTC", async () => {
    setup({}, { clock: new FakeClock(Date.parse("2026-10-29T17:30:00Z")) }); // 18:30 Paris
    const result = await tickFresh();
    expect(result).toMatchObject({ kind: "denied", decision: { reason: "outside_window" } });
    expect(state()).toBe("hibernating");
    expect(nextWake()).toBe("2026-10-30T08:00:00.000Z");
    expect(b.launcher.tickets).toHaveLength(0);
    expect(store.uow.sessions.listOpen(PROFILE)).toHaveLength(0);
    expect(b.events("action_denied")).toHaveLength(1);

    // Avant l'échéance : rien, pas même un événement.
    b.clock.advance(10 * HOUR);
    expect(await tickFresh()).toMatchObject({ kind: "sleeping" });
    expect(b.events("action_denied")).toHaveLength(1);

    // À l'ouverture : hibernating → ready → running.
    b.clock.setWall(Date.parse("2026-10-30T08:00:00Z"));
    expect(await tickFresh()).toMatchObject({ kind: "launched" });
    const transitions = b.events("profile_state_changed").map((e) => e.metadata);
    expect(transitions.slice(-2)).toEqual([
      expect.objectContaining({ from: "hibernating", to: "ready" }),
      expect.objectContaining({ from: "ready", to: "running" }),
    ]);
    expectTransitionsAllowed();
  });

  it("calcule le réveil à travers le changement d'heure d'automne", async () => {
    // Samedi 24 octobre 18:00 CEST ; fenêtre du lundi 09:00 → 26 octobre 08:00Z (CET).
    setup(
      { schedule: { weeklyWindows: [{ day: 1, start: "09:00", end: "17:00" }] } },
      { clock: new FakeClock(Date.parse("2026-10-24T16:00:00Z")) },
    );
    await tickFresh();
    expect(nextWake()).toBe("2026-10-26T08:00:00.000Z");
  });

  it("après une veille du poste, une seule évaluation, sans rejouer les réveils manqués", async () => {
    setup();
    b.priority.set(false, b.clock.now());
    await b.scheduler.tick();
    expect(state()).toBe("hibernating");
    const deniedBefore = b.events("action_denied").length;

    // Trois jours de veille : l'horloge monotone ne compte pas ce temps.
    b.clock.sleep(3 * 24 * HOUR, 0);
    b.priority.set(false, b.clock.now());
    await b.scheduler.tick();
    await b.scheduler.tick();
    expect(b.events("action_denied").length).toBe(deniedBefore);
    expect(Date.parse(nextWake() ?? "")).toBeGreaterThan(b.clock.now());

    b.clock.advance(MINUTE);
    expect(await tickFresh()).toMatchObject({ kind: "launched" });
    expect(b.launcher.tickets).toHaveLength(1);
  });
});

describe("pause, arrêt et conditions inconnues", () => {
  it("pause : aucun réveil, aucun événement", async () => {
    setup({ state: "paused" });
    expect(await tickFresh()).toMatchObject({ kind: "inactive", state: "paused" });
    expect(b.launcher.tickets).toHaveLength(0);
    expect(b.events()).toHaveLength(0);
  });

  it("arrêt verrouillé : aucun réveil depuis stopped", async () => {
    setup({ state: "stopped", emergencyStopLocked: true });
    expect(await tickFresh()).toMatchObject({ kind: "inactive", state: "stopped" });
    expect(b.launcher.tickets).toHaveLength(0);
  });

  it("arrêt verrouillé sur un profil resté prêt : passage en stopped", async () => {
    setup({ emergencyStopLocked: true });
    expect(await tickFresh()).toMatchObject({ kind: "denied", decision: { reason: "stopped" } });
    expect(state()).toBe("stopped");
    expect(nextWake()).toBeNull();
    expectTransitionsAllowed();
  });

  it("budget inconnu : aucun lancement, blocage depuis ready, motif journalisé", async () => {
    // Ledger en erreur : aucune disponibilité établie, donc budget inconnu.
    setup();
    const ledger = store.uow.ledger;
    const original = ledger.ensurePeriodsCovering.bind(ledger);
    ledger.ensurePeriodsCovering = () => {
      throw new Error("ledger indisponible");
    };
    try {
      const result = await tickFresh();
      expect(result).toMatchObject({ kind: "denied", decision: { reason: "budget_unknown" } });
      expect(state()).toBe("blocked");
      expect(b.launcher.tickets).toHaveLength(0);
      expect(b.events("action_denied")[0]?.reason).toBe("budget_unknown");
    } finally {
      ledger.ensurePeriodsCovering = original;
    }
  });

  it("budget inconnu en hibernation : on y reste, sans session", async () => {
    setup({ state: "hibernating" });
    const ledger = store.uow.ledger;
    const original = ledger.ensurePeriodsCovering.bind(ledger);
    ledger.ensurePeriodsCovering = () => {
      throw new Error("ledger indisponible");
    };
    try {
      expect(await tickFresh()).toMatchObject({
        kind: "denied",
        state: "hibernating",
        decision: { reason: "budget_unknown" },
      });
      expect(store.uow.sessions.listOpen(PROFILE)).toHaveLength(0);
      expect(b.launcher.tickets).toHaveLength(0);
    } finally {
      ledger.ensurePeriodsCovering = original;
    }
  });

  it("budget épuisé : hibernation jusqu'à la période suivante dans une fenêtre", async () => {
    setup({ budget: { sessionsPerPeriod: 1 } });
    await tickFresh();
    b.launcher.finish({ outcome: "completed" });
    await b.scheduler.sessionInFlight;
    expect(state()).toBe("hibernating");
    b.clock.advance(MINUTE);
    const result = await tickFresh();
    expect(result).toMatchObject({ kind: "denied", decision: { reason: "budget_exhausted" } });
    // Fin de la journée de Paris (minuit CET), puis ouverture à 09:00.
    expect(nextWake()).toBe("2026-10-30T08:00:00.000Z");
  });

  it("signal de priorité périmé, absent ou en erreur : condition inconnue, pas de réveil", async () => {
    setup();
    b.priority.set(true, b.clock.now() - 20_000); // maxSignalAgeMs = 10 s
    const stale = await b.scheduler.tick();
    expect(stale).toMatchObject({ kind: "denied", decision: { reason: "unknown_condition" } });
    expect(stale.kind === "denied" ? stale.decision.detail : "").toContain("user_priority.stale");
    expect(state()).toBe("hibernating");
    expect(nextWake()).toBe(iso(b.clock.now() + MINUTE));

    for (const breakSignal of [
      () => {
        b.priority.unavailable();
      },
      () => {
        b.priority.fail(new Error("capteur"));
      },
    ]) {
      b.clock.advance(MINUTE);
      breakSignal();
      expect(await b.scheduler.tick()).toMatchObject({
        kind: "denied",
        decision: { reason: "unknown_condition" },
      });
    }
    expect(b.launcher.tickets).toHaveLength(0);
  });

  it("adapter en erreur ou muet : condition inconnue, bornée par le délai des faits", async () => {
    setup();
    b.environment.adapterFacts = "hang";
    expect(await tickFresh()).toMatchObject({
      kind: "denied",
      decision: { reason: "unknown_condition", detail: "adapter.unknown" },
    });
    b.clock.advance(MINUTE);
    b.environment.adapterFacts = "error";
    expect(await tickFresh()).toMatchObject({ decision: { detail: "adapter.unknown" } });
    expect(b.launcher.tickets).toHaveLength(0);
  });

  it("intervention requise depuis ready (sandbox indisponible) : blocked", async () => {
    setup();
    b.environment.sandbox = false;
    expect(await tickFresh()).toMatchObject({
      decision: { reason: "sandbox_unavailable" },
      state: "blocked",
    });
    expect(await tickFresh()).toMatchObject({ kind: "inactive", state: "blocked" });
    expectTransitionsAllowed();
  });

  it("reste calme : un refus identique n'est journalisé qu'une fois", async () => {
    setup();
    b.priority.set(false, b.clock.now());
    await b.scheduler.tick();
    for (let i = 0; i < 5; i++) {
      b.clock.advance(MINUTE);
      b.priority.set(false, b.clock.now());
      await b.scheduler.tick();
    }
    expect(b.events("action_denied")).toHaveLength(1);
    expect(b.events("profile_state_changed")).toHaveLength(1);
  });
});

describe("backoff et fin de session", () => {
  it("limitation : attend le délai officiel, puis relance", async () => {
    setup(
      {},
      { backoff: { baseDelayMs: MINUTE, maxDelayMs: 10 * MINUTE, maxConsecutiveFailures: 3 } },
    );
    await tickFresh();
    b.launcher.finish({
      outcome: "interrupted",
      failure: { kind: "rate_limited", retryAfterMs: 5 * MINUTE },
    });
    await b.scheduler.sessionInFlight;
    expect(state()).toBe("hibernating");
    expect(nextWake()).toBe(iso(THURSDAY_10H_PARIS + 5 * MINUTE));
    expect(b.events("rate_limited")).toHaveLength(1);

    b.clock.advance(4 * MINUTE);
    expect(await tickFresh()).toMatchObject({ kind: "sleeping" });
    b.clock.advance(MINUTE);
    expect(await tickFresh()).toMatchObject({ kind: "launched" });
    expectTransitionsAllowed();
  });

  it("un saut de l'horloge murale n'abrège pas un backoff en cours (horloge monotone)", async () => {
    setup(
      {},
      { backoff: { baseDelayMs: 5 * MINUTE, maxDelayMs: HOUR, maxConsecutiveFailures: 3 } },
    );
    await tickFresh();
    b.launcher.finish({ outcome: "failed", failure: { kind: "transient", detail: "x" } });
    await b.scheduler.sessionInFlight;
    b.clock.setWall(b.clock.now() + 2 * HOUR); // réglage d'horloge, pas d'écoulement réel
    expect(await tickFresh()).toMatchObject({
      kind: "denied",
      decision: { reason: "backoff_active" },
    });
    b.clock.advance(5 * MINUTE);
    expect(await tickFresh()).toMatchObject({ kind: "launched" });
  });

  it("plafond de tentatives consécutives : blocked", async () => {
    setup({}, { backoff: { baseDelayMs: MINUTE, maxDelayMs: MINUTE, maxConsecutiveFailures: 2 } });
    for (let i = 0; i < 2; i++) {
      expect(await tickFresh()).toMatchObject({ kind: "launched" });
      b.launcher.finish({ outcome: "failed", failure: { kind: "transient", detail: "x" } });
      await b.scheduler.sessionInFlight;
      expect(state()).toBe("hibernating");
      b.clock.advance(MINUTE);
    }
    await tickFresh();
    b.launcher.finish({ outcome: "failed", failure: { kind: "transient", detail: "x" } });
    await b.scheduler.sessionInFlight;
    expect(state()).toBe("blocked");
    b.clock.advance(HOUR);
    expect(await tickFresh()).toMatchObject({ kind: "inactive", state: "blocked" });
    expect(b.launcher.tickets).toHaveLength(3);
    expectTransitionsAllowed();
  });

  it("échec d'authentification : blocage immédiat", async () => {
    setup();
    await tickFresh();
    b.launcher.finish({ outcome: "failed", failure: { kind: "auth_failed", detail: "401" } });
    await b.scheduler.sessionInFlight;
    expect(state()).toBe("blocked");
  });

  it("succès : remet le compteur à zéro et respecte l'intervalle minimal", async () => {
    setup({ schedule: { minIntervalBetweenSessionsMs: 30 * MINUTE } });
    await tickFresh();
    b.launcher.finish({ outcome: "completed" });
    await b.scheduler.sessionInFlight;
    expect(nextWake()).toBe(iso(THURSDAY_10H_PARIS + 30 * MINUTE));
    b.clock.advance(30 * MINUTE);
    expect(await tickFresh()).toMatchObject({ kind: "launched" });
  });

  it("lanceur en échec : état incertain, blocked, session laissée à la réconciliation", async () => {
    setup();
    await tickFresh();
    b.launcher.pending.shift()?.reject(new Error("runner"));
    await b.scheduler.sessionInFlight;
    expect(state()).toBe("blocked");
    expect(store.uow.sessions.listOpen(PROFILE)).toHaveLength(1);
  });

  it("runner qui laisse le profil en running : blocked", async () => {
    setup();
    await tickFresh();
    b.launcher.finish({ outcome: "completed" }, "running");
    await b.scheduler.sessionInFlight;
    expect(state()).toBe("blocked");
    expectTransitionsAllowed();
  });
});

describe("concurrence et redémarrage", () => {
  it("verrou d'instance : un second scheduler du même profil est refusé", () => {
    setup();
    expect(() => acquireInstanceLock(b.lock.path)).toThrow(InstanceLockError);
    b.lock.release();
    const again = acquireInstanceLock(b.lock.path);
    again.release();
  });

  it("deux schedulers sans verrou commun sur une même base : un seul lancement", async () => {
    setup();
    const other = openStore(dir.dbPath);
    const second = bench(other, join(dir.path, "other.lock"), {
      clock: b.clock,
      idPrefix: "t",
    });
    try {
      b.freshPriority();
      second.freshPriority();
      const results = await Promise.all([b.scheduler.tick(), second.scheduler.tick()]);
      expect(results.filter((r) => r.kind === "launched")).toHaveLength(1);
      expect(b.launcher.tickets.length + second.launcher.tickets.length).toBe(1);
      expect(store.uow.sessions.listOpen(PROFILE)).toHaveLength(1);
    } finally {
      second.close();
      other.close();
    }
  });

  it("redémarrage après crash : réconciliation demandée, aucun double lancement", async () => {
    setup();
    await tickFresh();
    expect(state()).toBe("running");
    // Crash : le processus disparaît sans clore la session ni rapporter sa fin.
    b.close();
    store.close();

    store = openStore(dir.dbPath);
    b = bench(store, join(dir.path, "scheduler.lock"), { clock: b.clock, idPrefix: "r" });
    expect(await b.scheduler.recover()).toBe(true);
    expect(b.launcher.reconcileCalls).toBe(1);
    expect(b.events("orphan_reconciled")).toHaveLength(1);
    expect(await tickFresh()).toMatchObject({ kind: "inactive", state: "running" });
    expect(b.launcher.tickets).toHaveLength(0);
    expect(store.uow.sessions.listOpen(PROFILE)).toHaveLength(1);
  });

  it("démarrage propre : aucune réconciliation", async () => {
    setup({ state: "hibernating" });
    expect(await b.scheduler.recover()).toBe(false);
    expect(b.launcher.reconcileCalls).toBe(0);
  });
});

describe("boucle", () => {
  it("dort jusqu'à l'échéance, plafonnée par l'intervalle de réévaluation", async () => {
    setup({}, { clock: new FakeClock(Date.parse("2026-10-29T17:30:00Z")) });
    const sleeps: number[] = [];
    const controller = new AbortController();
    const loop = bench(store, join(dir.path, "loop.lock"), {
      clock: b.clock,
      idPrefix: "l",
      overrides: {
        sleep: (ms) => {
          sleeps.push(ms);
          if (sleeps.length >= 2) controller.abort();
          return Promise.resolve();
        },
      },
    });
    try {
      loop.freshPriority();
      await loop.scheduler.run(controller.signal);
      expect(sleeps).toEqual([MINUTE, MINUTE]);
      expect(state()).toBe("hibernating");
    } finally {
      loop.close();
    }
  });
});

describe("voie abonnement : pilotage vers la cible (ADR-005, complément)", () => {
  // Cible 99 %, réserve humaine 0 (choix de l'utilisateur : le quota non utilisé est perdu).
  const GUARD = {
    enabled: true,
    accountRiskAcknowledged: true,
    startBelowBasisPoints: 9_800,
    stopAtBasisPoints: 9_900,
    userReserveBasisPoints: 0,
    overshootBoundBasisPoints: 100,
    maxSnapshotAgeMs: 60_000,
    targetUsageBasisPoints: 9_900,
    initialRateBasisPointsPerHour: 1_000,
    pacingMarginRatio: 0.25,
  } as const;

  /** Jauge lue « maintenant » sur l'horloge simulée ; `used` peut évoluer entre deux tours. */
  function gauge(windows: () => readonly { key: string; used: number; resetsAt: number }[]): void {
    b.environment.quota = () =>
      windows().map((w) => ({
        windowKey: w.key,
        windowDurationMs: 5 * HOUR,
        usedBasisPoints: w.used,
        resetsAt: iso(w.resetsAt),
        observedAt: iso(b.clock.now()),
        provenance: "measured" as const,
      }));
  }

  function pacingSetup(seed: SeedOptions = {}): void {
    setup({ ...seed, budget: { subscriptionQuota: GUARD, ...seed.budget } });
    b.environment.billingFacts = { kind: "subscription_quota" };
    const facts = b.environment.adapterFacts;
    if (typeof facts !== "object") throw new Error("faits d'adapter attendus");
    b.environment.adapterFacts = {
      ...facts,
      capabilities: {
        ...facts.capabilities,
        tokenCapEnforcement: "provider_quota_guard",
        providerQuotaReading: "official",
      },
    };
  }

  const RESET = THURSDAY_10H_PARIS + 8 * HOUR;

  it("réveil au bon moment : (cible − usage) / débit × (1 + marge) avant la remise à zéro", async () => {
    pacingSetup();
    gauge(() => [{ key: "primary", used: 5_900, resetsAt: RESET }]);
    // 4 000 bp à 1 000 bp/h = 4 h, × 1,25 = 5 h avant 17:00Z → réveil à 12:00Z.
    expect(await tickFresh()).toMatchObject({
      kind: "denied",
      decision: {
        reason: "outside_window",
        detail: expect.stringContaining("wake_at=2026-10-29T12:00:00.000Z") as unknown,
      },
    });
    expect(state()).toBe("hibernating");
    // Réévaluation au plus tard après 15 min : le réveil peut encore avancer.
    expect(nextWake()).toBe(iso(THURSDAY_10H_PARIS + 15 * MINUTE));
    b.clock.setWall(THURSDAY_10H_PARIS + 3 * HOUR - MINUTE);
    expect(await tickFresh()).toMatchObject({ kind: "denied" });
    b.clock.setWall(THURSDAY_10H_PARIS + 3 * HOUR);
    expect(await tickFresh()).toMatchObject({ kind: "launched" });
    expect(b.launcher.tickets[0]?.maxima).toEqual([{ unit: "sessions", amount: 1 }]);
  });

  it("en continu jusqu'à la cible, sans délai minimal, puis attente de la remise à zéro", async () => {
    pacingSetup({ schedule: { minIntervalBetweenSessionsMs: 30 * MINUTE } });
    let used = 6_000;
    gauge(() => [{ key: "primary", used, resetsAt: THURSDAY_10H_PARIS + 4 * HOUR }]);
    expect(await tickFresh()).toMatchObject({ kind: "launched" });
    b.clock.advance(HOUR);
    used = 7_000;
    b.launcher.finish({ outcome: "completed" });
    await b.scheduler.sessionInFlight;
    // Pas d'intervalle minimal sous la garde : la session suivante part aussitôt.
    expect(await tickFresh()).toMatchObject({ kind: "launched" });
    b.clock.advance(2 * HOUR);
    used = 9_900;
    b.launcher.finish({ outcome: "completed" });
    await b.scheduler.sessionInFlight;
    expect(await tickFresh()).toMatchObject({
      kind: "denied",
      decision: {
        reason: "budget_exhausted",
        detail: expect.stringContaining("target_reached: primary") as unknown,
      },
    });
    expect(nextWake()).toBe(iso(THURSDAY_10H_PARIS + 4 * HOUR));
    expect(b.launcher.tickets).toHaveLength(2);
  });

  it("débit mesuré plus lent que prévu : le réveil avance (rattrapage)", async () => {
    pacingSetup();
    gauge(() => [{ key: "primary", used: 5_900, resetsAt: RESET }]);
    expect(await tickFresh()).toMatchObject({ kind: "denied" });
    b.clock.setWall(THURSDAY_10H_PARIS + 15 * MINUTE);
    // Mesure : 450 bp/h → 4 000 / 450 × 1,25 ≈ 11 h > 7 h 45 restantes : réveil immédiat.
    b.environment.estimates = [
      { windowKey: "primary", rateBasisPointsPerHour: 450, marginRatio: 0.25, samples: 2 },
    ];
    expect(await tickFresh()).toMatchObject({ kind: "launched" });
  });

  it("interruption par l'humain puis reprise : la priorité humaine prime sur le pilotage", async () => {
    pacingSetup();
    gauge(() => [{ key: "primary", used: 5_900, resetsAt: THURSDAY_10H_PARIS + 4 * HOUR }]);
    b.priority.set(false, b.clock.now());
    expect(await b.scheduler.tick()).toMatchObject({
      kind: "denied",
      decision: { reason: "user_priority" },
    });
    expect(b.launcher.tickets).toHaveLength(0);
    b.clock.advance(MINUTE);
    expect(await tickFresh()).toMatchObject({ kind: "launched" });
  });

  it("deux fenêtres : pilote celle qui se remet à zéro le plus tôt, sans dépasser l'autre", async () => {
    pacingSetup();
    let weekly = 9_700;
    gauge(() => [
      { key: "weekly", used: weekly, resetsAt: THURSDAY_10H_PARIS + 72 * HOUR },
      { key: "primary", used: 5_900, resetsAt: THURSDAY_10H_PARIS + 4 * HOUR },
    ]);
    expect(await tickFresh()).toMatchObject({ kind: "launched" });
    b.clock.advance(HOUR);
    weekly = 9_800;
    b.launcher.finish({ outcome: "completed" });
    await b.scheduler.sessionInFlight;
    expect(await tickFresh()).toMatchObject({
      kind: "denied",
      decision: {
        reason: "budget_exhausted",
        detail: expect.stringContaining("start_threshold_reached: weekly") as unknown,
      },
    });
  });

  it("lecture absente : runtime bloqué avec motif, rien n'est réservé", async () => {
    pacingSetup();
    expect(await tickFresh()).toMatchObject({
      kind: "denied",
      state: "blocked",
      decision: { reason: "budget_unknown", detail: "subscription.quota_unknown" },
    });
    expect(b.events("budget_reserved")).toHaveLength(0);
  });

  it("jauge de nouveau lisible : blocked → ready, puis tout est revérifié", async () => {
    pacingSetup();
    await tickFresh();
    expect(state()).toBe("blocked");

    // Toujours illisible : on reste bloqué, sans rien réserver.
    expect(await tickFresh()).toMatchObject({
      kind: "inactive",
      detail: "subscription.quota_unknown",
    });
    expect(state()).toBe("blocked");

    gauge(() => [{ key: "primary", used: 2_000, resetsAt: RESET }]);
    expect(await tickFresh()).toMatchObject({ kind: "inactive", state: "ready" });
    expect(state()).toBe("ready");
    expect(b.launcher.tickets).toHaveLength(0);
    // Le tour suivant repasse par decideLaunch avec la jauge lue.
    expect(["launched", "denied"]).toContain((await tickFresh()).kind);
    expectTransitionsAllowed();
  });

  it("autre motif de blocage : une jauge lisible ne débloque rien", async () => {
    pacingSetup();
    const observed = b.clock.now() - 2 * MINUTE;
    b.environment.quota = () => [
      {
        windowKey: "primary",
        windowDurationMs: 5 * HOUR,
        usedBasisPoints: 1_000,
        resetsAt: iso(RESET),
        observedAt: iso(observed),
        provenance: "measured",
      },
    ];
    await tickFresh();
    expect(state()).toBe("blocked");
    gauge(() => [{ key: "primary", used: 2_000, resetsAt: RESET }]);
    expect(await tickFresh()).toMatchObject({ kind: "inactive", state: "blocked" });
    expect(b.launcher.tickets).toHaveLength(0);
  });

  it("sans lecture officielle de la jauge : bloqué en mode autonome", async () => {
    pacingSetup();
    const facts = b.environment.adapterFacts;
    if (typeof facts !== "object") throw new Error("faits d'adapter attendus");
    b.environment.adapterFacts = {
      ...facts,
      capabilities: { ...facts.capabilities, providerQuotaReading: "none" },
    };
    gauge(() => [{ key: "primary", used: 1_000, resetsAt: THURSDAY_10H_PARIS + HOUR }]);
    expect(await tickFresh()).toMatchObject({
      state: "blocked",
      decision: { reason: "bound_not_enforceable" },
    });
  });
});

describe("réveils demandés par l'agent : échéance candidate, jamais une autorisation", () => {
  function withRequest(dueAt: () => number | null, seed: SeedOptions = {}): void {
    setup(seed, {
      overrides: { wakeRequests: { nextRequestedWake: () => Promise.resolve(dueAt()) } },
    });
    store.uow.profiles.setNextWake(PROFILE, iso(THURSDAY_10H_PARIS + 6 * HOUR));
  }

  it("avance un réveil permis : évaluation et lancement avant l'échéance persistée", async () => {
    withRequest(() => THURSDAY_10H_PARIS - MINUTE, { state: "hibernating" });
    expect(await tickFresh()).toMatchObject({ kind: "launched" });
    expect(b.launcher.tickets).toHaveLength(1);
  });

  it("une demande à venir raccourcit seulement la veille", async () => {
    withRequest(() => THURSDAY_10H_PARIS + HOUR, { state: "hibernating" });
    expect(await tickFresh()).toEqual({
      kind: "sleeping",
      nextWakeAt: iso(THURSDAY_10H_PARIS + HOUR),
    });
    expect(b.launcher.tickets).toHaveLength(0);
  });

  it("demande due hors fenêtre ou sous priorité humaine : toujours refusée", async () => {
    withRequest(() => 0, { state: "hibernating", schedule: { weeklyWindows: [] } });
    expect(await tickFresh()).toMatchObject({
      kind: "denied",
      decision: { reason: "outside_window" },
    });
    expect(b.launcher.tickets).toHaveLength(0);
    b.close();
    created = false;
    store.close();
    dir.remove();
    dir = tempDir();
    store = openStore(dir.dbPath);
    withRequest(() => 0, { state: "hibernating" });
    b.priority.set(false, b.clock.now());
    expect(await b.scheduler.tick()).toMatchObject({
      kind: "denied",
      decision: { reason: "user_priority" },
    });
    expect(b.launcher.tickets).toHaveLength(0);
  });

  it("pendant une pause ou après un arrêt d'urgence : sans effet", async () => {
    let asked = 0;
    setup(
      { state: "paused" },
      {
        overrides: {
          wakeRequests: {
            nextRequestedWake: () => {
              asked += 1;
              return Promise.resolve(0);
            },
          },
        },
      },
    );
    expect(await tickFresh()).toMatchObject({ kind: "inactive", state: "paused" });
    transitionTo("stopped");
    expect(await tickFresh()).toMatchObject({ kind: "inactive", state: "stopped" });
    expect(b.launcher.tickets).toHaveLength(0);
    expect(asked).toBe(0);
  });

  it("une source en erreur vaut « aucune demande »", async () => {
    setup(
      { state: "hibernating" },
      {
        overrides: {
          wakeRequests: { nextRequestedWake: () => Promise.reject(new Error("illisible")) },
        },
      },
    );
    store.uow.profiles.setNextWake(PROFILE, iso(THURSDAY_10H_PARIS + 6 * HOUR));
    expect(await tickFresh()).toMatchObject({ kind: "sleeping" });
  });
});

function transitionTo(to: ProfileState): void {
  store.uow.profiles.transition(PROFILE, {
    from: state(),
    to,
    reason: "banc",
    at: iso(THURSDAY_10H_PARIS),
  });
}
