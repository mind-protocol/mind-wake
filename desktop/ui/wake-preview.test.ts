import { expect, it } from "vitest";
import { wakePreviewModel, wakeCards } from "./wake-preview.js";
it("groups complete project blocks into movable cards and locks reserved or partial blocks", () => {
  const model = wakePreviewModel({state:"ready", revision:7, wakes:Array.from({length:25}, (_, i) => ({
    number:i + 1, day:1, inBlock:i % 10 + 1, projectId:i < 20 ? "a" : "b", title:"Projet complet",
    phase:i % 10 === 0 ? "prepare" : "work", state:i === 0 ? "reserved" : "planned", objective:i % 2 ? "Faire" : "  "
  }))});
  const cards = wakeCards(model.wakes);
  expect(cards.map(card => card.wakes.length)).toEqual([10,10,5]);
  expect(cards.map(card => card.movable)).toEqual([false,true,false]);
  expect(cards[1]?.wakes.filter(wake => !wake.objective)).toHaveLength(5);
  expect(model.revision).toBe(7);
});
it("counts the actual phases and defined intentions separately from project names", () => {
  const model = wakePreviewModel({ state: "ready", completed: 15, wakes: [
    { number: 16, day: 1, inBlock: 6, projectId: "a", title: "Recherche", phase: "work", objective: "Examiner les résultats", state: "running" },
    { number: 21, day: 1, inBlock: 1, projectId: "b", title: "Créer", phase: "prepare" },
    { number: 22, day: 1, inBlock: 2, projectId: null, title: "Piste libre", phase: "free" },
  ] });
  expect(model.counts).toEqual({ work: 1, prepare: 1, free: 1 });
  expect(model.defined).toBe(1); expect(model.projects).toBe(2);
  expect(model.wakes[0]?.state).toBe("running");
});
it("keeps unavailable and disabled data distinct and rejects malformed/duplicate slots", () => {
  expect(wakePreviewModel(null).state).toBe("unavailable");
  expect(wakePreviewModel({ state: "disabled", wakes: [] }).state).toBe("disabled");
  const wake = { number: 1, day: 1, inBlock: 1, title: "Projet", phase: "prepare" };
  const model = wakePreviewModel({ state: "ready", wakes: [wake, wake, { ...wake, number: 2, phase: "invented" }] });
  expect(model.wakes).toHaveLength(1); expect(model.counts.prepare).toBe(1);
});
