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
  activePhases,
  PRINCIPAL_PHASE_ROOM,
  ROOM_PHASE_FILE,
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

it("lit les durées longues : jours et semaines (arc d'une Narration), six semaines au plus", () => {
  expect(parsePhaseLine("3 jours : Arc de la rentrée")).toEqual({ text: "Arc de la rentrée", minutes: 3 * 24 * 60 });
  expect(parsePhaseLine("2 semaines : Arc du lancement")).toEqual({ text: "Arc du lancement", minutes: 14 * 24 * 60 });
  expect(parsePhaseLine("1 j : Journée de tri")).toEqual({ text: "Journée de tri", minutes: 24 * 60 });
  expect(parsePhaseLine("7 semaines : trop long")).toHaveProperty("error");
  expect(parsePhaseLine("1 j (la journée) : Journée de tri")).toEqual({ text: "Journée de tri", minutes: 24 * 60, scale: "la journée" });
  expect(parsePhaseLine("3 réveils (l'heure) — Envoi")).toEqual({ text: "Envoi", wakes: 3, scale: "l'heure" });
});

it("plusieurs phrases à la fois : une par auteur, injectées ensemble (la plus ancienne d'abord), sans s'écraser", () => {
  const t0 = Date.parse("2026-11-20T09:00:00Z");
  setRoomPhase(dataDir, 6, "Narration", ["2 semaines (l'arc) : Arc du lancement : on passe de l'atelier au public"], t0);
  const [chef] = setRoomPhase(dataDir, 6, "Chef de projet", [`1 h (l'heure) : ${TRI}`], t0 + MIN);
  expect(chef!.state).toBe("posée"); // pas « remplacée » : la phrase de Narration n'est pas la sienne
  expect(activePhases(readRoomPhases(dataDir), 6, t0 + MIN).map((p) => p.author)).toEqual(["Narration", "Chef de projet"]);
  expect(roomPhaseWakeLine(dataDir, 6, 1, t0 + 2 * MIN)).toBe(
    [
      "Phase de la salle 6 (posée par Narration, l'arc) : Arc du lancement : on passe de l'atelier au public — budget restant 14 jours.",
      `Phase de la salle 6 (posée par Chef de projet, l'heure) : ${TRI} — budget restant 59 minutes.`,
    ].join("\n"),
  );

  // Le chef remplace sa phrase : celle de Narration reste.
  expect(setRoomPhase(dataDir, 6, "Chef de projet", ["3 réveils : Phase d'envoi"], t0 + 3 * MIN)[0]!.state).toBe("remplacée");
  expect(activePhase(readRoomPhases(dataDir), 6, t0, "Narration")?.text).toMatch(/^Arc du lancement/u);
  expect(activePhase(readRoomPhases(dataDir), 6, t0, "chef de projet")?.text).toBe("Phase d'envoi");
  expect(activePhases(readRoomPhases(dataDir), 6, t0 + 3 * MIN)).toHaveLength(2);

  // Note de réveil du holder : sa phrase, puis celles des autres.
  const note = phaseStatusNote(dataDir, 6, t0 + 3 * MIN, "Narration");
  expect(note).toContain("Ta phrase de phase active dans la salle 6, posée par Narration, l'arc");
  expect(note).toContain("Autres phrases de phase actives dans la salle 6 : posée par Chef de projet");
  expect(phaseStatusNote(dataDir, 6, t0 + 3 * MIN, "Inconnu")).toContain("Tu n'as pas de phrase de phase active dans la salle 6.");

  // Décompte en réveils propre à chaque phrase ; l'expiration de l'une ne retire pas l'autre.
  for (const turn of [2, 3, 4]) roomPhaseWakeLine(dataDir, 6, turn, t0 + 4 * MIN);
  expect(roomPhaseWakeLine(dataDir, 6, 5, t0 + 4 * MIN)).toBe(
    "Phase de la salle 6 (posée par Narration, l'arc) : Arc du lancement : on passe de l'atelier au public — budget restant 14 jours.",
  );
  expect(Object.keys(readRoomPhases(dataDir)["6"]!)).toEqual(["narration"]);

  // « fin » d'un auteur ne retire que sa phrase.
  setRoomPhase(dataDir, 6, "Chef de projet", ["10 min : Relecture"], t0 + 5 * MIN);
  expect(setRoomPhase(dataDir, 6, "Chef de projet", ["fin"], t0 + 6 * MIN)[0]!.state).toBe("retirée");
  expect(activePhases(readRoomPhases(dataDir), 6, t0 + 6 * MIN).map((p) => p.author)).toEqual(["Narration"]);
  expect(setRoomPhase(dataDir, 6, "Chef de projet", ["fin"], t0 + 6 * MIN)[0]!.state).toBe("aucune");
  expect(setRoomPhase(dataDir, 6, "Narration", ["fin"], t0 + 7 * MIN)[0]!.state).toBe("retirée");
  expect(readRoomPhases(dataDir)["6"]).toBeUndefined();
});

