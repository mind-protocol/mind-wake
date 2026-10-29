import { describe, expect, it } from "vitest";
import { activityModel } from "./activity.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const DAY = 86_400_000;

function journal(events: unknown[]): unknown {
  return {
    schema: "mind-wake.cli",
    schemaVersion: 1,
    command: "journal",
    ok: true,
    data: { events },
  };
}

function ev(type: string, sessionId: string, at: string, metadata: Record<string, unknown> = {}) {
  return { type, sessionId, at, metadata };
}

describe("activityModel", () => {
  it("associe réveil et consommation d'une même session ; inconnu ≠ zéro", () => {
    const model = activityModel(
      journal([
        ev("session_started", "s1", "2026-10-29T08:00:00Z"),
        ev("session_ended", "s1", "2026-10-29T08:05:00Z", {
          tokens: 1200,
          outcome: "completed",
          simulated: true,
          provenance: "simulated",
        }),
        ev("session_started", "s2", "2026-10-29T10:00:00Z"),
        ev("session_ended", "s2", "2026-10-29T10:01:00Z", { outcome: "interrupted" }),
        ev("profile_state_changed", "s9", "2026-10-29T10:02:00Z"),
      ]),
      NOW,
      DAY,
    );
    expect(model?.sessions.map((s) => [s.sessionId, s.tokens])).toEqual([
      ["s1", 1200],
      ["s2", null],
    ]);
    expect(model?.totalKnownTokens).toBe(1200);
    expect(model?.unknownCount).toBe(1);
    expect(model?.simulated).toBe(true);
  });

  it("une session en cours (réveil sans fin) apparaît sans consommation", () => {
    const model = activityModel(
      journal([ev("session_started", "s3", "2026-10-29T11:59:00Z")]),
      NOW,
      DAY,
    );
    expect(model?.sessions[0]).toMatchObject({ endedAt: null, tokens: null });
  });

  it("hors de la fenêtre ou enveloppe invalide", () => {
    const old = activityModel(
      journal([ev("session_started", "s0", "2026-10-27T08:00:00Z")]),
      NOW,
      DAY,
    );
    expect(old?.sessions).toHaveLength(0);
    expect(activityModel({ schema: "autre" }, NOW, DAY)).toBeNull();
  });
});
