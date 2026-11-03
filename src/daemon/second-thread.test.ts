/** Second fil : fixtures locales seulement, aucun appel au fournisseur. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WakeManager } from "./wake-manager.js";
import {
  pickSecondThreadProject,
  readProjectLandscape,
  readSecondThread,
  runSecondThread,
  saveSecondThreadEnabled,
  secondThreadEnabled,
  secondThreadTurnMessage,
  secondThreadWorkerRunning,
  sendToSecondThread,
  runClaudeTurn,
} from "./second-thread.js";

let dataDir: string, workspace: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "second-thread-"));
  workspace = path.join(dataDir, "workspace");
  fs.mkdirSync(path.join(workspace, "artifacts"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "artifacts/projets-compteur.json"),
    JSON.stringify({
      current: "a",
      projects: {
        a: { status: "en cours", title: "Projet A" },
        b: { status: "en cours", title: "Projet B" },
        c: { status: "en cours", title: "Projet C" },
        d: { status: "en pause", title: "Projet D" },
      },
    }),
  );
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

it("is off by default and toggles through its own file", () => {
  expect(secondThreadEnabled(dataDir)).toBe(false);
  saveSecondThreadEnabled(dataDir, true);
  expect(secondThreadEnabled(dataDir)).toBe(true);
  saveSecondThreadEnabled(dataDir, false);
  expect(secondThreadEnabled(dataDir)).toBe(false);
});

it("walks projects in reverse order by blocks and never takes the main project", () => {
  const order = ["a", "b", "c"];
  let position = pickSecondThreadProject(order, "a", null, 2);
  expect(position).toEqual({ projectId: "c", inBlock: 1 });
  position = pickSecondThreadProject(order, "a", position, 2);
  expect(position).toEqual({ projectId: "c", inBlock: 2 });
  position = pickSecondThreadProject(order, "a", position, 2);
  expect(position).toEqual({ projectId: "b", inBlock: 1 });
  // The main thread moved onto b: the second thread leaves it at once.
  position = pickSecondThreadProject(order, "b", position, 2);
  expect(position).toEqual({ projectId: "a", inBlock: 1 });
  position = pickSecondThreadProject(order, "b", { projectId: "a", inBlock: 2 }, 2);
  expect(position).toEqual({ projectId: "c", inBlock: 1 });
  expect(pickSecondThreadProject(["a"], "a", null)).toEqual({ projectId: null, inBlock: 1 });
});

it("follows the main rotation order and its current project", () => {
  expect(readProjectLandscape(workspace)).toMatchObject({
    order: ["a", "b", "c"],
    mainProject: "a",
  });
  const manager = new WakeManager(workspace);
  manager.configure(true);
  manager.reserve("s1");
  manager.close();
  const landscape = readProjectLandscape(workspace);
  expect(landscape.order).not.toContain("d");
  expect(landscape.mainProject).toBe("a");
  expect(pickSecondThreadProject(landscape.order, landscape.mainProject, null).projectId).toBe("c");
});

it("keeps its own saved thread, resumes the Claude session and delivers human messages once", async () => {
  saveSecondThreadEnabled(dataDir, true);
  sendToSecondThread(dataDir, "Regarde le projet C");
  const calls: Parameters<typeof runClaudeTurn>[0][] = [];
  const turn: typeof runClaudeTurn = (input) => {
    calls.push(input);
    return Promise.resolve({
      outcome: "completed",
      text: `Réponse ${String(calls.length)}`,
      sessionConfirmed: true,
      tokens: 10,
      retryAtMs: null,
      detail: null,
    });
  };
  const summary = await runSecondThread({
    dataDir,
    workspace: () => workspace,
    profile: () => "run",
    log: () => undefined,
    turn,
    maxTurns: 2,
  });
  expect(summary).toEqual({ turns: 2, reason: "nombre de tours atteint" });
  expect(calls.map((c) => c.session.mode)).toEqual(["new", "resume"]);
  expect(calls[0]?.session.id).toBe(calls[1]?.session.id);
  expect(calls[0]?.message).toContain("Regarde le projet C");
  expect(calls[1]?.message).not.toContain("Regarde le projet C");
  expect(calls[0]?.message).toContain("Projet C (c)");
  expect(fs.readFileSync(calls[0]?.promptFile ?? "", "utf8")).toContain("Second Claude Code chat");
  const view = readSecondThread(dataDir);
  expect(view.entries.map((e) => [e.role, e.text])).toEqual([
    ["human", "Regarde le projet C"],
    ["agent", "Réponse 1"],
    ["agent", "Réponse 2"],
  ]);
  expect(view.position).toEqual({ projectId: "c", inBlock: 2 });
  // Nothing was written in the main thread's stores.
  expect(fs.existsSync(path.join(dataDir, "owner-messages.sqlite"))).toBe(false);
  expect(secondThreadWorkerRunning(dataDir)).toBe(false);
});

it("waits during pause and stops when disabled or force-stopped", async () => {
  saveSecondThreadEnabled(dataDir, true);
  const states: ("run" | "hold" | "stop")[] = ["hold", "hold", "stop"];
  let calls = 0;
  const summary = await runSecondThread({
    dataDir,
    workspace: () => workspace,
    profile: () => states.shift() ?? "stop",
    log: () => undefined,
    sleep: () => Promise.resolve(),
    turn: () => {
      calls++;
      return Promise.reject(Error("must not run"));
    },
  });
  expect(calls).toBe(0);
  expect(summary.reason).toBe("profil arrêté");
  saveSecondThreadEnabled(dataDir, false);
  const off = await runSecondThread({
    dataDir,
    workspace: () => workspace,
    profile: () => "run",
    log: () => undefined,
  });
  expect(off).toEqual({ turns: 0, reason: "second fil désactivé" });
});

it("records an interrupted turn as an event without losing pending human messages", async () => {
  saveSecondThreadEnabled(dataDir, true);
  sendToSecondThread(dataDir, "Toujours là ?");
  await runSecondThread({
    dataDir,
    workspace: () => workspace,
    profile: () => "run",
    log: () => undefined,
    sleep: () => Promise.resolve(),
    maxTurns: 1,
    turn: () =>
      Promise.resolve({
        outcome: "interrupted",
        text: "",
        sessionConfirmed: false,
        tokens: null,
        retryAtMs: null,
        detail: "pause",
      }),
  });
  const view = readSecondThread(dataDir);
  expect(view.entries.find((e) => e.role === "human")?.delivered).toBe(false);
  expect(view.entries.at(-1)).toMatchObject({
    role: "event",
    text: "Tour 1 : interrupted — pause",
  });
});

it("states the main project and the free-exploration fallback in the turn message", () => {
  const text = secondThreadTurnMessage({
    turn: 3,
    position: { projectId: null, inBlock: 1 },
    titles: { a: "Projet A" },
    mainProject: "a",
    human: [],
    now: new Date("2026-11-03T12:00:00Z"),
  });
  expect(text).toContain("free exploration");
  expect(text).toContain("Main chat: Projet A (a)");
});

describe("runClaudeTurn with a fake Claude Code executable", () => {
  const claude = {
    executable: process.execPath,
    prefixArgs: [path.resolve("test/fixtures/second-thread/fake-claude.mjs")],
    model: "opus",
  };
  const base = () => ({
    claude,
    workspace,
    promptFile: path.join(dataDir, "prompt.md"),
    message: "Second fil — tour 1",
    control: () => "run" as const,
  });
  beforeEach(() => {
    fs.writeFileSync(path.join(dataDir, "prompt.md"), "prompt");
  });

  it("reads the assistant reply and confirms the session", async () => {
    const result = await runClaudeTurn({
      ...base(),
      session: { mode: "new", id: "11111111-1111-4111-8111-111111111111" },
    });
    expect(result).toMatchObject({
      outcome: "completed",
      text: "new:Second fil — tour 1",
      sessionConfirmed: true,
    });
    const resumed = await runClaudeTurn({
      ...base(),
      session: { mode: "resume", id: "11111111-1111-4111-8111-111111111111" },
    });
    expect(resumed.text).toBe("resume:Second fil — tour 1");
  });

  it("reports a provider limit with its reset time", async () => {
    const result = await runClaudeTurn({
      ...base(),
      message: "#limited",
      session: { mode: "new", id: "22222222-2222-4222-8222-222222222222" },
    });
    expect(result).toMatchObject({ outcome: "rate_limited", retryAtMs: 4102444800000 });
  });

  it("kills the turn when Wake pauses or the thread is switched off", async () => {
    let calls = 0;
    const result = await runClaudeTurn({
      ...base(),
      message: "#hang",
      session: { mode: "new", id: "33333333-3333-4333-8333-333333333333" },
      control: () => (++calls > 1 ? "hold" : "run"),
    });
    expect(result).toMatchObject({ outcome: "interrupted", sessionConfirmed: true });
  }, 15_000);
});
