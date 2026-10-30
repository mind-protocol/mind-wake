import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readOwnerMessages } from "../communication/owner-messages.js";
import { STEP_TYPES } from "./wake-step-types.js";
import {
  nextWakeStep,
  readWakeSteps,
  saveStepsResult,
  STEPS_STOP_PROMPT,
  wakeStepsSchema,
} from "./wake-steps.js";

import {
  createStepsRequest,
  observeStepsTool,
  readStepsRequest,
  projectSnapshot,
  withProjectLock,
  type StepsRequest,
} from "./steps-coordination.js";
import { projectChange, readCurrentProject } from "./project-change.js";
import { appendRepoMessage } from "../communication/repo-conversations.js";
function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}
let dir: string;
let requests: Record<string, StepsRequest>;
const counterFile = () => path.join(dir, "artifacts/projets-compteur.json");
const counter = () =>
  JSON.parse(fs.readFileSync(counterFile(), "utf8")) as {
    current: string;
    selectionRevision: number;
    projects: Record<string, Record<string, unknown>>;
  };
const writeCounter = (v: unknown) => {
  fs.writeFileSync(counterFile(), JSON.stringify(v));
};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-steps-"));
  requests = {};
  fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  writeCounter({
    current: "A",
    selectionRevision: 1,
    projects: {
      A: { estimate: 40, spent: 2, wakes: ["s0", "s1"], status: "en cours", next: "before" },
      B: { estimate: 20, spent: 0 },
    },
  });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const plan = (extra: object = {}) => ({
  version: 1,
  travail: "Contrôler la reprise",
  statut: "actif",
  horizonWakes: { nombre: 2, origine: "fixe_agent", source: "Un contrôle puis une correction" },
  etapes: [{ id: "e1", wake: 1, texte: "Vérifier la reprise réelle", statut: "a_faire" }],
  prochaineEtape: "e1",
  ...extra,
});
function proposal(session = "s1"): StepsRequest {
  const r = requests[session] ?? must(createStepsRequest(dir, dir, "A", session));
  requests[session] = r;
  observeStepsTool(dir, r.requestId, "claude", {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "exploration",
          name: "Agent",
          input: { prompt: r.requestId + " " + r.snapshotRef },
        },
      ],
    },
  });
  observeStepsTool(dir, r.requestId, "claude", {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "exploration",
          content: "Directions comparées, recommandation, budget TOTAL proposé.",
        },
      ],
    },
  });
  return r;
}
const envelope = (r: StepsRequest, value: unknown) => ({
  etat: "accepted",
  requestId: r.requestId,
  projectId: r.projectId,
  snapshotRef: r.snapshotRef,
  propositionRef: "exploration",
  decisionPrincipale: "Retenir la direction, budget total motivé",
  plan: value,
});
const save = (value: unknown, session = "s1") =>
  saveStepsResult(dir, dir, "agent", session, JSON.stringify(envelope(proposal(session), value)));

it("persists the stop-hook catalogue and the selected step type", () => {
  expect(
    save(
      plan({
        typesEtapes: STEP_TYPES,
        etapes: [
          {
            id: "e1",
            wake: 1,
            type: "exploration",
            texte: "Explorer la question",
            statut: "a_faire",
          },
        ],
      }),
    ),
  ).toBe(true);
  expect(readWakeSteps(dir)?.typesEtapes).toEqual(STEP_TYPES);
  expect(nextWakeStep(dir)).toContain('"type":"exploration"');
  expect(STEPS_STOP_PROMPT).toContain("typesEtapes");
});

it("keeps old plans valid without inventing a phase", () => {
  expect(save(plan())).toBe(true);
  expect(readWakeSteps(dir)?.typesEtapes).toEqual(STEP_TYPES);
  expect(readWakeSteps(dir)?.etapes[0]?.type).toBeUndefined();
  expect(save(plan())).toBe(true);
});

