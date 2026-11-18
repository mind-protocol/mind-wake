/**
 * Salle présente dans un appel (NLR, 18 nov. 2026 15:55) : « l'appel la fait parler en tour unique,
 * mais à chaque message, donc elle devrait pouvoir répondre, là elle est dans le call ».
 *
 * Incident : appel 6b69022e…, salle 6 désactivée, comme toutes les autres. Le worker des forks
 * s'arrêtait dès que la dernière room passait sur Off (room 2, 15:03:55Z) ; la salle 6 n'a plus
 * répondu qu'une fois (le décroché du serveur de l'app), 44 messages restaient en attente.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCallControls } from "../services/mcp/call-control-store.mjs";
import { setEngineChoice } from "../src/daemon/agent-engine.js";
import { saveForkAssignment, setRoomDisplayName } from "../src/daemon/fork-assignment.js";
import {
  FORK_IDS,
  ONE_SHOT_CAP,
  claimOneShot,
  forkDir,
  forkEnabled,
  oneShotTurns,
  readForks,
  runForks,
  sendNoticeToFork,
  sendToFork,
  setForkEnabled,
} from "../src/daemon/forks.js";
import { CALL_NOTE, callTriggers, mentionsRoom, roomCallPresence } from "../src/daemon/room-call-presence.js";
import { SecondThreadStore } from "../src/daemon/second-thread.js";

const CALL = "6b69022e-2ccd-4215-8e15-c6c6078f7cbc";
let dir: string;
let workspace: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-room-call-"));
  setEngineChoice(dir, "codex");
  workspace = path.join(dir, "workspace");
  fs.mkdirSync(path.join(workspace, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "artifacts/projets-compteur.json"), JSON.stringify({ current: "a", projects: {} }));
  const instructions = path.join(workspace, "room6.md");
  fs.writeFileSync(instructions, "Consigne.");
  saveForkAssignment(forkDir(dir, 6), { instructions, engine: "claude", workspace });
  setRoomDisplayName(forkDir(dir, 6), "Emploi remote");
  // Toutes les rooms sur Off, comme le 18 nov. après 15:03:55Z.
  for (const id of FORK_IDS) setForkEnabled(dir, id, false);
  const store = new SecondThreadStore(forkDir(dir, 6));
  store.set("oneshot-since", "1970-01-01T00:00:00.000Z");
  store.close();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const startCall = (participants: string[], at = Date.now()) => {
  const controls = openCallControls(dir, { now: () => at });
  try { controls.registerCall({ id: CALL, epoch: 1, participants }); } finally { controls.close(); }
};

const run = async () => {
  const calls: { id: number; message: string }[] = [];
  await runForks({
    dataDir: dir, workspace, profile: () => "run", claudeProfile: () => "run", maxTurns: 1, telegramInbound: false,
    telegramReply: async () => undefined,
    // Mémoire du poste hors sujet ici (porte mémoire de memory-pressure.ts).
    freeMemory: () => 64 * 1024 ** 3,
    claudeTurn: async (input) => {
      calls.push({ id: input.id, message: input.message });
      return { outcome: "completed", text: "Emploi remote : réponse", tokens: null, accepted: true, detail: null, retryAtMs: null, sessionId: "s" };
    },
  });
  return calls;
};

describe("présence d'une salle dans un appel", () => {
  it("lit l'appel actif et ses participants ; ignore un appel terminé, périmé ou sans la salle", () => {
    expect(roomCallPresence(dir, 6)).toBeNull();
    const at = Date.now();
    startCall(["marco", "mind", "room-6", "room6"], at);
    expect(roomCallPresence(dir, 6, [], at)).toEqual({ callId: CALL, since: at });
    expect(roomCallPresence(dir, 2, [], at)).toBeNull();
    // Plus de nouvelles de l'app depuis 2 min : l'appel ne compte plus.
    expect(roomCallPresence(dir, 6, [], at + 121_000)).toBeNull();
    const controls = openCallControls(dir);
    try { controls.markEnded({ id: CALL, epoch: 1 }); } finally { controls.close(); }
    expect(roomCallPresence(dir, 6)).toBeNull();
  });

  it("reconnaît un agent de la salle comme participant", () => {
    startCall(["marco", "se-vendre"]);
    expect(roomCallPresence(dir, 6, ["se-vendre"])?.callId).toBe(CALL);
    expect(roomCallPresence(dir, 6, ["explorer"])).toBeNull();
  });

  it("détecte une mention : @room6, nom de la salle (sans accents ni casse), nom ou @id d'un agent", () => {
    expect(mentionsRoom("@room6 tu en penses quoi ?", 6)).toBe(true);
    expect(mentionsRoom("@room-6, à toi", 6)).toBe(true);
    expect(mentionsRoom("@room60 non", 6)).toBe(false);
    expect(mentionsRoom("Et toi, EMPLOI REMOTE ?", 6, ["Emploi remote"])).toBe(true);
    expect(mentionsRoom("@se-vendre, le salaire ?", 6, [], ["se-vendre"])).toBe(true);
    expect(mentionsRoom("Se vendre, tu proposes un salaire ?", 6, ["Se vendre"])).toBe(true);
    expect(mentionsRoom("rien pour la salle", 6, ["Emploi remote", "Room 6"])).toBe(false);
  });

  it("déclencheurs : messages humains de l'appel et ceux qui la mentionnent, jamais une autre room", () => {
    const store = new SecondThreadStore(forkDir(dir, 6));
    store.add("human", "avant l'appel");
    store.close();
    const since = Date.now() + 1;
    while (Date.now() <= since) { /* l'appel commence après le message précédent */ }
    sendToFork(dir, 6, "[Appel vocal en cours] NLR : où en est la salle ?", "telegram-route:call-a1", "telegram", undefined, [], true);
    sendNoticeToFork(dir, 6, "[Appel] Marco : Emploi remote, ton avis ?", "call-copy-0000001", "Appel");
    sendNoticeToFork(dir, 6, "[Appel] Marco : je regarde les journaux.", "call-copy-0000002", "Appel");
    sendToFork(dir, 6, "FYI — Room 2 : @room6 statut", "status:abcdefgh", "", 2);
    const s = new SecondThreadStore(forkDir(dir, 6));
    const triggers = callTriggers(s, { callId: CALL, since }, (e) => mentionsRoom(e.text, 6, ["Emploi remote"]));
    expect(triggers.map((e) => e.text)).toEqual([
      "[Appel vocal en cours] NLR : où en est la salle ?",
      "[Appel] Marco : Emploi remote, ton avis ?",
    ]);
    s.close();
  });
});

