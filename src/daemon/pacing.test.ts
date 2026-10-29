/** Pilotage du quota : débit mesuré, ajustement de la marge, journal (horloge et jauge simulées). */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROFILE } from "../../test/fixtures/store-ledger/setup.js";
import type {
  AdapterId,
  AgentId,
  ProviderQuotaSnapshot,
  SubscriptionQuotaGuard,
  UtcTimestamp,
} from "../contracts/index.js";
import { planPacing } from "../policy/index.js";
import { openStore, type Store } from "../store/index.js";
import { QuotaPacingStore } from "./pacing.js";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-29T09:00:00.000Z");
const GUARD: Extract<SubscriptionQuotaGuard, { enabled: true }> = {
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
};

function snap(used: number, resetsAt: number, at: number, key = "primary"): ProviderQuotaSnapshot {
  return {
    windowKey: key,
    windowDurationMs: 5 * HOUR,
    usedBasisPoints: used,
    resetsAt: new Date(resetsAt).toISOString() as UtcTimestamp,
    observedAt: new Date(at).toISOString() as UtcTimestamp,
    provenance: "measured",
  };
}

let dir: string;
let store: Store;
let pacing: QuotaPacingStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mind-wake-pacing-"));
  store = openStore(path.join(dir, "control.sqlite"));
  store.uow.profiles.create({
    id: PROFILE,
    agentId: "agent-1" as AgentId,
    state: "disabled",
    activePolicyRevisionId: null,
    nextWakeAt: null,
    emergencyStopLocked: false,
    stateReason: "banc",
    updatedAt: new Date(T0).toISOString() as UtcTimestamp,
  });
  pacing = new QuotaPacingStore(store.db, store.uow, PROFILE, "codex" as AdapterId);
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function journal(reason: string): Record<string, unknown>[] {
  return store.uow.journal
    .list(PROFILE)
    .filter((e) => e.reason === reason)
    .map((e) => e.metadata as Record<string, unknown>);
}

describe("débit mesuré", () => {
  it("moyenne glissante par fenêtre, persistée, journalisée avec la projection", () => {
    const reset = T0 + 5 * HOUR;
    // 1 h de session : 6 000 → 6 800, soit 800 bp/h.
    pacing.recordSession(
      GUARD,
      [snap(6_000, reset, T0)],
      [snap(6_800, reset, T0 + HOUR)],
      T0,
      T0 + HOUR,
    );
    expect(pacing.estimates()).toEqual([
      { windowKey: "primary", rateBasisPointsPerHour: 800, marginRatio: 0.25, samples: 1 },
    ]);
    // Seconde mesure à 400 bp/h : 0,7 × 800 + 0,3 × 400 = 680.
    pacing.recordSession(
      GUARD,
      [snap(6_800, reset, T0 + HOUR)],
      [snap(7_200, reset, T0 + 2 * HOUR)],
      T0 + HOUR,
      T0 + 2 * HOUR,
    );
    expect(pacing.estimates()[0]?.rateBasisPointsPerHour).toBeCloseTo(680, 6);
    const measured = journal("quota.pacing_rate_measured");
    expect(measured).toHaveLength(2);
    // Projection à la remise à zéro : 7 200 + 680 × 3 h = 9 240 < 9 900 → en retard.
    expect(measured[1]).toMatchObject({
      projectedAtResetBp: 9_240,
      behind: true,
      rateSource: "measured",
    });
  });

  it("ignore une session trop courte, une fenêtre remise à zéro entre-temps ou un usage décroissant", () => {
    const reset = T0 + 5 * HOUR;
    pacing.recordSession(
      GUARD,
      [snap(6_000, reset, T0)],
      [snap(6_100, reset, T0)],
      T0,
      T0 + 60_000,
    );
    pacing.recordSession(
      GUARD,
      [snap(6_000, reset, T0)],
      [snap(500, reset + 5 * HOUR, T0 + HOUR)],
      T0,
      T0 + HOUR,
    );
    pacing.recordSession(
      GUARD,
      [snap(6_000, reset, T0)],
      [snap(5_000, reset, T0 + HOUR)],
      T0,
      T0 + HOUR,
    );
    expect(pacing.estimates().every((e) => e.rateBasisPointsPerHour === null)).toBe(true);
  });

  it("une estimation plus lente avance le réveil calculé", () => {
    const reset = T0 + 8 * HOUR;
    const current = [snap(5_900, reset, T0)];
    const before = planPacing(GUARD, current, T0, pacing.estimates());
    pacing.recordSession(
      GUARD,
      [snap(5_000, reset, T0)],
      [snap(5_250, reset, T0 + HOUR)],
      T0,
      T0 + HOUR,
    );
    const after = planPacing(GUARD, current, T0, pacing.estimates());
    expect(before?.rateSource).toBe("initial");
    expect(after?.rateSource).toBe("measured");
    expect(after?.wakeAtMs ?? 0).toBeLessThan(before?.wakeAtMs ?? 0);
  });
});

describe("ajustement de la marge à chaque fenêtre", () => {
  it("fenêtre close sous la cible : marge augmentée pour les fenêtres suivantes", () => {
    const first = T0 + 5 * HOUR;
    pacing.observe(GUARD, [snap(9_000, first, T0 + 4 * HOUR)], T0 + 4 * HOUR);
    pacing.observe(GUARD, [snap(9_500, first, first - 60_000)], first - 60_000);
    // Nouvelle fenêtre : l'usage final (9 500) est resté sous 9 900 − 50.
    pacing.observe(GUARD, [snap(100, first + 5 * HOUR, first + 1_000)], first + 1_000);
    expect(pacing.estimates()[0]?.marginRatio).toBeCloseTo(0.375, 6);
    expect(journal("quota.pacing_margin_adjusted")).toEqual([
      expect.objectContaining({ change: "increased", finalUsedBp: 9_500, targetBp: 9_900 }),
    ]);
  });

  it("cible atteinte plus d'une heure avant la remise à zéro : marge réduite", () => {
    const first = T0 + 5 * HOUR;
    pacing.observe(GUARD, [snap(9_900, first, T0 + 2 * HOUR)], T0 + 2 * HOUR);
    pacing.observe(GUARD, [snap(9_950, first, T0 + 3 * HOUR)], T0 + 3 * HOUR);
    pacing.observe(GUARD, [snap(0, first + 5 * HOUR, first + 1_000)], first + 1_000);
    expect(pacing.estimates()[0]?.marginRatio).toBeCloseTo(0.2, 6);
    expect(journal("quota.pacing_margin_adjusted")[0]).toMatchObject({ change: "decreased" });
  });

  it("cible atteinte juste avant la remise à zéro : marge inchangée, rien journalisé", () => {
    const first = T0 + 5 * HOUR;
    pacing.observe(GUARD, [snap(9_910, first, first - 30 * 60_000)], first - 30 * 60_000);
    pacing.observe(GUARD, [snap(0, first + 5 * HOUR, first + 1_000)], first + 1_000);
    expect(pacing.estimates()[0]?.marginRatio).toBe(0.25);
    expect(journal("quota.pacing_margin_adjusted")).toEqual([]);
  });

  it("chaque fenêtre (courte, hebdomadaire) a sa propre marge", () => {
    pacing.observe(
      GUARD,
      [snap(5_000, T0 + 5 * HOUR, T0), snap(3_000, T0 + 72 * HOUR, T0, "weekly")],
      T0,
    );
    expect(
      pacing
        .estimates()
        .map((e) => e.windowKey)
        .sort(),
    ).toEqual(["primary", "weekly"]);
  });
});