it("salle 1 : le fil principal, nommé comme tel au réveil et dans la note du holder", () => {
  const t0 = Date.parse("2026-11-20T09:00:00Z");
  setRoomPhase(dataDir, PRINCIPAL_PHASE_ROOM, "Narration", ["1 j (la journée) : Journée des candidatures"], t0);
  setRoomPhase(dataDir, PRINCIPAL_PHASE_ROOM, "Chef de projet", ["2 réveils (l'heure) : Envoi de l'offre Soda"], t0 + MIN);
  expect(roomPhaseWakeLine(dataDir, PRINCIPAL_PHASE_ROOM, 41, t0 + 2 * MIN)).toBe(
    [
      "Phase de la salle 1 (fil principal) (posée par Narration, la journée) : Journée des candidatures — budget restant 24 heures.",
      "Phase de la salle 1 (fil principal) (posée par Chef de projet, l'heure) : Envoi de l'offre Soda — budget restant 2 réveils.",
    ].join("\n"),
  );
  expect(phaseStatusNote(dataDir, PRINCIPAL_PHASE_ROOM, t0 + 2 * MIN, "Chef de projet")).toContain(
    "Ta phrase de phase active dans la salle 1 (fil principal), posée par Chef de projet, l'heure",
  );
  // Les salles des forks ne sont pas touchées.
  expect(roomPhaseWakeLine(dataDir, 6, 41, t0)).toBeNull();
});

it("gardien des phases : salle sans phrase active (vide ou échue) → rappel d'en poser une, avec le format", () => {
  const t0 = Date.parse("2026-11-20T09:00:00Z");
  const keeper = { keeper: true };
  const vide = phaseStatusNote(dataDir, PRINCIPAL_PHASE_ROOM, t0, "Narration", keeper);
  expect(vide).toContain("Rappel : tu tiens les phases de la salle 1 (fil principal)");
  expect(vide).toContain("aucune phrase de phase active");
  expect(vide).toContain("« 1 j (la journée) : … »");
  // Sans le champ, la note reste neutre.
  expect(phaseStatusNote(dataDir, PRINCIPAL_PHASE_ROOM, t0, "Chef de projet")).not.toContain("Rappel");

  // Une phrase active (même d'un autre holder) : pas de rappel, la note habituelle.
  setRoomPhase(dataDir, PRINCIPAL_PHASE_ROOM, "Chef de projet", ["10 min (l'heure) : Tri"], t0);
  const active = phaseStatusNote(dataDir, PRINCIPAL_PHASE_ROOM, t0 + MIN, "Narration", keeper);
  expect(active).not.toContain("Rappel");
  expect(active).toContain("Autres phrases de phase actives dans la salle 1 (fil principal) : posée par Chef de projet, l'heure");

  // Toutes échues : le rappel revient.
  expect(phaseStatusNote(dataDir, PRINCIPAL_PHASE_ROOM, t0 + 11 * MIN, "Narration", keeper)).toContain("Rappel : tu tiens les phases");
});

it("relit l'ancien format (une phrase par salle) comme la phrase de son auteur", () => {
  const t0 = Date.parse("2026-11-18T16:30:00Z");
  fs.writeFileSync(
    path.join(dataDir, ROOM_PHASE_FILE),
    JSON.stringify({ "6": { text: TRI, author: "Chef de projet", setAt: new Date(t0).toISOString(), until: new Date(t0 + 15 * MIN).toISOString() } }),
  );
  expect(roomPhaseWakeLine(dataDir, 6, 1, t0 + 9 * MIN)).toBe(
    `Phase de la salle 6 (posée par Chef de projet) : ${TRI} — budget restant 6 minutes.`,
  );
  // Le même auteur la remplace ; un autre s'y ajoute.
  expect(setRoomPhase(dataDir, 6, "Chef de projet", ["5 min : Relecture"], t0 + 10 * MIN)[0]!.state).toBe("remplacée");
  setRoomPhase(dataDir, 6, "Narration", ["3 jours : Arc"], t0 + 10 * MIN);
  expect(Object.keys(readRoomPhases(dataDir)["6"]!).sort()).toEqual(["chef de projet", "narration"]);
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
  expect(readRoomPhases(dataDir)["6"]?.["chef"]).toMatchObject({ text: TRI, author: "Chef" });

  answer = "SILENCE";
  clock += 30 * MIN; // phase échue (15 min), nouvelle revue
  await tick();
  expect(seen[1]).toContain("Aucune phrase de phase active dans la salle 6");
  setRoomPhase(dataDir, 6, "Chef", ["3 réveils : Phase d'envoi"], clock);
  clock += 30 * MIN;
  await tick();
  expect(seen[2]).toMatch(/dans la salle 6(, | : )posée par Chef/u); // « Ta phrase… » avec le nom du holder, sinon « Phrases… »
  expect(seen[2]).toContain("encore 3 réveils de la salle sur 3");
});
