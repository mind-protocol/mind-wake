import { expect, it } from "vitest";
import { autoCallSummary } from "./auto-call.js";

it("shows the next call time and the last outcome", () => {
  const next = new Date(2026, 10, 20, 13, 40).toISOString();
  const last = new Date(2026, 10, 20, 13, 30).toISOString();
  expect(autoCallSummary({ enabled: true, nextAt: next, lastOutcome: "lancé", lastAt: last }))
    .toBe("prochain appel à 13:40 · dernier : lancé à 13:30");
  expect(autoCallSummary({ enabled: false, nextAt: null, lastOutcome: null, lastAt: null })).toBe("désactivé");
});