describe("worker des forks : une salle désactivée présente dans un appel répond à chaque message", () => {
  it("le worker reste vivant quand toutes les rooms sont sur Off, et la salle de l'appel répond", async () => {
    startCall(["marco", "mind", "room-6", "room6"], Date.now() - 1000);
    sendToFork(dir, 6, "[Appel vocal en cours] NLR : la salle six, tu m'entends ?", "telegram-route:call-b1", "telegram", undefined, [], true);
    const calls = await run();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe(6);
    expect(calls[0]?.message).toContain(CALL_NOTE);
    expect(calls[0]?.message).toContain("tu m'entends ?");
    // Off reste Off : enabled.json n'est jamais modifié.
    expect(forkEnabled(dir, 6)).toBe(false);
    expect(readForks(dir, workspace).workerNeeded).toBe(true);
  });

  it("une mention dans une copie d'appel donne un tour ; une copie qui ne la mentionne pas, non", async () => {
    startCall(["marco", "room6"], Date.now() - 1000);
    sendNoticeToFork(dir, 6, "[Appel] Marco : je regarde les journaux.", "call-copy-0000010", "Appel");
    expect(await run()).toHaveLength(0);
    sendNoticeToFork(dir, 6, "[Appel] Marco : @room6, le salaire visé ?", "call-copy-0000011", "Appel");
    const calls = await run();
    expect(calls).toHaveLength(1);
    // La copie précédente est remise avec, comme contexte.
    expect(calls[0]?.message).toContain("je regarde les journaux.");
    expect(calls[0]?.message).toContain("le salaire visé ?");
  });

  it("pas de plafond ni d'intervalle pendant l'appel, et jamais deux réponses au même message", async () => {
    startCall(["room6"], Date.now() - 1000);
    const store = new SecondThreadStore(forkDir(dir, 6));
    const now = Date.now();
    store.set("oneshot-turns", JSON.stringify(Array.from({ length: ONE_SHOT_CAP }, (_, i) => now - i * 1000)));
    store.close();
    for (let i = 0; i < 3; i++) {
      sendToFork(dir, 6, `[Appel vocal en cours] NLR : question ${String(i)}`, `telegram-route:call-c${String(i)}`, "telegram", undefined, [], true);
      const calls = await run();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.message).toContain(`question ${String(i)}`);
    }
    // Plus rien en attente : un nouveau passage ne relance rien.
    expect(await run()).toHaveLength(0);
    const after = new SecondThreadStore(forkDir(dir, 6));
    expect(after.pendingHuman()).toEqual([]);
    expect(after.entries().filter((e) => e.role === "agent")).toHaveLength(3);
    // Les tours d'appel ne consomment pas le plafond des tours uniques ordinaires.
    expect(oneShotTurns(after)).toHaveLength(ONE_SHOT_CAP);
    after.close();
  });

  it("hors appel, une salle désactivée garde le plafond des tours uniques", async () => {
    const store = new SecondThreadStore(forkDir(dir, 6));
    const now = Date.now();
    store.set("oneshot-turns", JSON.stringify(Array.from({ length: ONE_SHOT_CAP }, (_, i) => now - i * 1000)));
    store.close();
    sendToFork(dir, 6, "message Telegram hors appel", "telegram-route:msg-d1", "telegram", undefined, [], true);
    const s = new SecondThreadStore(forkDir(dir, 6));
    const pending = s.pendingHuman();
    expect(roomCallPresence(dir, 6)).toBeNull();
    expect(claimOneShot(s, pending, now, undefined, 6)).toBeNull();
    // La même réservation, dans un appel, passe.
    expect(claimOneShot(s, pending, now, undefined, 6, true)?.map((e) => e.text)).toEqual(["message Telegram hors appel"]);
    s.close();
  });
});
