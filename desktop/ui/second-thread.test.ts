import { expect, it } from "vitest";
import { secondThreadModel, secondThreadStatus, secondThreadIsWorking } from "./second-thread.js";

it("reads the separate second-thread transcript and states its mode", () => {
  const model = secondThreadModel({
    enabled: true,
    running: true,
    profile: "run",
    position: { projectId: "c", inBlock: 3 },
    lastTurn: { n: 4, outcome: null, endedAt: null },
    entries: [
      { id: 1, at: "2026-11-03T10:00:00Z", role: "human", text: "Salut", delivered: false },
      { id: 2, at: "2026-11-03T10:01:00Z", role: "agent", text: "**Fait**", projectId: "c" },
      { id: 3, at: "x", role: "intrus", text: "ignoré" },
    ],
  });
  expect(model?.entries.map((e) => e.role)).toEqual(["human", "agent"]);
  expect(model?.entries[0]?.delivered).toBe(false);
  if (model === null) throw Error("model expected");
  expect(secondThreadStatus(model)).toBe("Claude Code travaille sur c (3/10).");
  expect(secondThreadStatus({ ...model, enabled: false })).toContain("désactivé");
  expect(secondThreadStatus({ ...model, profile: "hold" })).toContain("pause");
  expect(secondThreadModel(null)).toBeNull();
});

it("only shows working for an active turn, including pause and stale-worker guards", () => {
  const state = {enabled:true, running:true, profile:"run", lastTurn:{endedAt:null, outcome:null}};
  const read = (changes: Record<string, unknown>) => secondThreadModel({...state,...changes})!;
  expect(secondThreadIsWorking(read({}))).toBe(true);
  for (const change of [{enabled:false},{running:false},{profile:"hold"},{profile:"stop"},{lastTurn:null}, {lastTurn:{endedAt:"2026-11-03T10:01:00Z",outcome:"completed"}}]) {
    expect(secondThreadIsWorking(read(change))).toBe(false);
    expect(secondThreadStatus(read(change))).not.toContain("travaille");
  }
  expect(secondThreadStatus(read({lastTurn:{endedAt:"2026-11-03T10:01:00Z", outcome:"rate_limited"}}))).toContain("attend le fournisseur");
});
