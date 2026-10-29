import { describe, expect, it } from "vitest";
import {
  assertBackoffPolicy,
  decideAfterFailure,
  exponentialDelay,
  type BackoffPolicy,
} from "./backoff.js";

const POLICY: BackoffPolicy = { baseDelayMs: 1_000, maxDelayMs: 10_000, maxConsecutiveFailures: 3 };

describe("backoff borné", () => {
  it("double le délai jusqu'au plafond", () => {
    expect([1, 2, 3, 4, 5, 60].map((n) => exponentialDelay(POLICY, n))).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
    ]);
  });

  it("respecte le délai officiel du fournisseur, même au-delà du plafond", () => {
    const longer = decideAfterFailure(POLICY, 0, { kind: "rate_limited", retryAfterMs: 90_000 });
    expect(longer).toMatchObject({ action: "wait", delayMs: 90_000, consecutiveFailures: 1 });
    const shorter = decideAfterFailure(POLICY, 1, { kind: "rate_limited", retryAfterMs: 10 });
    expect(shorter).toMatchObject({ action: "wait", delayMs: 2_000 });
    const none = decideAfterFailure(POLICY, 0, { kind: "rate_limited", retryAfterMs: null });
    expect(none).toMatchObject({ action: "wait", delayMs: 1_000 });
  });

  it("bloque au-delà du plafond de tentatives consécutives", () => {
    expect(decideAfterFailure(POLICY, 2, { kind: "transient", detail: "x" })).toMatchObject({
      action: "wait",
      consecutiveFailures: 3,
    });
    expect(decideAfterFailure(POLICY, 3, { kind: "transient", detail: "x" })).toMatchObject({
      action: "block",
      consecutiveFailures: 4,
    });
    expect(decideAfterFailure(POLICY, 3, { kind: "rate_limited", retryAfterMs: 5 })).toMatchObject({
      action: "block",
    });
  });

  it("bloque immédiatement sur échec d'authentification, incompatibilité ou erreur fatale", () => {
    for (const kind of ["auth_failed", "incompatible", "fatal"] as const) {
      expect(decideAfterFailure(POLICY, 0, { kind, detail: "x" })).toMatchObject({
        action: "block",
        detail: `failure.${kind}`,
      });
    }
  });

  it("refuse une politique incohérente", () => {
    expect(() => {
      assertBackoffPolicy({ baseDelayMs: 0, maxDelayMs: 1, maxConsecutiveFailures: 1 });
    }).toThrow(RangeError);
    expect(() => {
      assertBackoffPolicy({ baseDelayMs: 10, maxDelayMs: 5, maxConsecutiveFailures: 1 });
    }).toThrow(RangeError);
    expect(() => {
      assertBackoffPolicy({ baseDelayMs: 10, maxDelayMs: 50, maxConsecutiveFailures: 0 });
    }).toThrow(RangeError);
  });
});
