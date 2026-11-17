/**
 * Routage des messages Telegram entrants vers le coach de la personne (NLR, 16 nov. 2026 13:04 et
 * 13:07) : remis à sa session seule (file privée), rien dans le fil commun sauf un compte, messages
 * de NLR écrits à la main inclus, aucun doublon. Faux sidecar : aucun appel réel.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { forkDir } from "./forks.js";
import { pollTelegramCoachInbound, TELEGRAM_INBOUND_STATE, type InboundSidecar } from "./telegram-coach-inbound.js";
import { readRoomRelays, runRoomAgentsTurn } from "./room-agents.js";
import { SecondThreadStore } from "./second-thread.js";
import { readForkAssignment, saveForkAssignment, type runAssignedClaudeTurn } from "./fork-assignment.js";

let dataDir: string, workspace: string, holders: string;
let requests: { peers: { key: string; target: string; after: number | null }[] }[];
let answer: (req: { peers: { key: string; target: string; after: number | null }[] }) => Record<string, unknown>;
const sidecar: InboundSidecar = async (stdin) => {
  const req = JSON.parse(stdin) as { peers: { key: string; target: string; after: number | null }[] };
  requests.push(req);
  return answer(req);
};
const coach = (id: string, title: string, contacts?: unknown) => {
  fs.mkdirSync(path.join(holders, id), { recursive: true });
  fs.writeFileSync(path.join(holders, id, "_holder.md"), `# ${title}\n`);
  if (contacts !== undefined) fs.writeFileSync(path.join(holders, id, "contacts.json"), JSON.stringify(contacts));
};
const room = () => path.join(dataDir, "forks", "2");
const poll = () => pollTelegramCoachInbound({ dataDir, sidecar, rooms: [2] });
const store = () => new SecondThreadStore(room());

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-inbound-"));
  workspace = path.join(dataDir, "workspace");
  holders = path.join(workspace, "artifacts", "pattern-holders");
  fs.mkdirSync(path.join(workspace, "room-fixeurs"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "room-fixeurs", "ROOM2.md"), "# Room 2\n");
  fs.writeFileSync(path.join(dataDir, "telegram-user.session"), "");
  coach("coach-des-coachs", "Coach des coachs");
  coach("coach-colony", "Coach Colony");
  coach("coach-telegram", "Coach Telegram", [{ name: "Léo", username: "@leo", id: 42 }]);
  coach("coach-telegram-2", "Coach Telegram 2", [{ name: "Aurore", username: "@aurore", id: 77 }]);
  coach("coach-telegram-3", "Coach Telegram 3"); // sans contacts.json : ignoré
  saveForkAssignment(forkDir(dataDir, 2), {
    instructions: path.join(workspace, "room-fixeurs", "ROOM2.md"),
    engine: "claude",
    workspace,
    inbox: "explicit",
    agentsFrom: { dir: "artifacts/pattern-holders", prefix: "coach-", exclude: ["coach-des-coachs"], hub: "coach-des-coachs" },
  });
  requests = [];
  answer = (req) => ({ ok: true, peers: req.peers.map((p) => ({ key: p.key, ok: true, last_id: 10, messages: [] })) });
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

it("premier passage : point de départ seulement ; ensuite, remise au seul coach de la personne, NLR manuel inclus, sans doublon", async () => {
  expect(await poll()).toEqual({ delivered: 0 });
  expect(requests[0]!.peers).toEqual([
    { key: "coach-telegram|42", target: "@leo", after: null },
    { key: "coach-telegram-2|77", target: "@aurore", after: null },
  ]);
  expect(JSON.parse(fs.readFileSync(path.join(room(), TELEGRAM_INBOUND_STATE), "utf8"))).toEqual({
    "coach-telegram|42": 10,
    "coach-telegram-2|77": 10,
  });
  // Message 11 envoyé par l'outil du coach (journalisé), 12 écrit à la main par NLR, 13 de Léo.
  const db = new Database(path.join(dataDir, "telegram.sqlite"));
  db.exec("CREATE TABLE user_outgoing(key TEXT PRIMARY KEY,target TEXT,text TEXT,at TEXT,status TEXT,message_id TEXT,peer_id TEXT,peer_name TEXT)");
  db.prepare("INSERT INTO user_outgoing VALUES('coach:coach-telegram:k1','@leo','x','2026-11-16T12:00:00Z','sent','11','42','Léo')").run();
  db.close();
  answer = (req) => ({
    ok: true,
    peers: req.peers.map((p) =>
      p.key === "coach-telegram|42"
        ? {
            key: p.key,
            ok: true,
            last_id: 13,
            messages: [
              { id: 11, author: "moi", date: "d11", text: "envoyé par le coach", media: false },
              { id: 12, author: "moi", date: "d12", text: "mot de NLR à la main", media: false },
              { id: 13, author: "lui", date: "d13", text: "Salut, partant !", media: false },
            ],
          }
        : { key: p.key, ok: true, last_id: 10, messages: [] },
    ),
  });
  expect(await poll()).toEqual({ delivered: 1 });
  const s = store();
  try {
    const relays = readRoomRelays(s);
    expect(relays).toHaveLength(1);
    expect(relays[0]).toMatchObject({ to: ["coach-telegram"], label: "Telegram (privé)" });
    const text = relays[0]!.text;
    expect(text).toContain("[d12] NLR (écrit à la main) : mot de NLR à la main");
    expect(text).toContain("[d13] Léo : Salut, partant !");
    expect(text.indexOf("d12")).toBeLessThan(text.indexOf("d13"));
    expect(text).not.toContain("envoyé par le coach");
    // Fil commun : aucune entrée humaine, seulement un compte sans nom ni contenu.
    const entries = s.entries(50);
    expect(entries.filter((e) => e.role === "human")).toHaveLength(0);
    const events = entries.filter((e) => e.role === "event").map((e) => e.text);
    expect(events).toEqual(["Coach Telegram : 1 nouvelle réponse Telegram (remise à lui seul)."]);
    expect(events.join(" ")).not.toContain("Léo");
  } finally {
    s.close();
  }
  // Même réponse au passage suivant (curseur à 13) : rien de nouveau, aucun doublon.
  expect(requests[2]).toBeUndefined();
  await poll();
  expect(requests[2]!.peers.find((p) => p.key === "coach-telegram|42")!.after).toBe(13);
  const s2 = store();
  try {
    expect(readRoomRelays(s2)).toHaveLength(1);
  } finally {
    s2.close();
  }
});

it("messages de NLR seuls : en attente de la réponse de la personne, puis remis avec elle", async () => {
  await poll();
  answer = (req) => ({
    ok: true,
    peers: req.peers.map((p) => ({
      key: p.key,
      ok: true,
      last_id: p.key === "coach-telegram-2|77" ? 11 : 10,
      messages: p.key === "coach-telegram-2|77" ? [{ id: 11, author: "moi", date: "d11", text: "relance", media: false }] : [],
    })),
  });
  expect(await poll()).toEqual({ delivered: 0 });
  expect(JSON.parse(fs.readFileSync(path.join(room(), TELEGRAM_INBOUND_STATE), "utf8"))["coach-telegram-2|77"]).toBe(10);
  // Erreur du sidecar : rien n'avance, rien n'est remis.
  answer = () => ({ ok: false, error: "network" });
  expect(await poll()).toEqual({ delivered: 0 });
  // Pas de session : aucun appel.
  fs.rmSync(path.join(dataDir, "telegram-user.session"));
  const before = requests.length;
  expect(await poll()).toMatchObject({ skipped: "no_session" });
  expect(requests).toHaveLength(before);
});

it("le tour de la room réveille ce coach seul, avec l'étiquette privée ; le hub et les autres coachs ne reçoivent rien", async () => {
  await poll();
  answer = (req) => ({
    ok: true,
    peers: req.peers.map((p) => ({
      key: p.key,
      ok: true,
      last_id: 20,
      messages: p.key === "coach-telegram-2|77" ? [{ id: 20, author: "lui", date: "d20", text: "Coucou", media: false }] : [],
    })),
  });
  await poll();
  const calls: { agent: string; message: string }[] = [];
  const claudeTurn = (async (i: Parameters<typeof runAssignedClaudeTurn>[0]) => {
    calls.push({ agent: i.agent!.key, message: i.message });
    return { sessionId: "s", outcome: "completed", text: "SILENCE", tokens: 1, accepted: true, detail: null, retryAtMs: null };
  }) as unknown as typeof runAssignedClaudeTurn;
  const s = store();
  try {
    const n = s.beginTurn(null);
    await runRoomAgentsTurn({
      dataDir,
      dir: room(),
      id: 2,
      assignment: readForkAssignment(room())!,
      store: s,
      human: [],
      n,
      control: () => "run",
      claudeTurn,
    });
    expect(calls.map((c) => c.agent.split(":agent:")[1]!.split(":")[0])).toEqual(["coach-telegram-2"]);
    expect(calls[0]!.message).toContain("message privé remis à toi seul");
    expect(calls[0]!.message).toContain("Telegram (privé) [");
    expect(calls[0]!.message).toContain("Aurore : Coucou");
    expect(readRoomRelays(s)).toHaveLength(0);
  } finally {
    s.close();
  }
});
