/** Isolated SQLite fixtures, never the live registry or allocation. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WakeManager, readCurrentWakeObjective, type WakePassage } from "./wake-manager.js";

let dir: string, manager: WakeManager;
const weights = {
  "word-mixer-test-ferme": 60,
  "conseil-glenan": 80,
  "blog-mon-humain": 60,
  "explorations-propres": 60,
  "recit-reflexif": 60,
  "wordmixer-sortie": 40,
  "collaboration-inter-agents": 40,
  "fouille-entretien": 50,
  "ui-app": 30,
  "mind-preuves": 20,
};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "w500-test-"));
  fs.mkdirSync(path.join(dir, "artifacts"));
  fs.writeFileSync(
    path.join(dir, "artifacts/projets-compteur.json"),
    JSON.stringify({
      current: "a",
      total: 41,
      projects: Object.fromEntries(
        ["a", "b", ...Object.keys(weights)].map((id) => [id, { status: "en cours", used: 12 }]),
      ),
    }),
  );
  manager = new WakeManager(dir);
  manager.configure(true);
});
afterEach(() => {
  manager.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const steps = (label: string) =>
  Array.from({ length: 10 }, (_, i) => ({
    wake: i + 1,
    objective: `${label} ${i + 1}`,
    expected: `proof ${label}`,
  }));
const passage = (id: string, projectId = "a", detailed = true): WakePassage => ({
  id,
  projectId,
  question: `question ${id}`,
  expected: `result ${id}`,
  sources: [`source-${id}.md`],
  ...(detailed ? { steps: steps(id) } : {}),
});
const revision = () => manager.status()!.revision;
function snapshot() {
  return JSON.stringify({
    state: manager.status(),
    allocations: manager.db.prepare("SELECT * FROM allocations ORDER BY session_id").all(),
    events: manager.db.prepare("SELECT * FROM rotation_events ORDER BY id").all(),
    registry: fs.readFileSync(path.join(dir, "artifacts/projets-compteur.json"), "utf8"),
  });
}
function complete(id: string) {
  const wake = manager.reserve(id)!;
  manager.started(id);
  manager.finish(id, "completed");
  return wake;
}
function apply(passages: WakePassage[]) {
  return manager.importPassages(passages, revision(), "apply");
}

it("validates read-only then persists 50 passages / 500 positions with the v3 weights and no consumed counters", () => {
  const passages = Object.entries(weights).flatMap(([id, count]) =>
    Array.from({ length: count / 10 }, (_, i) => passage(`${id}-${i}`, id)),
  );
  const before = snapshot();
  const reader = new WakeManager(dir, { readOnly: true });
  try {
    expect(reader.importPassages(passages, revision(), "validate")).toMatchObject({
      passages: 50,
      positions: 500,
      counts: weights,
    });
  } finally {
    reader.close();
  }
  expect(snapshot()).toBe(before);
  const counters = manager.status()!.projects.map((p) => p.used);
  expect(apply(passages)).toMatchObject({ positions: 500, counts: weights });
  expect(manager.status()!.projects.map((p) => p.used)).toEqual(counters);
  expect(manager.status()!.used).toBe(0);
  const wakes = manager.next(500).wakes;
  expect(wakes).toHaveLength(500);
  expect(new Set(wakes.map((w) => w.passageId)).size).toBe(50);
  expect(wakes.map((w) => w.number)).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
  expect(
    Object.fromEntries(
      Object.keys(weights).map((id) => [id, wakes.filter((w) => w.projectId === id).length]),
    ),
  ).toEqual(weights);
  manager.close();
  manager = new WakeManager(dir);
  expect(manager.next(500).wakes).toEqual(wakes);
});

it.each([false, true])(
  "preserves the entire engaged block and pending allocation (imported block: %s)",
  (imported) => {
    if (imported) apply([passage("engaged")]);
    for (let i = 0; i < 3; i++) complete(`before-${i}`);
    manager.reserve("pending");
    manager.started("pending");
    const pending = manager.pending(),
      state = manager.status()!;
    const registry = fs.readFileSync(path.join(dir, "artifacts/projets-compteur.json"), "utf8");
    apply([passage("future", "b")]);
    expect(manager.pending()).toEqual(pending);
    expect(manager.status()).toMatchObject({
      used: state.used,
      position: state.position,
      project: state.project,
    });
    expect(manager.status()!.currentPassageId).toBe(state.currentPassageId);
    expect(manager.status()!.projects.map((p) => p.used)).toEqual(
      state.projects.map((p) => p.used),
    );
    expect(fs.readFileSync(path.join(dir, "artifacts/projets-compteur.json"), "utf8")).toBe(
      registry,
    );
    expect(
      manager.next(7).wakes.every((w) => w.projectId === "a" && w.passageId === pending?.passageId),
    ).toBe(true);
    manager.finish("pending", "completed");
    for (let i = 4; i < 10; i++) complete(`rest-${i}`);
    expect(manager.next(1).wakes[0]).toMatchObject({
      number: 11,
      passageId: "future",
      projectId: "b",
    });
  },
);

it("preserves a reserved first queued block when importing its successors", () => {
  apply([passage("reserved"), passage("replaced", "b")]);
  manager.reserve("first");
  const pending = manager.pending();
  apply([passage("new", "b")]);
  expect(manager.pending()).toEqual(pending);
  expect(manager.next(11).wakes.map((w) => w.passageId)).toEqual([
    ...Array(10).fill("reserved"),
    "new",
  ]);
});

it.each([
  "stale",
  "unknown",
  "paused",
  "blocked",
  "archived",
  "duplicate",
  "reuse",
  "bad-number",
  "empty-intention",
  "null-intention",
  "missing-sources",
  "oversize",
])("rejects %s atomically", (kind) => {
  apply([passage("used-id")]);
  let input = [passage("valid"), passage("bad", "b")],
    rev = revision();
  if (kind === "stale") rev--;
  if (kind === "unknown") input[1]!.projectId = "missing";
  if (["paused", "blocked", "archived"].includes(kind)) {
    const file = path.join(dir, "artifacts/projets-compteur.json"),
      registry = JSON.parse(fs.readFileSync(file, "utf8"));
    registry.projects.b.status = kind;
    fs.writeFileSync(file, JSON.stringify(registry));
  }
  if (kind === "duplicate") input[1]!.id = "valid";
  if (kind === "reuse") input[1]!.id = "used-id";
  if (kind === "bad-number") input[1]!.steps![9]!.wake = 1;
  if (kind === "empty-intention") input[1]!.steps![9]!.objective = " ";
  if (kind === "null-intention") input[1]!.steps![9] = null as never;
  if (kind === "missing-sources") input[1]!.sources = [];
  if (kind === "oversize") input = Array.from({ length: 51 }, (_, i) => passage(`p${i}`));
  const before = snapshot();
  expect(() => manager.importPassages(input, rev, "apply")).toThrow();
  expect(snapshot()).toBe(before);
  expect(() => manager.importPassages(input, rev, "validate")).toThrow();
  expect(snapshot()).toBe(before);
});

it("rechecks a project blocked after dry-run even if the registry was edited outside the manager", () => {
  const input = [passage("one", "b")],
    rev = revision();
  manager.importPassages(input, rev, "validate");
  const file = path.join(dir, "artifacts/projets-compteur.json"),
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.projects.b.status = "pause humaine";
  fs.writeFileSync(file, JSON.stringify(data));
  const before = snapshot();
  expect(() => manager.importPassages(input, rev, "apply")).toThrow("unavailable");
  expect(snapshot()).toBe(before);
});

it("selects different intentions at two returns, retains previous project evidence and updates only the targeted passage", () => {
  manager.plan("a", steps("GLOBAL-OLD"));
  apply([passage("first"), passage("second"), passage("undetailed", "a", false)]);
  const first = manager.reserve("first-run")!;
  manager.started("first-run");
  expect(manager.prompt(first)).toContain('"objective":"first 1"');
  expect(readCurrentWakeObjective(dir, "first-run")).toMatchObject({
    passageId: "first",
    objective: "first 1",
    passage: { question: "question first" },
  });
  manager.saveContext(
    "a",
    {
      summary: "observed, reviewed project result",
      sources: ["accepted.md"],
      nextActions: [],
      openQuestions: [],
    },
    "first-run",
  );
  manager.finish("first-run", "completed");
  for (let i = 1; i < 10; i++) complete(`first-${i}`);
  manager.planPassage("second", steps("NEW-SECOND"), revision());
  expect(manager.status()!.passages!["first"]!.steps![0]!.objective).toBe("first 1");
  const second = manager.reserve("second-run")!;
  manager.started("second-run");
  expect(manager.prompt(second)).toContain('"objective":"NEW-SECOND 1"');
  expect(manager.prompt(second)).toContain("observed, reviewed project result");
  expect(manager.prompt(second)).toContain("accepted.md");
  expect(manager.prompt(second)).not.toContain("GLOBAL-OLD");
  expect(readCurrentWakeObjective(dir, "second-run")).toMatchObject({
    passageId: "second",
    objective: "NEW-SECOND 1",
  });
  manager.finish("second-run", "completed");
  for (let i = 1; i < 10; i++) complete(`second-${i}`);
  const third = manager.reserve("third-run")!;
  manager.started("third-run");
  expect(manager.prompt(third)).toContain("À définir");
  expect(manager.prompt(third)).toContain('"step":null');
  expect(manager.prompt(third)).not.toMatch(/GLOBAL-OLD|NEW-SECOND|first 1/);
  expect(readCurrentWakeObjective(dir, "third-run")).toMatchObject({
    objectiveDefined: false,
    passageId: "undetailed",
    objective: expect.stringContaining("préparer les dix intentions"),
  });
  expect(manager.instructions(third)).toContain("plan de bloc absent");
  manager.finish("third-run", "completed");
  const fourth = manager.reserve("fourth-run")!;
  manager.started("fourth-run");
  expect(readCurrentWakeObjective(dir, "fourth-run")?.objective).toContain(
    "préparer les dix intentions",
  );
});

it("reorders by project while retaining each passage identity and its content in FIFO order", () => {
  apply([passage("a1"), passage("b1", "b"), passage("a2")]);
  const saved = structuredClone(manager.status()!.passages);
  const ids = manager
    .next(500)
    .wakes.filter((w) => w.inBlock === 1)
    .map((w) => w.projectId!);
  manager.reorderBlocks(
    [...ids.filter((id) => id === "b"), ...ids.filter((id) => id !== "b")],
    revision(),
  );
  expect(manager.status()!.passages).toEqual(saved);
  expect(
    manager
      .next(500)
      .wakes.filter((w) => w.inBlock === 1 && w.passageId)
      .map((w) => w.passageId),
  ).toEqual(["b1", "a1", "a2"]);
  const before = snapshot();
  manager.setStatus("a", "blocked", "human");
  const blocked = snapshot();
  const order = manager
    .next(500)
    .wakes.filter((w) => w.inBlock === 1)
    .map((w) => w.projectId!);
  expect(() => manager.reorderBlocks(order, revision())).toThrow("perdre des passages");
  expect(snapshot()).toBe(blocked);
  expect(blocked).not.toBe(before);
});

it("rejects stale passage planning without overwriting any passage", () => {
  apply([passage("first"), passage("second")]);
  const rev = revision();
  manager.planPassage("second", steps("new"), rev);
  const before = snapshot();
  expect(() => manager.planPassage("first", steps("wrong"), rev)).toThrow("Stale");
  expect(snapshot()).toBe(before);
});

it("recalculates future numbers after an owner reorder and a block without launching or consuming a wake", () => {
  // Seed an already-executed history; do not fabricate 41 session launches.
  const state = manager.status()!;
  state.used = 41;
  state.project = "a";
  state.position = 3;
  state.lastProject = "a";
  state.projects.find((p) => p.id === "a")!.used = 3;
  manager.db.prepare("UPDATE rotation_state SET payload=? WHERE id=1").run(JSON.stringify(state));
  manager.reserve("reserved42");
  const pending = manager.pending();
  apply([passage("later-a"), passage("human-b", "b"), passage("later-c", "blog-mon-humain")]);
  const original = manager.next(500).wakes;
  expect(original[7]).toMatchObject({ number: 49, passageId: "later-a" });
  const order = original
    .filter((w) => w.inBlock === 1 && w.number + 9 <= original.at(-1)!.number)
    .map((w) => w.projectId!);
  manager.reorderBlocks(
    [...order.filter((id) => id === "b"), ...order.filter((id) => id !== "b")],
    revision(),
  );
  expect(manager.next(8).wakes[7]).toMatchObject({ number: 49, passageId: "human-b" });
  manager.setStatus("b", "blocked", "human prerequisite missing");
  const next = manager.next(500).wakes;
  expect(next[7]).toMatchObject({ number: 49, passageId: "later-a" });
  expect(next.find((w) => w.number === 77)?.number).toBe(77); // Number only, no reminder claim.
  expect(manager.pending()).toEqual(pending);
  expect(manager.status()!.used).toBe(41);
  expect(manager.status()!.projects.find((p) => p.id === "a")!.used).toBe(3);
  expect(manager.db.prepare("SELECT count(*) AS n FROM allocations").get()).toEqual({ n: 1 });
});
