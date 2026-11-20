import { expect, it } from "vitest";
import { looksLikeError } from "./app-error-report.js";
import { autoCallSummary } from "./auto-call.js";

it("shows the next call time and the last outcome", () => {
  const next = new Date(2026, 10, 20, 13, 40).toISOString();
  const last = new Date(2026, 10, 20, 13, 30).toISOString();
  expect(autoCallSummary({ enabled: true, nextAt: next, lastOutcome: "lancé", lastAt: last }))
    .toBe("prochain appel à 13:40 · dernier : lancé à 13:30");
  expect(autoCallSummary({ enabled: false, nextAt: null, lastOutcome: null, lastAt: null })).toBe("désactivé");
});

it("does not present a declined ring as an app error, but keeps real failures visible", () => {
  const at = new Date(2026, 10, 20, 18, 36).toISOString();
  const declined = autoCallSummary({ enabled: true, nextAt: at, lastOutcome: "sans réponse (refusé)", lastAt: at });
  expect(declined).toContain("sans réponse (décliné)");
  expect(looksLikeError(declined)).toBe(false);
  expect(looksLikeError(autoCallSummary({ enabled: true, nextAt: at, lastOutcome: "sauté (échec : sonnerie)", lastAt: at }))).toBe(true);
});
