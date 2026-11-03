/** Rotation fixtures only: no provider calls. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WakeManager, contextPath, WAKE_MANAGER_INSTRUCTIONS, readCurrentWakeObjective } from "./wake-manager.js";
import { updatePromptImprovementProject, PROMPT_IMPROVEMENT_PROJECT } from "./prompt-improvement-project.js";
import { readCounter, readCurrentProject } from "./project-change.js";
let dir: string, manager: WakeManager;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-manager-"));
  fs.mkdirSync(path.join(dir, "artifacts"));
  registry(["a", "b", "c"]);
  manager = new WakeManager(dir);
  manager.configure(true);
});
afterEach(() => {
  manager.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
function registry(ids: string[]) {
  fs.writeFileSync(
    path.join(dir, "artifacts/projets-compteur.json"),
    JSON.stringify({
      current: ids[0],
      projects: Object.fromEntries(
        ids.map((id) => [id, { status: "en cours", title: `Project ${id}` }]),
      ),
    }),
  );
}
function complete(id: string) {
  const wake = manager.reserve(id);
  manager.started(id);
  manager.finish(id, "completed", { journalSessionId: id });
  return wake;
}
function futureBlocks() {
  const pending = manager.pending();
  const wakes = manager.next(500).wakes;
  return wakes.filter(w => w.inBlock === 1 && (!pending || w.sessionId !== pending.sessionId) &&
    wakes.some(end => end.number === w.number + 9 && end.projectId === w.projectId && end.inBlock === 10)).map(w => w.projectId!);
}
it("persists a reordered queue and executes it without preview consumption or lost blocks", () => {
  const order = futureBlocks();
  const [first] = order.splice(0, 1); order.splice(2, 0, first!);
  manager.reorderBlocks(order, manager.status()!.revision);
  expect(manager.status()?.used).toBe(0);
  expect(manager.next(30).wakes.filter(w => w.inBlock === 1).map(w => w.projectId)).toEqual(order.slice(0, 3));
  manager.close(); manager = new WakeManager(dir);
  expect(manager.next(30).wakes.filter(w => w.inBlock === 1).map(w => w.projectId)).toEqual(order.slice(0, 3));
  for (let i = 0; i < 20; i++) expect(complete(`ordered-${i}`)?.projectId).toBe(order[Math.floor(i / 10)]);
  expect(manager.status()?.used).toBe(20);
  expect(manager.next(1).wakes[0]?.projectId).toBe(order[2]);
});
it("keeps a reserved block and its remaining wakes ahead of a reordered future queue", () => {
  manager.reserve("reserved"); manager.started("reserved");
  const order = futureBlocks().reverse();
  manager.reorderBlocks(order, manager.status()!.revision);
  expect(manager.pending()?.projectId).toBe("a");
  manager.finish("reserved", "completed");
  expect(manager.next(9).wakes.every(w => w.projectId === "a")).toBe(true);
  for (let i = 0; i < 9; i++) complete(`remainder-${i}`);
  expect(complete("next-ordered")?.projectId).toBe(order[0]);
});
it("rejects stale or incomplete reorders without changing the live queue", () => {
  const order = futureBlocks(), revision = manager.status()!.revision;
  expect(() => manager.reorderBlocks(order.slice(1), revision)).toThrow("blocs disponibles");
  manager.reorderBlocks(order, revision);
  expect(() => manager.reorderBlocks(order.reverse(), revision)).toThrow("planning a changé");
  expect(manager.status()?.used).toBe(0);
});
it("projects only the actually running wake and follows plan revisions without consuming slots", () => {
  manager.reserve("current");
  expect(readCurrentWakeObjective(dir, "current")).toBeNull();
  manager.started("current");
  expect(readCurrentWakeObjective(dir, "other")).toBeNull();
  expect(readCurrentWakeObjective(dir, "current")).toMatchObject({number: 1, inBlock: 1, title: "Project a", objective: "Retrouver le contexte et préparer le plan du bloc."});
  const plan = Array.from({length: 10}, (_, i) => ({wake: i + 1, objective: `Objectif ${i + 1}`, expected: "Preuve"}));
  manager.plan("a", plan);
  expect(readCurrentWakeObjective(dir, "current")).toMatchObject({objective: "Objectif 1", expected: "Preuve"});
  manager.plan("a", plan.map(s => ({...s, objective: "Révisé"})));
  expect(readCurrentWakeObjective(dir, "current")?.objective).toBe("Révisé");
  expect(manager.status()?.used).toBe(0);
  manager.finish("current", "completed");
  expect(readCurrentWakeObjective(dir, "current")).toBeNull();
  manager.reserve("second");
  manager.started("second");
  expect(readCurrentWakeObjective(dir, "second")).toMatchObject({number: 2, inBlock: 2});
});
it("loads the planning skill at block preparation and leaves a planned work wake short", () => {
  const first = manager.reserve("prepare");
  expect(first).not.toBeNull();
  expect(manager.instructions(first!)).toContain("name: planifier-wakes");
  manager.plan("a", Array.from({ length: 10 }, (_, i) => ({ wake: i + 1, objective: `work ${i + 1}`, expected: "observed result" })));
  manager.started("prepare");
  manager.finish("prepare", "completed");
  const work = manager.reserve("work");
  expect(work?.inBlock).toBe(2);
  expect(manager.instructions(work!)).toBe(WAKE_MANAGER_INSTRUCTIONS);
  expect(manager.prompt(work!)).toContain('"objective":"work 2"');
});
it("loads the planning skill when a work wake has no plan", () => {
  complete("unplanned-first");
  const work = manager.reserve("unplanned-next");
  expect(work?.phase).toBe("work");
  expect(manager.instructions(work!)).toContain("plan de bloc absent ou incomplet");
  expect(manager.instructions(work!)).toContain("name: planifier-wakes");
});
it("revisits planning at the next block even with an existing complete plan", () => {
  for (const id of ["a", "b"]) manager.plan(id, Array.from({ length: 10 }, (_, i) => ({ wake: i + 1, objective: "work", expected: "result" })));
  for (let i = 0; i < 10; i++) complete(`first-block-${i}`);
  const next = manager.reserve("next-block");
  expect(next?.projectId).toBe("b");
  expect(manager.instructions(next!)).toContain("début de bloc");
  expect(manager.instructions(next!)).toContain("name: planifier-wakes");
});
it("prioritizes prompt improvement across an in-flight wake and releases rotation after compression", () => {
  manager.reserve("in-flight");
  manager.started("in-flight");
  updatePromptImprovementProject(dir, true);
  expect(readCurrentProject(dir)).toBe(PROMPT_IMPROVEMENT_PROJECT);
  expect(readCounter(dir)?.["projects"]).toHaveProperty("a");
  manager.finish("in-flight", "completed");
  expect(manager.next(20).wakes.every(wake => wake.projectId === PROMPT_IMPROVEMENT_PROJECT)).toBe(true);
  for (let i = 0; i < 10; i++) expect(complete(`improve-${i}`)?.projectId).toBe(PROMPT_IMPROVEMENT_PROJECT);
  updatePromptImprovementProject(dir, false);
  expect(manager.next(1).wakes[0]?.projectId).not.toBe(PROMPT_IMPROVEMENT_PROJECT);
  expect(readCounter(dir)?.["projects"]).toHaveProperty(PROMPT_IMPROVEMENT_PROJECT);
});
it("does not reactivate a paused prompt improvement project on another warning", () => {
  updatePromptImprovementProject(dir, true);
  manager.setStatus(PROMPT_IMPROVEMENT_PROJECT, "paused", "human pause");
  updatePromptImprovementProject(dir, true);
  expect(manager.next(1).wakes[0]?.projectId).toBe("a");
  expect(manager.project(PROMPT_IMPROVEMENT_PROJECT).status).toBe("paused");
});
it("previews 500 wakes in 50-wake days and ten-wake blocks without consuming anything", () => {
  const wakes = manager.next(500).wakes;
  expect(wakes).toHaveLength(500);
  expect(wakes[0]).toMatchObject({
    number: 1,
    day: 1,
    inDay: 1,
    inBlock: 1,
    phase: "prepare",
    projectId: "a",
  });
  expect(wakes[9]).toMatchObject({ inBlock: 10, phase: "work", projectId: "a" });
  expect(wakes[10]).toMatchObject({ inBlock: 1, phase: "prepare", projectId: "b" });
  expect(wakes[49]?.day).toBe(1);
  expect(wakes[50]).toMatchObject({ day: 2, inDay: 1, projectId: "c" });
  expect(manager.status()?.used).toBe(0);
  expect(manager.pending()).toBeNull();
});
it("shares wakes equally across eleven projects instead of restarting five projects daily", () => {
  registry(Array.from({ length: 11 }, (_, i) => `p${String(i)}`));
  manager.configure(true);
  const counts = new Map<string, number>();
  for (const wake of manager.next(110).wakes)
    if (wake.projectId) counts.set(wake.projectId, (counts.get(wake.projectId) ?? 0) + 1);
  expect(counts.size).toBe(11);
  expect([...counts.values()]).toEqual(Array(11).fill(10));
});
it("counts a started principal session once and persists a switch with an honest fallback handoff", () => {
  for (let i = 0; i < 10; i++) {
    const id = `s${String(i)}`;
    const first = manager.reserve(id);
    expect(manager.reserve(id)).toEqual(first);
    manager.started(id);
    manager.started(id);
    manager.finish(id, "completed", { journalSessionId: id });
    manager.finish(id, "completed");
  }
  const next = manager.reserve("switch");
  expect(next).toMatchObject({ projectId: "b", fromProject: "a", phase: "prepare", number: 11 });
  expect(manager.project("a").handoff).toMatchObject({
    sessionId: "s9",
    wake: 10,
    needsReview: true,
  });
  expect(
    (
      JSON.parse(fs.readFileSync(path.join(dir, "artifacts/projets-compteur.json"), "utf8")) as {
        current: string;
      }
    ).current,
  ).toBe("b");
});
it("does not spend a wake when the model never started", () => {
  manager.reserve("refused");
  manager.finish("refused", "launch_failed");
  expect(manager.status()?.used).toBe(0);
  expect(manager.reserve("next")).toMatchObject({ number: 1, projectId: "a", phase: "prepare" });
});
it("recovers a reserved started wake after process restart without duplicating it", () => {
  manager.reserve("orphan");
  manager.started("orphan");
  manager.close();
  manager = new WakeManager(dir);
  expect(manager.pending()).toMatchObject({ sessionId: "orphan", started: true });
  manager.finish("orphan", "recovered:orphaned");
  expect(manager.status()?.used).toBe(1);
  expect(manager.reserve("next")?.number).toBe(2);
});
it("skips blocked projects without cancelling their history and permits explicit resumption", () => {
  manager.setStatus("a", "blocked", "Waiting for a real external response");
  expect(manager.next(1).wakes[0]?.projectId).toBe("b");
  expect(manager.project("a").status).toBe("blocked");
  manager.setStatus("a", "active", "Reply received");
  expect(manager.next(1).wakes[0]?.projectId).toBe("a");
});
it("leaves room for independent exploration when every project is paused", () => {
  for (const id of ["a", "b", "c"]) manager.setStatus(id, "paused", "Human pause");
  const wake = manager.reserve("free");
  expect(wake).toMatchObject({ projectId: null, phase: "free" });
  expect(wake?.phase).toBe("free");
  manager.started("free");
  manager.finish("free", "completed");
  expect(manager.status()?.used).toBe(1);
  expect(manager.project("a").used).toBe(0);
});
it("saves context, sources and a ten-wake plan in a readable workspace mirror", () => {
  manager.reserve("context-session");
  manager.started("context-session");
  manager.saveContext(
    "a",
    {
      summary: "Observed result",
      nextActions: ["Try the next concrete step"],
      openQuestions: ["What changes the decision?"],
      sources: ["artifacts/evidence.md"],
    },
    "context-session",
  );
  manager.plan(
    "a",
    Array.from({ length: 10 }, (_, i) => ({
      wake: i + 1,
      objective: i === 0 ? "Prepare the block" : "Work",
      expected: "Evidence",
    })),
  );
  manager.finish("context-session", "completed");
  manager.mirror("a");
  const saved = JSON.parse(fs.readFileSync(path.join(dir, contextPath("a")), "utf8")) as {
    context: { summary: string };
    handoff: { needsReview: boolean };
    plan: unknown[];
  };
  expect(saved.context.summary).toBe("Observed result");
  expect(saved.handoff.needsReview).toBe(false);
  expect(saved.plan).toHaveLength(10);
});
it("refuses parallel principal reservations and malformed block plans", () => {
  manager.reserve("one");
  expect(() => manager.reserve("two")).toThrow("already reserved");
  expect(() => manager.plan("a", [])).toThrow("exactly");
});
it("disabling planning does not turn off Wake and retains its history", () => {
  complete("first");
  manager.configure(false);
  expect(manager.reserve("disabled")).toBeNull();
  expect(manager.status()?.used).toBe(1);
  manager.configure(true);
  expect(manager.next(1).wakes[0]?.number).toBe(2);
});
