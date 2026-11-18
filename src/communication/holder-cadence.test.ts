/**
 * Holders cadencés (NLR, 18 nov. 2026 15:59Z : « le manager du budget ») : réveil tous les N
 * tours de la salle ou toutes les N minutes. Appels Claude simulés, aucun appel fournisseur.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { callClaude as CallClaude } from "./fast-reply.js";
import { readOwnerMessages } from "./owner-messages.js";
import { forkDir, sendToFork, setForkEnabled } from "../daemon/forks.js";
import { saveForkAssignment } from "../daemon/fork-assignment.js";
import { SecondThreadStore } from "../daemon/second-thread.js";
import { parsePatternHolder, tickPatternHolders } from "./pattern-holders.js";
import Database from "better-sqlite3";
import {
  cadenceDue,
  callSituation,
  holderCallKeys,
  parseCadence,
  readCadenceState,
  reviewCallNote,
} from "./holder-cadence.js";
import { addAlarms, extractAlarms, parseAlarmLine, readAlarms } from "./holder-alarms.js";

let dataDir: string;
let holdersDir: string;
let space: string;
let clock: number;
const claude = { executable: "unused", model: "sonnet" };
const now = () => clock;
const MIN = 60_000;

const holderFile = (header: Record<string, unknown>) => `\`\`\`json pattern-holder
${JSON.stringify({ name: "Budget", emoji: "⏳", wake: "mention", ...header })}
\`\`\`

(semence d'exemple pour les tests)
`;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "holders-cadence-"));
  holdersDir = path.join(dataDir, "workspace", "artifacts", "pattern-holders");
  fs.mkdirSync(path.join(holdersDir, "budget"), { recursive: true });
  space = path.join(dataDir, "room");
  fs.mkdirSync(space, { recursive: true });
  fs.writeFileSync(path.join(space, "ROOM.md"), "Tu es la room.");
  clock = Date.now() + MIN;
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const declare = (header: Record<string, unknown>) =>
  fs.writeFileSync(path.join(holdersDir, "budget", "_holder.md"), holderFile(header));
const openRoom = (id: number) => {
  saveForkAssignment(forkDir(dataDir, id), { instructions: path.join(space, "ROOM.md"), engine: "claude", workspace: space });
  setForkEnabled(dataDir, id, true);
};
const turns = (id: number, count: number) => {
  const store = new SecondThreadStore(forkDir(dataDir, id));
  try {
    for (let i = 0; i < count; i++) store.endTurn(store.beginTurn(null), "done", null);
  } finally {
    store.close();
  }
};
const roomAgentTexts = (id: number) => {
  const store = new SecondThreadStore(forkDir(dataDir, id));
  try {
    return store.entries(50).filter((e) => e.role === "agent").map((e) => e.text);
  } finally {
    store.close();
  }
};
const replying =
  (text: string, seen: string[] = []): typeof CallClaude =>
  (_claude, _args, prompt) => {
    seen.push(prompt);
    return Promise.resolve({ text });
  };
const tick = (call: typeof CallClaude) => tickPatternHolders({ dataDir, claude, call, now });

it("parses cadence and room, treats 0 as disabled and rejects malformed values", () => {
  expect(parseCadence({ everyWakes: 5 }, 6)).toEqual({ cadence: { everyWakes: 5, everyMinutes: 0 }, room: 6 });
  expect(parseCadence({ everyMinutes: 30 }, undefined)).toEqual({ cadence: { everyWakes: 0, everyMinutes: 30 } });
  expect(parseCadence({ everyWakes: 0, everyMinutes: 0 }, undefined)).toEqual({});
  expect(parseCadence(undefined, undefined)).toEqual({});
  expect(parseCadence({ everyWakes: -1 }, undefined)).toHaveProperty("error");
  expect(parseCadence({ every: 5 }, undefined)).toHaveProperty("error");
  expect(parseCadence({ everyWakes: 5 }, 42)).toHaveProperty("error");
  const parsed = parsePatternHolder("budget.md", holderFile({ cadence: { everyWakes: 5 }, room: 6 }));
  expect("holder" in parsed && parsed.holder.cadence).toEqual({ everyWakes: 5, everyMinutes: 0 });
  expect("holder" in parsed && parsed.holder.room).toBe(6);
  expect(parsePatternHolder("budget.md", holderFile({ cadence: "souvent" }))).toHaveProperty("error");
});

it("wakes every N turns of its room, with the room thread and no register, and speaks only in the room", async () => {
  openRoom(6);
  declare({ cadence: { everyWakes: 5 }, room: 6 });
  // Un ancien registre n'est plus lu (NLR 16:13Z : « on fait pas des registres »).
  fs.writeFileSync(path.join(space, "BUDGET.md"), "| offre | état |\n| Acme | prête |\n");
  turns(6, 3);
  const seen: string[] = [];
  const call = replying("Acme est assez bonne pour partir : envoie-la.", seen);
  expect(await tick(call)).toEqual([]); // premier passage : référence posée
  expect(readCadenceState(dataDir)["budget"]).toMatchObject({ thread: "fork:6", lastWakes: 3 });

  turns(6, 4);
  clock += MIN;
  expect(await tick(call)).toEqual([]);
  sendToFork(dataDir, 6, "On postule aux quatre offres ?");
  turns(6, 1);
  clock = Date.now() + 2 * MIN;
  const outcomes = await tick(call);
  expect(outcomes).toEqual([expect.objectContaining({ slug: "budget", state: "spoke", reason: "cadence" })]);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain("Réveil cadencé (tous les 5 réveils)");
  expect(seen[0]).toContain("5 réveil(s)");
  expect(seen[0]).not.toContain("| Acme | prête |");
  expect(seen[0]).toContain("Pas de registre : ton plan est dans tes sections");
  expect(seen[0]).toContain("call_human");
  expect(seen[0]).toContain("On postule aux quatre offres ?");
  // Le faux modèle n'a pas appelé : le fil le dit.
  expect(roomAgentTexts(6)).toEqual([
    "⏳ Budget · Acme est assez bonne pour partir : envoie-la.",
    "⏳ Budget · (revue cadencée : aucun appel à NLR n'est parti)",
  ]);
  expect(readCadenceState(dataDir)["budget"]?.lastResult).toMatchObject({ call: "missing" });
  expect(readOwnerMessages(dataDir) ?? []).toEqual([]);

  // Pas de doublon : rien de neuf, aucun appel.
  clock += MIN;
  expect(await tick(call)).toEqual([]);
  expect(seen).toHaveLength(1);
});

it("wakes every N minutes on the principal, once per interval", async () => {
  declare({ cadence: { everyMinutes: 30 } });
  const seen: string[] = [];
  const call = replying("SILENCE", seen);
  expect(await tick(call)).toEqual([]);
  clock += 29 * MIN;
  expect(await tick(call)).toEqual([]);
  clock += MIN;
  expect(await tick(call)).toEqual([expect.objectContaining({ slug: "budget", state: "silent", reason: "cadence" })]);
  expect(seen[0]).toContain("toutes les 30 minutes");
  expect(seen[0]).toContain("30 minute(s)");
  expect(seen[0]).toContain("Pas de registre");
  expect(await tick(call)).toEqual([]);
  clock += 30 * MIN;
  expect(await tick(call)).toHaveLength(1);
  expect(seen).toHaveLength(2);
});

it("does not catch up in a burst after a long pause, by minutes or by turns", async () => {
  openRoom(6);
  declare({ cadence: { everyWakes: 5, everyMinutes: 30 }, room: 6 });
  const seen: string[] = [];
  const call = replying("SILENCE", seen);
  await tick(call);
  clock += 10 * 60 * MIN; // dix heures : vingt intervalles
  turns(6, 50); // cinquante tours : dix intervalles
  expect(await tick(call)).toHaveLength(1);
  expect(seen[0]).toContain("50 réveil(s)");
  for (let i = 0; i < 5; i++) {
    clock += MIN;
    expect(await tick(call)).toEqual([]);
  }
  expect(seen).toHaveLength(1);
  expect(readCadenceState(dataDir)["budget"]).toMatchObject({ lastWakes: 50, lastResult: { state: "silent" } });
});

it("stays asleep while its room is disabled, and copies to the principal only when NLR is named", async () => {
  openRoom(6);
  setForkEnabled(dataDir, 6, false);
  declare({ cadence: { everyMinutes: 10 }, room: 6 });
  const call = replying("NLR, la salle hésite entre deux offres : à toi de trancher.");
  await tick(call);
  expect(readCadenceState(dataDir)["budget"]).toBeUndefined();
  setForkEnabled(dataDir, 6, true);
  await tick(call);
  clock += 10 * MIN;
  expect(await tick(call)).toHaveLength(1);
  expect(roomAgentTexts(6)).toHaveLength(2); // sa revue, et « aucun appel n'est parti »
  const principal = (readOwnerMessages(dataDir) ?? []).map((m) => m.text);
  expect(principal).toEqual([expect.stringContaining("⏳ Budget · (Fil du fork 6) NLR, la salle hésite")]);
});

it("computes the due interval from either threshold", () => {
  const entry = { thread: "principal", lastAt: new Date(0).toISOString(), lastWakes: 10 };
  expect(cadenceDue({ everyWakes: 5, everyMinutes: 0 }, entry, 14, 99 * MIN)).toBeNull();
  expect(cadenceDue({ everyWakes: 5, everyMinutes: 0 }, entry, 15, 0)).toMatchObject({ by: "wakes", wakes: 5 });
  expect(cadenceDue({ everyWakes: 0, everyMinutes: 30 }, entry, null, 30 * MIN)).toMatchObject({ by: "minutes" });
  expect(cadenceDue({ everyWakes: 5, everyMinutes: 0 }, entry, null, 99 * MIN)).toBeNull();
});

// ---------------------------------------------------------------- appel de revue (NLR 16:15Z)

const ringingBook = () => {
  const db = new Database(path.join(dataDir, "mobile-calls.sqlite"));
  db.exec("CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY, human TEXT NOT NULL, caller TEXT NOT NULL, label TEXT NOT NULL, until INTEGER NOT NULL, decision TEXT)");
  return db;
};
const callStore = () => {
  const db = new Database(path.join(dataDir, "mobile-call-control.sqlite"));
  db.exec("CREATE TABLE IF NOT EXISTS call_control_sessions(id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, state TEXT NOT NULL, participants TEXT NOT NULL, started_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, ended_at INTEGER, ended_by TEXT)");
  return db;
};
const CALL_ID = "0b6f2a4e-8d1c-4f3a-9b2e-5c7d8e9f0a1b";

it("asks for call_human when no call is active, and records that the call was queued", async () => {
  openRoom(6);
  declare({ cadence: { everyMinutes: 30 }, room: 6 });
  const seen: string[] = [];
  // Le faux modèle fait ce que ferait call_human : une invitation de 45 s, appelant « budget ».
  const call: typeof CallClaude = (_c, _a, prompt) => {
    seen.push(prompt);
    const db = ringingBook();
    try {
      db.prepare("INSERT INTO invitations VALUES(?,?,?,?,?,NULL)").run("inv-1", "nlr", "budget", "Budget", clock + 45_000);
    } finally {
      db.close();
    }
    return Promise.resolve({ text: "Deux offres parties sur trois ; la rédaction a pris dix minutes de plus que prévu." });
  };
  await tick(call);
  clock += 30 * MIN;
  expect(await tick(call)).toHaveLength(1);
  expect(seen[0]).toContain("appelle NLR avec l'outil call_human");
  expect(seen[0]).toContain("ce qui a été envoyé, l'écart avec le partage du temps");
  expect(roomAgentTexts(6)).toEqual(["⏳ Budget · Deux offres parties sur trois ; la rédaction a pris dix minutes de plus que prévu."]);
  expect(readCadenceState(dataDir)["budget"]?.lastResult).toMatchObject({ call: "rang" });
});

it("speaks in the call already in progress instead of ringing", async () => {
  openRoom(6);
  declare({ cadence: { everyMinutes: 30 }, room: 6 });
  const seen: string[] = [];
  const call: typeof CallClaude = (_c, _a, prompt) => {
    seen.push(prompt);
    // invite_to_call réglé par le serveur de l'app : le holder figure parmi les participants.
    const db = callStore();
    try {
      db.prepare("UPDATE call_control_sessions SET participants=? WHERE id=?").run(JSON.stringify(["budget", "nlr", "viz"]), CALL_ID);
    } finally {
      db.close();
    }
    return Promise.resolve({ text: "Rien n'a bougé depuis la dernière revue : l'offre 3 attend la réponse d'Acme." });
  };
  await tick(call);
  clock += 30 * MIN;
  const db = callStore();
  try {
    db.prepare("INSERT INTO call_control_sessions VALUES(?,1,'active',?,?,?,NULL,NULL)").run(CALL_ID, JSON.stringify(["nlr", "viz"]), clock - MIN, clock);
  } finally {
    db.close();
  }
  expect(await tick(call)).toHaveLength(1);
  expect(seen[0]).toContain("Un appel est en cours avec NLR : ne fais pas sonner");
  expect(seen[0]).toContain('invite_to_call (target "budget"');
  expect(seen[0]).not.toContain("call_human");
  expect(readCadenceState(dataDir)["budget"]?.lastResult).toMatchObject({ call: "joined" });
  expect(roomAgentTexts(6)).toHaveLength(1);
  expect(callSituation(dataDir, holderCallKeys("budget", "budget", 6), clock)).toEqual({ state: "joined", callId: CALL_ID });
  expect(reviewCallNote("budget", { state: "joined", callId: CALL_ID })).toContain("Tu es déjà dans l'appel");
});

// ---------------------------------------------------------------- réveils programmés (NLR 16:14Z)

it("parses alarm lines: relative, clock time, ISO date, cancel, errors", () => {
  const base = new Date(2026, 10, 18, 16, 20, 0).getTime();
  expect(parseAlarmLine("dans 10 min : passer à la rédaction", base)).toEqual({ at: base + 10 * MIN, note: "passer à la rédaction" });
  expect(parseAlarmLine("+5 envoyer", base)).toEqual({ at: base + 5 * MIN, note: "envoyer" });
  expect(parseAlarmLine("dans 1 h — point complet", base)).toEqual({ at: base + 60 * MIN, note: "point complet" });
  expect(parseAlarmLine("à 16:45 : envoyer les offres", base)).toEqual({ at: new Date(2026, 10, 18, 16, 45).getTime(), note: "envoyer les offres" });
  expect(parseAlarmLine("16h45 envoyer", base)).toMatchObject({ at: new Date(2026, 10, 18, 16, 45).getTime() });
  // Heure passée : le lendemain.
  expect(parseAlarmLine("à 9:00 : reprendre", base)).toMatchObject({ at: new Date(2026, 10, 19, 9, 0).getTime() });
  expect(parseAlarmLine("2026-11-18T17:00:00Z : bilan", base)).toEqual({ at: Date.parse("2026-11-18T17:00:00Z"), note: "bilan" });
  expect(parseAlarmLine("annuler", base)).toEqual({ cancel: true });
  expect(parseAlarmLine("bientôt : rédiger", base)).toHaveProperty("error");
  expect(parseAlarmLine("à 25:00 : rédiger", base)).toHaveProperty("error");
  expect(extractAlarms("Je découpe.\n```reveil\n- dans 10 min : rédiger\n\nà 16:45 : envoyer\n```\nÀ tout à l'heure.")).toEqual({
    text: "Je découpe.\n\nÀ tout à l'heure.",
    lines: ["dans 10 min : rédiger", "à 16:45 : envoyer"],
  });
});

it("lets a holder program its own wakes, delivers the note once, merges overdue ones, and never rings for them", async () => {
  openRoom(6);
  declare({ cadence: { everyMinutes: 60 }, room: 6 });
  const seen: string[] = [];
  let answer = "Dix minutes d'idéation sur l'offre 2.\n```reveil\ndans 10 min : passer à la rédaction de l'offre 2\ndans 10 min : passer à la rédaction de l'offre 2\n```";
  const call: typeof CallClaude = (_c, _a, prompt) => {
    seen.push(prompt);
    return Promise.resolve({ text: answer });
  };
  await tick(call); // référence de cadence
  clock += 60 * MIN;
  expect(await tick(call)).toHaveLength(1); // revue cadencée, où il se programme un réveil
  const posted = roomAgentTexts(6)[0]!;
  expect(posted).toMatch(/^⏳ Budget · Dix minutes d'idéation sur l'offre 2\.\n\(réveil programmé à \d\d:\d\d : passer à la rédaction de l'offre 2\)\n\(réveil déjà programmé à \d\d:\d\d/u);
  expect(posted).not.toContain("```");
  expect(readAlarms(dataDir)["budget"]).toHaveLength(1);

  answer = "SILENCE";
  clock += 9 * MIN;
  expect(await tick(call)).toEqual([]);
  clock += MIN;
  expect(await tick(call)).toEqual([expect.objectContaining({ slug: "budget", state: "silent", reason: "cadence" })]);
  expect(seen[1]).toContain("Réveil que tu t'es programmé");
  expect(seen[1]).toContain("passer à la rédaction de l'offre 2");
  expect(seen[1]).not.toContain("call_human");
  expect(readAlarms(dataDir)["budget"]).toBeUndefined();
  clock += MIN;
  expect(await tick(call)).toEqual([]); // pas deux fois
  // « aucun appel » pour la revue cadencée seulement, pas pour le réveil programmé.
  expect(roomAgentTexts(6).filter((t) => t.includes("aucun appel"))).toHaveLength(1);

  // Deux réveils échus pendant que la salle dormait : rien tant qu'elle dort, puis un seul réveil.
  addAlarms(dataDir, "budget", ["dans 5 min : rédiger", "dans 8 min : envoyer"], clock);
  setForkEnabled(dataDir, 6, false);
  clock += 20 * MIN;
  expect(await tick(call)).toEqual([]);
  setForkEnabled(dataDir, 6, true);
  expect(await tick(call)).toHaveLength(1);
  expect(seen[2]).toContain("rédiger");
  expect(seen[2]).toContain("envoyer");
  expect(seen[2]).toContain("en retard de");
  expect(await tick(call)).toEqual([]);
  expect(seen).toHaveLength(3);
});
