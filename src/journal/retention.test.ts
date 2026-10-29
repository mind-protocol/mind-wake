import { describe, expect, it } from "vitest";
import type {
  DataGroup,
  JournalEvent,
  ProfileId,
  SessionId,
  UtcTimestamp,
} from "../contracts/index.js";
import { planJournalPurge, retentionRuleFromPolicy, type RetentionRule } from "./retention.js";

const now = new Date("2026-10-29T12:00:00.000Z");
const rule: RetentionRule = { retentionDays: 30, automatic: true };

function event(sequence: number, daysAgo: number, sessionId?: string): JournalEvent {
  return {
    schemaVersion: 1,
    sequence,
    type: "action_allowed",
    at: new Date(now.getTime() - daysAgo * 86_400_000).toISOString() as UtcTimestamp,
    profileId: "default" as ProfileId,
    ...(sessionId !== undefined && { sessionId: sessionId as SessionId }),
    reason: "test",
    metadata: {},
  };
}

function data(overrides: Partial<DataGroup>): DataGroup {
  return {
    eventRetentionDays: 30,
    localStorageCapBytes: 1_000_000,
    purge: "retention_only",
    exportPaths: [],
    ...overrides,
  };
}

describe("règle de rétention", () => {
  it("refuse une durée invalide : aucune purge", () => {
    for (const days of [0, -1, 1.5, Number.NaN]) {
      expect(retentionRuleFromPolicy(data({ eventRetentionDays: days })).valid).toBe(false);
    }
  });

  it("n'applique automatiquement qu'en mode retention_only", () => {
    const manual = retentionRuleFromPolicy(data({ purge: "manual" }));
    const auto = retentionRuleFromPolicy(data({ purge: "retention_only" }));
    expect(manual.valid && manual.rule.automatic).toBe(false);
    expect(auto.valid && auto.rule.automatic).toBe(true);
  });
});

describe("plan de purge", () => {
  it("purge le préfixe expiré seulement", () => {
    const plan = planJournalPurge([event(1, 40), event(2, 35), event(3, 10), event(4, 50)], rule, {
      now,
    });
    expect(plan.throughSequence).toBe(2);
    expect(plan.purgeCount).toBe(2);
    expect(plan.keptCount).toBe(2);
    expect(plan.stoppedBy).toEqual({ kind: "not_expired", sequence: 3 });
    expect(plan.cutoff).toBe("2026-09-29T12:00:00.000Z");
  });

  it("trie par séquence avant de calculer", () => {
    const plan = planJournalPurge([event(2, 35), event(1, 40)], rule, { now });
    expect(plan.throughSequence).toBe(2);
    expect(plan.stoppedBy).toEqual({ kind: "end_of_journal" });
  });

  it("s'arrête sur une session protégée", () => {
    const plan = planJournalPurge([event(1, 40), event(2, 40, "s1"), event(3, 40)], rule, {
      now,
      protectedSessionIds: new Set(["s1" as SessionId]),
    });
    expect(plan.throughSequence).toBe(1);
    expect(plan.stoppedBy).toMatchObject({ kind: "protected_session", sessionId: "s1" });
  });

  it("s'arrête sur un horodatage illisible", () => {
    const broken = { ...event(2, 40), at: "pas une date" as UtcTimestamp };
    const plan = planJournalPurge([event(1, 40), broken, event(3, 40)], rule, { now });
    expect(plan.throughSequence).toBe(1);
    expect(plan.stoppedBy).toEqual({ kind: "unreadable_timestamp", sequence: 2 });
  });

  it("ne purge rien si rien n'est expiré, y compris à la limite exacte", () => {
    const plan = planJournalPurge([event(1, 30), event(2, 1)], rule, { now });
    expect(plan.throughSequence).toBeNull();
    expect(plan.purgeCount).toBe(0);
  });

  it("refuse une horloge invalide", () => {
    expect(() => planJournalPurge([event(1, 40)], rule, { now: new Date(Number.NaN) })).toThrow();
  });
});
