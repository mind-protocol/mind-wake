/**
 * Phrase de phase d'une salle (NLR, 18 nov. 2026 16:18–16:26Z) : posée par le holder chef de
 * projet, ajoutée au réveil de tous les agents de la salle, avec le reste calculé par le runtime.
 * Tours Claude simulés, aucun appel fournisseur.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { callClaude as CallClaude } from "./fast-reply.js";
import { forkDir, runForks, sendToFork, setForkEnabled } from "../daemon/forks.js";
import { saveForkAssignment, type runAssignedClaudeTurn } from "../daemon/fork-assignment.js";
import { runRoomAgentsTurn } from "../daemon/room-agents.js";
import { SecondThreadStore } from "../daemon/second-thread.js";
import { tickPatternHolders } from "./pattern-holders.js";
import {
  activePhase,
  extractPhase,
  parsePhaseLine,
  phasePublicNote,
  phaseStatusNote,
  readRoomPhases,
  roomPhaseWakeLine,
  setRoomPhase,
} from "./room-phase.js";

type TurnInput = Parameters<typeof runAssignedClaudeTurn>[0];
const MIN = 60_000;
const TRI = "Phase de tri : nous regardons quels travaux méritent l'heure";
let dataDir: string;
let space: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "room-phase-"));
  space = path.join(dataDir, "room");
  fs.mkdirSync(space, { recursive: true });
  fs.writeFileSync(path.join(space, "ROOM.md"), "Tu es la room.");
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

it("lit le bloc ```phase``` : durée en minutes, heures ou réveils, fin, erreurs ; le bloc n'est pas publié", () => {
  expect(parsePhaseLine(`15 min : ${TRI}.`)).toEqual({ text: TRI, minutes: 15 });
  expect(parsePhaseLine("1 h : Rédaction")).toEqual({ text: "Rédaction", minutes: 60 });
  expect(parsePhaseLine("pour 3 réveils — « Envoi des offres »")).toEqual({ text: "Envoi des offres", wakes: 3 });
  expect(parsePhaseLine("1 reveil : Relecture")).toEqual({ text: "Relecture", wakes: 1 });
  expect(parsePhaseLine("fin")).toEqual({ end: true });
  expect(parsePhaseLine("Fin de la phase.")).toEqual({ end: true });
  expect(parsePhaseLine("bientôt : tri")).toHaveProperty("error");
  expect(parsePhaseLine("15 min :")).toHaveProperty("error");
  expect(parsePhaseLine("0 réveil : rien")).toHaveProperty("error");
  expect(parsePhaseLine(`15 min : ${"x".repeat(301)}`)).toHaveProperty("error");
  expect(extractPhase(`On trie d'abord.\n\`\`\`phase\n15 min : ${TRI}\n\`\`\`\nÀ vous.`)).toEqual({
    text: "On trie d'abord.\n\nÀ vous.",
    lines: [`15 min : ${TRI}`],
  });
});

it("pose, remplace (jamais d'empilement), retire, et rappelle au chef la phrase active et son échéance", () => {
  const t0 = Date.parse("2026-11-18T16:30:00Z");
  const [posed] = setRoomPhase(dataDir, 6, "Chef de projet", [`15 min : ${TRI}`], t0);
  expect(posed).toMatchObject({ state: "posée", phase: { text: TRI, author: "Chef de projet", until: "2026-11-18T16:45:00.000Z" } });
  expect(phasePublicNote(posed!, t0)).toMatch(new RegExp(`^\\(phase posée : ${TRI} jusqu'à \\d\\d:45\\)$`, "u"));
  expect(phaseStatusNote(dataDir, 6, t0 + 9 * MIN)).toContain(`« ${TRI} » — jusqu'à`);
  expect(phaseStatusNote(dataDir, 6, t0 + 9 * MIN)).toContain("(encore 6 minutes)");

  const [replaced] = setRoomPhase(dataDir, 6, "Chef de projet", ["3 réveils : Phase d'envoi"], t0 + 10 * MIN);
  expect(replaced!.state).toBe("remplacée");
  expect(phasePublicNote(replaced!, t0)).toBe("(phase remplacée : Phase d'envoi pour 3 réveils de la salle)");
  expect(Object.keys(readRoomPhases(dataDir))).toEqual(["6"]);
  expect(activePhase(readRoomPhases(dataDir), 6, t0)?.text).toBe("Phase d'envoi");
  expect(phaseStatusNote(dataDir, 6, t0)).toContain("encore 3 réveils de la salle sur 3");
  // Une autre salle a sa propre phrase.
  setRoomPhase(dataDir, 7, "Autre chef", ["5 min : ailleurs"], t0);
  expect(activePhase(readRoomPhases(dataDir), 6, t0)?.text).toBe("Phase d'envoi");

  // Deux phrases dans le même bloc : la dernière gagne.
  setRoomPhase(dataDir, 6, "Chef de projet", ["5 min : A", "10 min : B"], t0);
  expect(activePhase(readRoomPhases(dataDir), 6, t0)?.text).toBe("B");

  expect(setRoomPhase(dataDir, 6, "Chef de projet", ["fin"], t0)[0]!.state).toBe("retirée");
  expect(activePhase(readRoomPhases(dataDir), 6, t0)).toBeNull();
  expect(roomPhaseWakeLine(dataDir, 6, 1, t0)).toBeNull();
  expect(setRoomPhase(dataDir, 6, "Chef de projet", ["fin"], t0)[0]!.state).toBe("aucune");
  expect(phaseStatusNote(dataDir, 6, t0)).toContain("Aucune phrase de phase active dans la salle 6");
});

it("expire seule en minutes, avec le reste recalculé à chaque réveil", () => {
  const t0 = Date.parse("2026-11-18T16:30:00Z");
  setRoomPhase(dataDir, 6, "Chef", [`15 min : ${TRI}`], t0);
  expect(roomPhaseWakeLine(dataDir, 6, 1, t0 + 9 * MIN)).toBe(
    `Phase de la salle 6 (posée par Chef) : ${TRI} — budget restant 6 minutes.`,
  );
  expect(roomPhaseWakeLine(dataDir, 6, 2, t0 + 14 * MIN + 30_000)).toContain("— budget restant 1 minute.");
  expect(roomPhaseWakeLine(dataDir, 6, 3, t0 + 15 * MIN)).toBeNull();
  expect(readRoomPhases(dataDir)["6"]).toBeUndefined();
});

it("expire seule en réveils : un cran par tour de salle, même reste pour les agents d'un même tour", () => {
  const t0 = Date.parse("2026-11-18T16:30:00Z");
  setRoomPhase(dataDir, 6, "Chef", ["3 réveils : Phase d'envoi"], t0);
  expect(roomPhaseWakeLine(dataDir, 6, 10, t0)).toBe("Phase de la salle 6 (posée par Chef) : Phase d'envoi — budget restant 3 réveils.");
  expect(roomPhaseWakeLine(dataDir, 6, 10, t0)).toContain("budget restant 3 réveils"); // autre agent, même tour
  expect(roomPhaseWakeLine(dataDir, 6, 11, t0)).toContain("— budget restant 2 réveils.");
  expect(roomPhaseWakeLine(dataDir, 6, 12, t0)).toContain("— dernier réveil de la phase.");
  expect(roomPhaseWakeLine(dataDir, 6, 12, t0)).toContain("— dernier réveil de la phase.");
  expect(phaseStatusNote(dataDir, 6, t0)).toContain("Aucune phrase de phase active");
  expect(roomPhaseWakeLine(dataDir, 6, 13, t0)).toBeNull();
  expect(readRoomPhases(dataDir)["6"]).toBeUndefined();
});

it("s'ajoute au réveil de chaque agent d'une salle à plusieurs agents", async () => {
  const agent = (id: string, name: string) => {
    const instructions = path.join(space, id);
    fs.mkdirSync(instructions, { recursive: true });
    fs.writeFileSync(path.join(instructions, "_holder.md"), `# ${name}`);
    return { id, name, instructions, writable: [path.relative(space, instructions)], tools: "none" };
  };
  const assignment = saveForkAssignment(forkDir(dataDir, 6), {
    instructions: path.join(space, "ROOM.md"),
    engine: "claude",
    workspace: space,
    inbox: "explicit",
    agents: [agent("redacteur", "Rédacteur"), agent("relecteur", "Relecteur")],
  });
  setForkEnabled(dataDir, 6, true);
  setRoomPhase(dataDir, 6, "Chef de projet", ["2 réveils : Phase d'envoi"], Date.now());
  const run = async (): Promise<TurnInput[]> => {
    sendToFork(dataDir, 6, "Bonjour à tous.");
    const store = new SecondThreadStore(forkDir(dataDir, 6));
    const calls: TurnInput[] = [];
    try {
      const human = store.pendingHuman();
      const n = store.beginTurn(null);
      await runRoomAgentsTurn({
        dataDir, dir: forkDir(dataDir, 6), id: 6, assignment, store, human, n, control: () => "run",
        claudeTurn: async (input) => {
          calls.push(input);
          return { outcome: "completed", text: "SILENCE", tokens: 1, accepted: true, detail: null, retryAtMs: null, sessionId: "s" };
        },
      });
      store.endTurn(n, "done", 1);
    } finally {
      store.close();
    }
    return calls;
  };
  const first = await run();
  expect(first).toHaveLength(2);
  for (const c of first) expect(c.message).toContain("Phase de la salle 6 (posée par Chef de projet) : Phase d'envoi — budget restant 2 réveils.");
  const second = await run();
  for (const c of second) expect(c.message).toContain("— dernier réveil de la phase.");
  const third = await run();
  expect(third).toHaveLength(2);
  for (const c of third) expect(c.message).not.toContain("Phase de la salle");
});

it("s'ajoute au réveil de l'agent d'une salle à un seul agent", async () => {
  saveForkAssignment(forkDir(dataDir, 6), { instructions: path.join(space, "ROOM.md"), engine: "claude", workspace: space });
  setForkEnabled(dataDir, 6, true);
  setRoomPhase(dataDir, 6, "Chef de projet", [`15 min : ${TRI}`], Date.now());
  sendToFork(dataDir, 6, "On commence ?");
  const calls: TurnInput[] = [];
  await runForks({
    dataDir,
    workspace: space,
    profile: () => "run",
    claudeProfile: () => "run",
    maxTurns: 1,
    claudeTurn: async (input) => {
      calls.push(input);
      return { outcome: "completed", text: "D'accord.", tokens: 1, accepted: true, detail: null, retryAtMs: null, sessionId: "s" };
    },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.message).toMatch(new RegExp(`Phase de la salle 6 \\(posée par Chef de projet\\) : ${TRI} — budget restant 1[45] minutes\\.`, "u"));
  expect(calls[0]!.message).toContain("On commence ?");
}, 30_000);

it("le holder chef pose la phrase par un bloc ```phase``` ; le fil annonce l'échéance ; sa note de réveil la rappelle", async () => {
  const holdersDir = path.join(dataDir, "workspace", "artifacts", "pattern-holders", "chef");
  fs.mkdirSync(holdersDir, { recursive: true });
  fs.writeFileSync(
    path.join(holdersDir, "_holder.md"),
    `\`\`\`json pattern-holder\n${JSON.stringify({ name: "Chef", emoji: "🧭", wake: "mention", cadence: { everyMinutes: 30 }, room: 6 })}\n\`\`\`\n\n(semence)\n`,
  );
  saveForkAssignment(forkDir(dataDir, 6), { instructions: path.join(space, "ROOM.md"), engine: "claude", workspace: space });
  setForkEnabled(dataDir, 6, true);
  let clock = Date.now() + MIN;
  const seen: string[] = [];
  let answer = `Découpage : tri d'abord, puis rédaction.\n\`\`\`phase\n15 min : ${TRI}\n\`\`\``;
  const call: typeof CallClaude = (_c, _a, prompt) => {
    seen.push(prompt);
    return Promise.resolve({ text: answer });
  };
  const tick = () => tickPatternHolders({ dataDir, claude: { executable: "unused", model: "sonnet" }, call, now: () => clock });
  await tick(); // référence de cadence
  clock += 30 * MIN;
  expect(await tick()).toHaveLength(1);
  expect(seen[0]).toContain("Aucune phrase de phase active dans la salle 6");
  const store = new SecondThreadStore(forkDir(dataDir, 6));
  let posted: string[];
  let notices: string[];
  try {
    posted = store.entries(50).filter((e) => e.role === "agent").map((e) => e.text);
    notices = store.entries(50).filter((e) => e.role === "human" && e.notice !== undefined).map((e) => e.text);
  } finally {
    store.close();
  }
  // La proposition de découpage part dans le fil de la salle, remise aux agents (notice humaine).
  expect(posted[0]).toMatch(new RegExp(`^🧭 Chef · Découpage : tri d'abord, puis rédaction\\.\\n\\(phase posée : ${TRI} jusqu'à \\d\\d:\\d\\d\\)`, "u"));
  expect(posted[0]).not.toContain("```");
  expect(notices.some((t) => t.includes("Découpage : tri d'abord"))).toBe(true);
  expect(readRoomPhases(dataDir)["6"]).toMatchObject({ text: TRI, author: "Chef" });

  answer = "SILENCE";
  clock += 30 * MIN; // phase échue (15 min), nouvelle revue
  await tick();
  expect(seen[1]).toContain("Aucune phrase de phase active dans la salle 6");
  setRoomPhase(dataDir, 6, "Chef", ["3 réveils : Phase d'envoi"], clock);
  clock += 30 * MIN;
  await tick();
  expect(seen[2]).toContain("Phrase de phase active dans la salle 6, posée par Chef");
  expect(seen[2]).toContain("encore 3 réveils de la salle sur 3");
});