it("accepts unknown and undeclared types while rejecting duplicate catalogue ids", () => {
  const step = { id: "e1", wake: 1, type: "creation", texte: "Un essai", statut: "a_faire" };
  expect(wakeStepsSchema.safeParse(plan({ etapes: [{ ...step, type: "invente" }] })).success).toBe(
    true,
  );
  expect(wakeStepsSchema.safeParse(plan({ typesEtapes: [], etapes: [step] })).success).toBe(true);
  expect(
    wakeStepsSchema.safeParse(plan({ typesEtapes: [STEP_TYPES[0], STEP_TYPES[0]] })).success,
  ).toBe(false);
  expect(wakeStepsSchema.safeParse(plan({ etapes: [{ ...step, type: null }] })).success).toBe(true);
});

it("roundtrips custom catalogue entries beyond the six suggested types", () => {
  const custom = { id: "incubation", orientation: "Laisser mûrir une idée" };
  const parsed = wakeStepsSchema.parse(
    plan({
      typesEtapes: [...STEP_TYPES, custom],
      etapes: [
        { id: "e1", wake: 1, type: "incubation", texte: "Reprendre la piste", statut: "a_faire" },
      ],
    }),
  );
  expect(wakeStepsSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  expect(parsed.typesEtapes).toContainEqual(custom);
  expect(parsed.etapes[0]?.type).toBe("incubation");
});

it("carries long-term context into the next wake", () => {
  const continuity = {
    cap: "Comprendre la reprise",
    questionsOuvertes: ["Le contexte survit-il ?"],
    critereReorientation: "Changer si le contexte est perdu",
  };
  expect(save(plan(continuity))).toBe(true);
  expect(readWakeSteps(dir)).toMatchObject(continuity);
  for (const value of [
    continuity.cap,
    ...continuity.questionsOuvertes,
    continuity.critereReorientation,
  ])
    expect(nextWakeStep(dir)).toContain(value);
});

it("rejects plans whose formatted representation exceeds the read limit", () => {
  expect(save(plan())).toBe(true);
  const large = plan({
    etapes: Array.from({ length: 32 }, (_, i) => ({
      id: `e${String(i + 1)}`,
      wake: i + 1,
      texte: "x".repeat(1950),
      statut: "a_faire",
    })),
  });
  expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(65_536);
  expect(save(large, "s2")).toBe(false);
  expect(readWakeSteps(dir)?.sourceSessionId).toBe("s1");
});

it("revises the three-wake chantier example after a real result is supplied", () => {
  const example = JSON.parse(
    fs.readFileSync(
      fileURLToPath(new URL("../../docs/examples/etapes-chantier.json", import.meta.url)),
      "utf8",
    ),
  ) as { etapes: { id: string; statut: string }[]; prochaineEtape: string };
  expect(save(example)).toBe(true);
  expect(nextWakeStep(dir)).toContain('"wake":1');
  const implementation = example.etapes[0];
  const revue = example.etapes[1];
  if (!implementation || !revue) throw new Error("Example needs the first two wakes");
  implementation.statut = "faite";
  revue.statut = "en_cours";
  example.prochaineEtape = "revue";
  expect(save(example, "s2")).toBe(true);
  expect(nextWakeStep(dir)).toContain('"wake":2');
  expect(nextWakeStep(dir)).toContain('"id":"revue"');
  expect(nextWakeStep(dir)).not.toContain('"id":"implementation"');
  expect(readOwnerMessages(dir)).toHaveLength(2);
});

it("persists provenance, publishes once and rejects a changed replay", () => {
  expect(save(plan())).toBe(true);
  const before = readWakeSteps(dir);
  expect(before).toMatchObject({
    sourceSessionId: "s1",
    horizonWakes: { nombre: 2, origine: "fixe_agent" },
  });
  expect(save(plan())).toBe(true);
  expect(readOwnerMessages(dir)).toHaveLength(1);
  expect(readWakeSteps(dir)?.updatedAt).toBe(before?.updatedAt);
  expect(save(plan({ travail: "changed replay" }))).toBe(false);
  expect(readWakeSteps(dir)?.travail).toBe("Contrôler la reprise");
  expect(nextWakeStep(dir)).toContain("ancienne note");
});

it.each(["pause", "arrete", "termine"])("keeps %s plans out of the next call", (statut) => {
  expect(save(plan({ statut, prochaineEtape: null }))).toBe(true);
  expect(nextWakeStep(dir)).toBeNull();
  expect(readOwnerMessages(dir)?.[0]?.text).toContain("Prochaine étape : aucune");
});

it.each([
  { prochaineEtape: "missing" },
  { statut: "arrete" },
  { horizonWakes: { nombre: 2, origine: "fixe_agent" } },
  { etapes: [{ id: "e1", wake: 1, texte: "Done", statut: "faite" }] },
  {
    etapes: [
      { id: "e1", wake: 1, texte: "A", statut: "a_faire" },
      { id: "e1", wake: 1, texte: "B", statut: "a_faire" },
    ],
  },
])("rejects inconsistent plans without overwriting the previous note", (extra) => {
  expect(save(plan())).toBe(true);
  expect(save(plan(extra), "s2")).toBe(false);
  expect(readWakeSteps(dir)?.sourceSessionId).toBe("s1");
});

it("handles missing, malformed and oversized files without changing the default", () => {
  expect(nextWakeStep(dir)).toBeNull();
  fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  for (const raw of ["{", "x".repeat(65_537), JSON.stringify({ version: 2 })]) {
    fs.writeFileSync(path.join(dir, "artifacts/etapes.json"), raw);
    expect(nextWakeStep(dir)).toBeNull();
  }
  expect(saveStepsResult(dir, dir, "agent", "s1", "not json")).toBe(false);
  expect(STEPS_STOP_PROMPT).toContain("Propose un budget de wakes");
  expect(STEPS_STOP_PROMPT).toContain("Un seul tour supervisé");
});

it("host compares only known endpoint IDs, documents and A-B-A do not trigger", () => {
  expect(projectChange("A", "B")).toEqual({ from: "A", to: "B" });
  for (const [a, b] of [
    ["A", "A"],
    [null, "B"],
    ["A", null],
  ])
    expect(projectChange(a ?? null, b ?? null)).toBeNull();
  const c = counter();
  must(c.projects["A"])["next"] = "another document";
  writeCounter(c);
  expect(projectChange("A", readCurrentProject(dir))).toBeNull();
  fs.writeFileSync(counterFile(), "x".repeat(262145));
  expect(readCurrentProject(dir)).toBeNull();
});
it("requires real correlated proposal and explicit principal acceptance", () => {
  const r = must(createStepsRequest(dir, dir, "A", "pending"));
  expect(saveStepsResult(dir, dir, "agent", "s1", JSON.stringify(plan()))).toBe(false);
  expect(saveStepsResult(dir, dir, "agent", "s1", JSON.stringify(envelope(r, plan())))).toBe(false);
  observeStepsTool(dir, r.requestId, "claude", {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "exploration",
          name: "Agent",
          input: { prompt: "unrelated compiler" },
        },
      ],
    },
  });
  observeStepsTool(dir, r.requestId, "claude", {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "exploration", content: "done" }] },
  });
  expect(readStepsRequest(dir, r.requestId)?.proposals).toEqual({});
  expect(readOwnerMessages(dir)).toBeNull();
  expect(must(counter().projects["A"])["next"]).toBe("before");
});
it("rejects native async launch acknowledgments and wrong snapshot", () => {
  const r = proposal();
  const other = must(createStepsRequest(dir, dir, "A", "s2"));
  observeStepsTool(dir, other.requestId, "claude", {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "async",
          name: "Agent",
          input: { prompt: other.requestId + " " + other.snapshotRef },
        },
      ],
    },
  });
  observeStepsTool(dir, other.requestId, "claude", {
    type: "user",
    toolUseResult: { isAsync: true, status: "async_launched", agentId: "child" },
    message: {
      content: [{ type: "tool_result", tool_use_id: "async", content: "Agent launched" }],
    },
  });
  expect(readStepsRequest(dir, other.requestId)?.proposals).toEqual({});
  expect(
    saveStepsResult(
      dir,
      dir,
      "agent",
      "s1",
      JSON.stringify({ ...envelope(r, plan()), snapshotRef: "wrong" }),
    ),
  ).toBe(false);
});
it.each(["human", "target", "selection"])(
  "rejects stale %s approval and preserves recommendation",
  (cause) => {
    const r = proposal();
    if (cause === "human")
      fs.writeFileSync(
        path.join(dir, "human-messages.jsonl"),
        JSON.stringify({ id: "human", at: new Date().toISOString(), text: "Stop" }) + "\n",
      );
    else {
      const c = counter();
      if (cause === "target") must(c.projects["A"])["next"] = "new plan";
      else c.selectionRevision += 2;
      writeCounter(c);
    }
    expect(saveStepsResult(dir, dir, "agent", "accept", JSON.stringify(envelope(r, plan())))).toBe(
      false,
    );
    expect(readStepsRequest(dir, r.requestId)).toMatchObject({
      state: "stale",
    });
    expect(must(counter().projects["A"])["estimate"]).toBe(40);
    expect(readOwnerMessages(dir)).toBeNull();
  },
);
it("fresh explicit reexamination can accept a retained recommendation", () => {
  const r = proposal();
  const c = counter();
  must(c.projects["A"])["next"] = "updated";
  writeCounter(c);
  expect(saveStepsResult(dir, dir, "agent", "accept", JSON.stringify(envelope(r, plan())))).toBe(
    false,
  );
  expect(
    saveStepsResult(
      dir,
      dir,
      "agent",
      "accept",
      JSON.stringify({
        ...envelope(r, plan()),
        snapshotRef: projectSnapshot(dir, dir, "A"),
        reexamenPrincipal: "Relu le nouveau plan ; cette recommandation reste adaptée.",
      }),
    ),
  ).toBe(true);
});
it("keeps consumed wakes and concurrent unrelated updates; shared lock prevents write", () => {
  const r = proposal();
  const c = counter();
  must(c.projects["B"])["custom"] = "parallel";
  c["extra" as "current"] = "A";
  writeCounter(c);
  const decision = JSON.stringify(envelope(r, plan()));
  withProjectLock(dir, () => {
    expect(saveStepsResult(dir, dir, "agent", "s1", decision)).toBe(false);
  });
  expect(saveStepsResult(dir, dir, "agent", "s1", decision)).toBe(true);
  expect(counter().projects["A"]).toMatchObject({ spent: 2, wakes: ["s0", "s1"] });
  expect(must(counter().projects["B"])["custom"]).toBe("parallel");
  const switched = counter();
  switched.current = "B";
  writeCounter(switched);
  expect(readWakeSteps(dir)).toBeNull();
  fs.writeFileSync(path.join(dir, "artifacts/etapes.json"), JSON.stringify(plan()));
  expect(readWakeSteps(dir)).toBeNull();
});
it("asynchronous repo proposal remains pending until explicit principal decision; advice is not a human message", () => {
  const r = must(createStepsRequest(dir, dir, "A", "pending"));
  const input = { target: "codex:peer", context: r.requestId + " " + r.snapshotRef };
  observeStepsTool(dir, r.requestId, "claude", {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "send", name: "mcp__mind__send_repo_request", input }],
    },
  });
  observeStepsTool(
    dir,
    r.requestId,
    "claude",
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "send",
            content: JSON.stringify({
              thread_id: "direct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              job_id: "job_test",
              status: "queued",
            }),
          },
        ],
      },
    },
    dir,
  );
  const thread = {
    id: "direct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    repo: "C:/repo",
    runtime: "codex",
    sessionId: "peer",
    transcript: "source",
  };
  appendRepoMessage(dir, {
    thread,
    message: { id: "q", at: new Date().toISOString(), from: "wake", text: input.context },
  });
  expect(
    saveStepsResult(
      dir,
      dir,
      "agent",
      "s1",
      JSON.stringify({ ...envelope(r, plan()), propositionRef: "answer" }),
    ),
  ).toBe(false);
  appendRepoMessage(dir, {
    thread,
    message: {
      id: "answer",
      at: new Date().toISOString(),
      from: "repo",
      text: "Directions A et B ; budget TOTAL recommandé30 ; prochain test.",
    },
  });
  fs.writeFileSync(
    path.join(dir, "owner-inbox.jsonl"),
    JSON.stringify({ id: "advice", text: "advice_reply" }) + "\n",
  );
  expect(must(counter().projects["A"])["estimate"]).toBe(40);
  expect(readOwnerMessages(dir)).toBeNull();
  expect(
    saveStepsResult(
      dir,
      dir,
      "agent",
      "s1",
      JSON.stringify({ ...envelope(r, plan()), propositionRef: "answer" }),
    ),
  ).toBe(true);
  expect(must(counter().projects["A"])["estimate"]).toBe(2);
  expect(readOwnerMessages(dir)).toHaveLength(1);
});
it.each(["unavailable", "failed"])("%s does not apply or publish a plan", (etat) => {
  const r = must(createStepsRequest(dir, dir, "A", "pending"));
  expect(
    saveStepsResult(dir, dir, "agent", "s1", JSON.stringify({ ...envelope(r, plan()), etat })),
  ).toBe(false);
  expect(readStepsRequest(dir, r.requestId)?.state).toBe(etat);
  expect(readOwnerMessages(dir)).toBeNull();
});

