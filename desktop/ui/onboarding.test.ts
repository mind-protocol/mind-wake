import { expect, it } from "vitest";
import { welcomeMessage, type WelcomeProgress } from "./onboarding.js";

it("distinguishes a saved human message from transmission and an observed exchange", () => {
  const base: WelcomeProgress = {
    stage: "reply_pending",
    settings: { model: "test", timeZone: "Europe/Paris", sources: [] },
  };
  expect(welcomeMessage(base)).toContain("enregistrée");
  expect(welcomeMessage({ ...base, evidence: { deliveredAt: "now" } })).toContain("transmise");
  expect(welcomeMessage({ ...base, stage: "complete" })).toContain("premier échange");
});
