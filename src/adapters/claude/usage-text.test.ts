import { describe, expect, it } from "vitest";
import { parseStreamLine, usageTextLimits } from "./stream.js";

const TEXT = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current session: 76% used · resets Oct 29, 9:59pm (Europe/Paris)",
  "Current week (all models): 61% used · resets Nov 3, 11:59am (Europe/Paris)",
  "Current week (Fable): 0% used · resets Nov 3, 11:59am (Europe/Paris)",
].join("\n");

const NOW = new Date("2026-10-29T19:33:00Z");

function line(withLimits: boolean): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: TEXT }] },
    usage_report: withLimits ? { rate_limits: { limits: [] } } : {},
  });
}

describe("/usage : compteurs lus dans le texte quand rate_limits manque", () => {
  it("session, semaine tous modèles et semaine par modèle, heure de Paris convertie en UTC", () => {
    const message = JSON.parse(line(false)) as Record<string, unknown>;
    expect(usageTextLimits(message, NOW)).toEqual([
      { kind: "session", percent: 76, resetsAt: "2026-10-29T20:59:00.000Z", scope: null },
      { kind: "weekly_all", percent: 61, resetsAt: "2026-11-03T10:59:00.000Z", scope: null },
      { kind: "weekly_scoped", percent: 0, resetsAt: "2026-11-03T10:59:00.000Z", scope: "Fable" },
    ]);
  });

  it("parseStreamLine : rate_limits absent → lignes du texte ; présent → inchangé", () => {
    const fromText = parseStreamLine(line(false));
    expect(fromText).toMatchObject({ kind: "usage_report" });
    if (fromText.kind === "usage_report") expect(fromText.limits?.length).toBe(3);
    expect(parseStreamLine(line(true))).toEqual({ kind: "usage_report", limits: [] });
  });

  it("texte sans compteur lisible : jauge toujours inconnue", () => {
    const message = { message: { content: [{ type: "text", text: "Usage unavailable" }] } };
    expect(usageTextLimits(message, NOW)).toEqual([]);
  });
});