it("ignores structurally corrupt request JSON and preserves all pending transitions", () => {
  const r = must(createStepsRequest(dir, dir, "A", "pending"));
  const f = path.join(dir, "artifacts/steps-requests", r.requestId + ".json");
  fs.writeFileSync(f, JSON.stringify({ ...r, calls: null, proposals: null }));
  expect(readStepsRequest(dir, r.requestId)).toBeNull();
  expect(() => nextWakeStep(dir)).not.toThrow();
});

it("never reexamines another project through a null snapshot", () => {
  const r = proposal();
  const c = counter();
  c.current = "B";
  writeCounter(c);
  expect(
    saveStepsResult(
      dir,
      dir,
      "agent",
      "s1",
      JSON.stringify({
        ...envelope(r, plan()),
        snapshotRef: null,
        reexamenPrincipal: "still accept",
      }),
    ),
  ).toBe(false);
  expect(must(counter().projects["A"])["estimate"]).toBe(40);
});

it("does not rewrite unrelated events; rejects a native spawn from another principal", () => {
  const r = must(createStepsRequest(dir, dir, "A", "pending"));
  const rename = vi.spyOn(fs, "renameSync");
  observeStepsTool(
    dir,
    r.requestId,
    "codex",
    { type: "agentMessage", text: "unrelated" },
    dir,
    "principal",
  );
  expect(rename).not.toHaveBeenCalled();
  rename.mockRestore();
  observeStepsTool(
    dir,
    r.requestId,
    "codex",
    {
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      id: "spawn",
      senderThreadId: "other",
      receiverThreadIds: ["child"],
      status: "completed",
      prompt: r.requestId + " " + r.snapshotRef,
    },
    dir,
    "principal",
  );
  observeStepsTool(
    dir,
    r.requestId,
    "codex",
    {
      type: "collabAgentToolCall",
      tool: "wait",
      id: "wait",
      senderThreadId: "principal",
      status: "completed",
      agentsStates: { child: { status: "completed", message: "wrong child" } },
    },
    dir,
    "principal",
  );
  expect(must(readStepsRequest(dir, r.requestId)).proposals).toEqual({});
});
it("keeps large Unicode evidence readable with explicit truncation", () => {
  const r = must(createStepsRequest(dir, dir, "A", "pending"));
  for (let i = 0; i < 5; i++) {
    const id = "call" + String(i);
    observeStepsTool(dir, r.requestId, "claude", {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id,
            name: "Agent",
            input: { prompt: r.requestId + " " + r.snapshotRef },
          },
        ],
      },
    });
    observeStepsTool(dir, r.requestId, "claude", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, content: "é".repeat(64000) }] },
    });
  }
  expect(must(readStepsRequest(dir, r.requestId)).evidenceTruncated).toBe(true);
  expect(
    fs.statSync(path.join(dir, "artifacts/steps-requests", r.requestId + ".json")).size,
  ).toBeLessThanOrEqual(262144);
});
