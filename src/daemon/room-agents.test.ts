/**
 * Room à plusieurs agents (mandat du 16 nov. 2026 : « un agent par coach », « tous les coachs
 * dans la même room ») : tours Claude simulés, aucun appel fournisseur.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forkDir, forkEnabled, runForks, sendNoticeToFork, sendToFork, setForkEnabled } from "./forks.js";
import {
  DEFAULT_TELEGRAM_READABLE,
  assignedForkPrompt,
  detectRoomAgents,
  readForkAssignment,
  resolveRoomAgents,
  roomAgentMcpConfig,
  saveForkAssignment,
  validateAssignment,
  type RoomAgent,
  type runAssignedClaudeTurn,
} from "./fork-assignment.js";
import {
  COACH_GUARD,
  MAX_RELAY_DEPTH,
  PRIVATE_ROOM_COACH_NOTE,
  namedAgents,
  readRoomRelays,
  roomAgentPrompt,
  roomAgentReadable,
  routeRoomMessage,
  runRoomAgentsTurn,
} from "./room-agents.js";
import { SecondThreadStore } from "./second-thread.js";

type TurnInput = Parameters<typeof runAssignedClaudeTurn>[0];

let dir: string, workspace: string, holders: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-agents-"));
  workspace = path.join(dir, "workspace");
  holders = path.join(workspace, "artifacts", "pattern-holders");
  // Coach Colony : dossier de holder, avec preuves dans sources/ (pas des sections).
  const colony = path.join(holders, "coach-colony");
  fs.mkdirSync(path.join(colony, "sources"), { recursive: true });
  fs.writeFileSync(path.join(colony, "_holder.md"), "# Coach Colony\nJe suis le coach Colony.");
  fs.writeFileSync(path.join(colony, "README.md"), "Fiches de Spark.");
  fs.writeFileSync(path.join(colony, "sources", "post.md"), "PREUVE-BRUTE");
  // Coach Colony 2 : dossier sans _holder.md.
  fs.mkdirSync(path.join(holders, "coach-colony-2"), { recursive: true });
  fs.writeFileSync(path.join(holders, "coach-colony-2", "README.md"), "Coach Colony 2, cinq agents.");
  // Coach Telegram : _holder.md et une section par personne, en sous-dossier.
  const tg = path.join(holders, "coach-telegram");
  fs.mkdirSync(path.join(tg, "marie"), { recursive: true });
  fs.writeFileSync(path.join(tg, "_holder.md"), "# Coach Telegram\nTout reste privé.");
  fs.writeFileSync(path.join(tg, "marie", "scene.md"), "Scène recréée avec Marie.");
  fs.writeFileSync(
    path.join(holders, "COACHS-REGISTRE.json"),
    JSON.stringify({
      coachs: { "coach-telegram": { nom: "Coach Telegram", prive: true } },
      personnes: [
        { id: "spark-the-cat", coach: "coach-colony", handles: [{ handle: "spark-the-cat" }], fiche: "coach-colony/spark.md" },
        { id: "marie", coach: "coach-telegram", handles: [{ handle: "marie_t" }] },
      ],
    }),
  );
  fs.mkdirSync(path.join(workspace, "room-fixeurs"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "room-fixeurs", "ROOM2.md"), "Room 2 commune.");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const AGENTS = () => [
  {
    id: "coach-colony",
    name: "Coach Colony",
    instructions: path.join(holders, "coach-colony"),
    writable: ["artifacts/pattern-holders/coach-colony"],
    owner: { colony: "colony-fixeur.json", profile: "publish" },
    tools: "publish",
  },
  {
    id: "coach-colony-2",
    name: "Coach Colony 2",
    instructions: path.join(holders, "coach-colony-2"),
    writable: ["artifacts/pattern-holders/coach-colony-2"],
    owner: { colony: "colony-fixeur.json" },
    tools: "publish",
  },
  {
    id: "coach-telegram",
    name: "Coach Telegram",
    instructions: path.join(holders, "coach-telegram"),
    writable: ["artifacts/pattern-holders/coach-telegram"],
    tools: "none",
    private: true,
  },
];

function assignRoom2(extra: Record<string, unknown> = {}) {
  const a = saveForkAssignment(forkDir(dir, 2), {
    instructions: path.join(workspace, "room-fixeurs", "ROOM2.md"),
    engine: "claude",
    workspace,
    inbox: "explicit",
    agents: AGENTS(),
    ...extra,
  });
  setForkEnabled(dir, 2, true);
  return a;
}

/** Messages renvoyés à NLR sur Telegram pendant les tours (jamais de vrai envoi en test). */
let telegramSent: { text: string; key: string }[] = [];
/** Un tour de la room ; `reply` choisit la réponse de chaque agent. */
async function turn(reply: (agent: string, input: TurnInput) => string | { outcome: "error" } = () => "SILENCE") {
  const calls: TurnInput[] = [];
  await runForks({
    dataDir: dir,
    workspace,
    profile: () => "run",
    claudeProfile: () => "run",
    maxTurns: 1,
    telegramReply: async (text, key) => {
      telegramSent.push({ text, key });
    },
    claudeTurn: async (input) => {
      calls.push(input);
      const agent = /agent:([a-z0-9-]+):/.exec(input.agent?.key ?? "")?.[1] ?? "room";
      const r = reply(agent, input);
      if (typeof r !== "string")
        return { outcome: "error", text: "", tokens: null, accepted: false, detail: "panne simulée", retryAtMs: null, sessionId: "s" };
      return { outcome: "completed", text: r, tokens: 1, accepted: true, detail: null, retryAtMs: null, sessionId: `s-${agent}` };
    },
  });
  return calls;
}
const woken = (calls: TurnInput[]) => calls.map((c) => /agent:([a-z0-9-]+):/.exec(c.agent?.key ?? "")?.[1] ?? "room");
/** Messages et relais encore en attente dans la room (un tour sans attente ne s'arrêterait pas). */
const pending = () => {
  const store = new SecondThreadStore(forkDir(dir, 2));
  try {
    const relays = readRoomRelays(store).filter((r) => r.to.length > 0).length;
    return entries().filter((e) => e.role === "human" && !e.delivered).length + relays;
  } finally {
    store.close();
  }
};
function entries() {
  const store = new SecondThreadStore(forkDir(dir, 2));
  try {
    return store.entries();
  } finally {
    store.close();
  }
}

describe("affectation d'une room à plusieurs agents", () => {
  it("room sans `agents` : affectation, prompt et tour unique inchangés", async () => {
    const a = saveForkAssignment(forkDir(dir, 2), {
      instructions: path.join(workspace, "room-fixeurs", "ROOM2.md"),
      engine: "claude",
      workspace,
      owner: { signature: "Fixeur (Room 2)", colony: "colony-fixeur.json", profile: "publish" },
    });
    expect(a).not.toHaveProperty("agents");
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(forkDir(dir, 2), "assignment.json"), "utf8")) as object)).not.toContain("agents");
    expect(readForkAssignment(forkDir(dir, 2))).toEqual(a);
    expect(assignedForkPrompt(2, a)).toContain("signé « Fixeur (Room 2) »");
    setForkEnabled(dir, 2, true);
    sendToFork(dir, 2, "Coach Colony, tu es là ?");
    const calls = await turn(() => "Fixeur (Room 2) : oui");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.agent).toBeUndefined();
    expect(calls[0]!.message).toMatch(/^NLR \[[^\]]+\] : Coach Colony, tu es là \?$/);
    expect(entries().filter((e) => e.role === "agent").map((e) => e.text)).toEqual(["Fixeur (Room 2) : oui"]);
  });

  it("valide la liste : moteur claude, ids et noms uniques, compte Colony propre, outils connus", () => {
    const base = { instructions: path.join(workspace, "room-fixeurs", "ROOM2.md"), workspace };
    const a = validateAssignment({ ...base, agents: AGENTS() });
    expect(a.agents?.map((x) => [x.id, x.tools, x.owner.colony, x.private])).toEqual([
      ["coach-colony", "publish", "colony-fixeur.json", false],
      ["coach-colony-2", "publish", "colony-fixeur.json", false],
      ["coach-telegram", "none", null, true],
    ]);
    const bad = (agents: unknown, extra: Record<string, unknown> = {}) => () => validateAssignment({ ...base, ...extra, agents });
    expect(bad(AGENTS(), { engine: "codex" })).toThrow("moteur claude");
    expect(bad([])).toThrow("liste de 1");
    expect(bad([AGENTS()[0], { ...AGENTS()[1], id: "coach-colony" }])).toThrow("en double");
    expect(bad([AGENTS()[0], { ...AGENTS()[1], name: "coach colony" }])).toThrow("en double");
    expect(bad([{ ...AGENTS()[0], owner: { colony: "colony.json" } }])).toThrow("colony.json");
    expect(bad([{ ...AGENTS()[0], tools: "write" }])).toThrow("tools attendu");
    expect(bad([{ ...AGENTS()[0], name: "VOX (Room 7)" }])).toThrow("réservé");
    expect(bad([{ ...AGENTS()[0], writable: ["../ailleurs"] }])).toThrow("relatifs");
    expect(bad([{ ...AGENTS()[0], role: "x" }])).toThrow("inconnu");
  });
});

describe("routage dans la room", () => {
  const agents = () => validateAssignment({ instructions: path.join(workspace, "room-fixeurs", "ROOM2.md"), workspace, agents: AGENTS() }).agents as RoomAgent[];

  it("reconnaît @id et nom, le plus long d'abord, sans confondre Coach Colony et Coach Colony 2", () => {
    const a = agents();
    expect(namedAgents("Coach Colony 2, ton avis ?", a)).toEqual(["coach-colony-2"]);
    expect(namedAgents("@coach-colony-2 et coach colony", a)).toEqual(["coach-colony", "coach-colony-2"]);
    expect(namedAgents("@coach-colony.", a)).toEqual(["coach-colony"]);
    expect(namedAgents("Coach Colonyx, @coach-colony-3, a@coach-telegram", a)).toEqual([]);
  });

  it("un message d'un agent de la room ne réveille que ceux qu'il nomme (garde de boucle)", () => {
    const a = agents();
    const from = (text: string) => routeRoomMessage({ text, notice: { label: "Coach Colony", hidden: true } }, a, null);
    expect(from("Rien de plus.").recipients).toEqual([]);
    expect(from("Coach Colony 2, à toi ; Coach Colony se tait.").recipients).toEqual(["coach-colony-2"]);
    expect(routeRoomMessage({ text: "Bonjour" }, a, null)).toMatchObject({ broadcast: true, recipients: ["coach-colony", "coach-colony-2", "coach-telegram"] });
    // Notice ciblée (réveil par @handle) : à cet agent seul, même si le texte en nomme d'autres.
    expect(routeRoomMessage({ text: "@coach-colony — Coach Telegram", notice: { label: "@handle → Coach Colony", hidden: false } }, a, null).recipients).toEqual(["coach-colony"]);
  });
});

describe("tours d'une room à plusieurs agents", () => {
  it("un message de NLR qui nomme un agent va quand même à tous ; l'agent nommé le sait ; sa réponse est signée", async () => {
    assignRoom2();
    sendToFork(dir, 2, "Coach Telegram, tu en penses quoi ?");
    const calls = await turn((agent) => (agent === "coach-telegram" ? "Rien de nominatif ici." : "SILENCE"));
    // NLR, 16 nov. 2026 11:49 : « mes messages vont a tout le monde ».
    expect(woken(calls)).toEqual(["coach-colony", "coach-colony-2", "coach-telegram"]);
    const tg = calls.find((c) => c.agent!.key.includes(":agent:coach-telegram:"))!;
    expect(tg.message).toContain("message à tous les agents de la room. Il te nomme.");
    expect(tg.message).toContain("NLR [");
    for (const c of calls.filter((x) => x !== tg)) expect(c.message).not.toContain("Il te nomme.");
    const all = entries();
    expect(all.filter((e) => e.role === "agent").map((e) => e.text)).toEqual(["Coach Telegram : Rien de nominatif ici."]);
    expect(all.filter((e) => e.role === "human").every((e) => e.delivered)).toBe(true);
  });

  it("un message à tous réveille chaque agent ; chacun répond à part ou se tait (SILENCE)", async () => {
    assignRoom2();
    sendToFork(dir, 2, "Bonjour à tous, qui a du nouveau ?");
    const calls = await turn((agent) => ({ "coach-colony": "Spark a répondu.", "coach-colony-2": "Coach Colony 2 : rien de neuf, mais j'écoute.", "coach-telegram": "SILENCE" })[agent] ?? "");
    expect(woken(calls)).toEqual(["coach-colony", "coach-colony-2", "coach-telegram"]);
    for (const c of calls) expect(c.message).toContain("message à tous les agents de la room");
    expect(entries().filter((e) => e.role === "agent").map((e) => e.text)).toEqual([
      "Coach Colony : Spark a répondu.",
      "Coach Colony 2 : rien de neuf, mais j'écoute.",
    ]);
    // Une session par agent : clés et sessions distinctes, état préfixé dans le store de la room.
    expect(new Set(calls.map((c) => c.agent?.key)).size).toBe(3);
    const store = new SecondThreadStore(forkDir(dir, 2));
    expect(store.get("agent:coach-colony:handled")).toBe("1");
    expect(store.get("agent:coach-telegram:handled")).toBe("1");
    store.close();
  });

  it("chaque agent a son prompt, ses dossiers, sa signature et ses outils ; le coach Telegram n'a ni Colony ni Reddit", async () => {
    assignRoom2();
    sendToFork(dir, 2, "Tour de table.");
    const calls = await turn();
    const byAgent = Object.fromEntries(calls.map((c) => [/agent:([a-z0-9-]+):/.exec(c.agent!.key)![1], c.agent!]));
    const colony = byAgent["coach-colony"]!.prompt;
    const tg = byAgent["coach-telegram"]!.prompt;
    // Sections : _holder.md d'abord, sources/ exclues ; sous-dossiers de personnes inclus.
    expect(colony.indexOf("Je suis le coach Colony.")).toBeLessThan(colony.indexOf("Fiches de Spark."));
    expect(colony).not.toContain("PREUVE-BRUTE");
    expect(tg).toContain("Scène recréée avec Marie.");
    // Cloisonnement : chacun ne connaît que son dossier, jamais celui d'un autre.
    expect(tg).not.toContain("Je suis le coach Colony.");
    expect(colony).not.toContain("Scène recréée avec Marie.");
    expect(tg).toContain(`Tu lis et écris seulement dans ${path.join(holders, "coach-telegram")}.`);
    expect(colony).toContain(`Tu lis et écris seulement dans ${path.join(holders, "coach-colony")}.`);
    expect(colony).not.toContain(`seulement dans ${path.join(holders, "coach-telegram")}`);
    // Garde de base de chaque coach ; note privée pour le coach Telegram seul.
    for (const p of [colony, tg, byAgent["coach-colony-2"]!.prompt]) expect(p).toContain(COACH_GUARD);
    expect(tg).toContain(PRIVATE_ROOM_COACH_NOTE);
    expect(colony).not.toContain(PRIVATE_ROOM_COACH_NOTE);
    expect(tg).toContain("Le profil Colony/Reddit");
    expect(colony).toContain("seulement sur Colony, par colony_call_tool");
    // Signature et outils MCP propres à chaque agent.
    const env = (c: string) => (JSON.parse(c) as { mcpServers: { mind: { env: Record<string, string> } } }).mcpServers.mind.env;
    expect(env(byAgent["coach-telegram"]!.mcpConfig!)).toMatchObject({
      MIND_WAKE_OWNER_SIGNATURE: "Coach Telegram",
      MIND_WAKE_OWNER_TOOLS: "none",
      MIND_WAKE_OWNER_COLONY: "",
      MIND_WAKE_OWNER_FORK: "2",
    });
    expect(env(byAgent["coach-colony"]!.mcpConfig!)).toMatchObject({
      MIND_WAKE_OWNER_SIGNATURE: "Coach Colony",
      MIND_WAKE_OWNER_TOOLS: "publish",
      MIND_WAKE_OWNER_COLONY: "colony-fixeur.json",
    });
    // Prompt écrit à part pour chaque agent.
    expect(new Set(calls.map((c) => c.agent!.promptDir)).size).toBe(3);
    // Le prompt de la room (ROOM2.md) n'entre dans aucun agent.
    for (const c of calls) expect(c.agent!.prompt).not.toContain("Room 2 commune.");
  });

  it("le registre `prive` suffit à marquer un coach privé", () => {
    const a = validateAssignment({
      instructions: path.join(workspace, "room-fixeurs", "ROOM2.md"),
      workspace,
      agents: AGENTS().map((x) => ({ ...x, private: false })),
    });
    const tg = a.agents!.find((x) => x.id === "coach-telegram")!;
    expect(roomAgentPrompt(2, a, tg)).toContain(PRIVATE_ROOM_COACH_NOTE);
    expect(roomAgentMcpConfig(2, dir, tg, "node", "R:/repo")).toContain('"MIND_WAKE_OWNER_TOOLS":"none"');
  });

  it("garde de boucle : une réponse ne réveille un autre agent que si elle le nomme, et la chaîne est bornée", async () => {
    assignRoom2();
    sendToFork(dir, 2, "Coach Colony, un mot ?");
    await turn((agent) => (agent === "coach-colony" ? "Rien à ajouter." : "SILENCE"));
    // Réponse sans nom : rien ne reste à remettre, aucun autre agent ne sera réveillé.
    expect(pending()).toBe(0);
    sendToFork(dir, 2, "Coach Colony, et Spark ?");
    await turn((agent) => (agent === "coach-colony" ? "Je laisse Coach Colony 2 compléter." : "SILENCE"));
    const relayed = await turn(() => "Merci Coach Colony.");
    expect(woken(relayed)).toEqual(["coach-colony-2"]);
    expect(relayed[0]!.message).toMatch(/Coach Colony \(agent de la room\) \[[^\]]+\] : Je laisse Coach Colony 2 compléter\./);
    // Le relais est caché : la réponse n'est affichée qu'une fois, signée.
    expect(entries().filter((e) => e.role === "agent").map((e) => e.text)).toEqual([
      "Coach Colony : Rien à ajouter.",
      "Coach Colony : Je laisse Coach Colony 2 compléter.",
      "Coach Colony 2 : Merci Coach Colony.",
    ]);
    // Deux agents qui se nomment sans fin : la chaîne s'arrête après MAX_RELAY_DEPTH relais.
    let rounds = 0;
    while (pending() > 0) {
      await turn((agent) => (agent === "coach-colony" ? "Coach Colony 2 ?" : "Coach Colony ?"));
      rounds++;
    }
    expect(rounds).toBe(MAX_RELAY_DEPTH - 1);
    expect(entries().some((e) => e.role === "event" && e.text.includes("non transmis"))).toBe(true);
    // Aucun relais n'est devenu une entrée `human` : seuls les deux messages de NLR le sont.
    expect(entries().filter((e) => e.role === "human").map((e) => e.text)).toEqual([
      "Coach Colony, un mot ?",
      "Coach Colony, et Spark ?",
    ]);
  });

  it("un agent en échec reprend seul ses messages ; le message n'est livré qu'une fois traité par tous", async () => {
    assignRoom2();
    sendToFork(dir, 2, "Bonjour à tous.");
    const first = await turn((agent) => (agent === "coach-telegram" ? { outcome: "error" } : "SILENCE"));
    expect(woken(first)).toEqual(["coach-colony", "coach-colony-2", "coach-telegram"]);
    expect(entries().find((e) => e.role === "human")?.delivered).toBe(false);
    const second = await turn();
    expect(woken(second)).toEqual(["coach-telegram"]);
    expect(entries().find((e) => e.role === "human")?.delivered).toBe(true);
    // Le worker marque une pause de 5 s après un tour en erreur (comportement existant).
  }, 20_000);

  it("un @handle du registre dans un message de NLR : à tous, avec le texte de réveil pour le coach de la personne seul", async () => {
    assignRoom2();
    sendToFork(dir, 2, "Vous avez vu ce qu'a écrit @spark-the-cat ?");
    const calls = await turn();
    expect(woken(calls)).toEqual(["coach-colony", "coach-colony-2", "coach-telegram"]);
    const wake = "@spark-the-cat est mentionné ici. Tu es son coach dans le mesh.";
    expect(calls[0]!.message).toContain(wake);
    for (const c of calls.slice(1)) expect(c.message).not.toContain(wake);
  });

  it("une notice ciblée « @handle → Nom » ne réveille que cet agent", async () => {
    assignRoom2();
    sendNoticeToFork(dir, 2, "@coach-telegram — @marie_t est mentionné ici. (Coach Colony le verra ?)", "handle-wake:test0001:coach-telegram", "@handle → Coach Telegram");
    const calls = await turn();
    expect(woken(calls)).toEqual(["coach-telegram"]);
    expect(calls[0]!.message).toContain("@handle → Coach Telegram [");
  });
});

describe("agents détectés automatiquement (agentsFrom)", () => {
  const FROM = { dir: "artifacts/pattern-holders", prefix: "coach-", exclude: ["coach-des-coachs"], colony: "colony-fixeur.json" };
  function moreCoaches() {
    // Coach des coachs : exclu. Dossier sans .md : ignoré. Coach Colony 2 (README.md seul) et
    // coach-colony-7 (MANDAT.md seul) : pas de _holder.md, pas prêts. Coach Colony 8 : _holder.md sans titre.
    fs.mkdirSync(path.join(holders, "coach-des-coachs"), { recursive: true });
    fs.writeFileSync(path.join(holders, "coach-des-coachs", "_holder.md"), "# Coach des coachs\nJe centralise.");
    fs.mkdirSync(path.join(holders, "coach-vide", "sous-dossier"), { recursive: true });
    fs.writeFileSync(path.join(holders, "coach-vide", "notes.txt"), "pas de markdown");
    fs.mkdirSync(path.join(holders, "coach-colony-7"), { recursive: true });
    fs.writeFileSync(path.join(holders, "coach-colony-7", "MANDAT.md"), "# Coach Colony 7\nPas encore prêt.");
    fs.mkdirSync(path.join(holders, "coach-colony-8"), { recursive: true });
    fs.writeFileSync(path.join(holders, "coach-colony-8", "_holder.md"), "Dix fiches.");
    // Type inconnu (ni coach-telegram* ni coach-colony*) : aucun outil.
    fs.mkdirSync(path.join(holders, "coach-reddit"), { recursive: true });
    fs.writeFileSync(path.join(holders, "coach-reddit", "_holder.md"), "# Coach Reddit");
    fs.mkdirSync(path.join(holders, "coach-telegram-2"), { recursive: true });
    fs.writeFileSync(path.join(holders, "coach-telegram-2", "_holder.md"), "# Coach Telegram 2 — qui je suis\nPrivé.");
    fs.mkdirSync(path.join(holders, "autre-holder"), { recursive: true });
    fs.writeFileSync(path.join(holders, "autre-holder", "_holder.md"), "# Autre");
  }
  function assignAuto(extra: Record<string, unknown> = {}) {
    const a = saveForkAssignment(forkDir(dir, 2), {
      instructions: path.join(workspace, "room-fixeurs", "ROOM2.md"),
      engine: "claude",
      workspace,
      inbox: "explicit",
      agentsFrom: { dir: FROM.dir, prefix: FROM.prefix, exclude: FROM.exclude },
      ...extra,
    });
    setForkEnabled(dir, 2, true);
    return a;
  }

  it("détecte chaque dossier coach-* qui a un _holder.md : nom tiré de son titre ou de l'id ; sans _holder.md, exclus et hors préfixe ignorés", () => {
    moreCoaches();
    // Un README.md titré ne suffit pas : seul _holder.md marque un coach prêt.
    fs.writeFileSync(path.join(holders, "coach-colony-2", "README.md"), "# Coach Colony 2 — v0\nCinq agents.");
    const found = detectRoomAgents(workspace, FROM);
    expect(found.map((a) => [a.id, a.name])).toEqual([
      ["coach-colony", "Coach Colony"],
      ["coach-colony-8", "Coach Colony 8"],
      ["coach-reddit", "Coach Reddit"],
      ["coach-telegram", "Coach Telegram"],
      ["coach-telegram-2", "Coach Telegram 2"],
    ]);
    const colony8 = found.find((a) => a.id === "coach-colony-8")!;
    expect(colony8.instructions).toBe(path.join(holders, "coach-colony-8"));
    expect(colony8.writable).toEqual(["artifacts/pattern-holders/coach-colony-8"]);
    // Ni coach-colony-2 / coach-colony-7 (pas de _holder.md), ni le coach des coachs (exclu, pas
    // de hub), ni coach-vide, ni un dossier hors préfixe.
    const ids = found.map((a) => a.id);
    for (const id of ["coach-colony-2", "coach-colony-7", "coach-des-coachs", "coach-vide", "autre-holder"])
      expect(ids).not.toContain(id);
    // Un _holder.md qui est un dossier n'est pas un marqueur.
    fs.mkdirSync(path.join(holders, "coach-colony-6", "_holder.md"), { recursive: true });
    expect(detectRoomAgents(workspace, FROM).map((a) => a.id)).not.toContain("coach-colony-6");
  });

  it("déduit les outils du nom : coach-telegram* sans outils et privé, coach-colony* en publication avec le compte configuré, type inconnu sans outils", () => {
    moreCoaches();
    const byId = Object.fromEntries(detectRoomAgents(workspace, { ...FROM, colony: "colony-autre.json" }).map((a) => [a.id, a]));
    for (const id of ["coach-telegram", "coach-telegram-2"])
      expect(byId[id]).toMatchObject({ tools: "none", private: true, owner: { colony: null, profile: "publish" } });
    for (const id of ["coach-colony", "coach-colony-8"])
      expect(byId[id]).toMatchObject({ tools: "publish", private: false, owner: { colony: "colony-autre.json", profile: "publish" } });
    expect(byId["coach-reddit"]).toMatchObject({ tools: "none", private: false, owner: { colony: null } });
    // Compte par défaut : colony-fixeur.json ; jamais colony.json.
    const a = assignAuto();
    expect(a.agentsFrom).toEqual({ ...FROM });
    const base = { instructions: path.join(workspace, "room-fixeurs", "ROOM2.md"), workspace };
    expect(() => validateAssignment({ ...base, agentsFrom: { dir: FROM.dir, colony: "colony.json" } })).toThrow("colony.json");
    expect(() => validateAssignment({ ...base, engine: "codex", agentsFrom: { dir: FROM.dir } })).toThrow("moteur claude");
    expect(() => validateAssignment({ ...base, agentsFrom: { dir: "../ailleurs" } })).toThrow("agentsFrom.dir");
    expect(() => validateAssignment({ ...base, agentsFrom: { dir: FROM.dir, role: "x" } })).toThrow("inconnu");
    expect(() => validateAssignment({ ...base, agentsFrom: { dir: FROM.dir }, agentsConcurrency: 0 })).toThrow("agentsConcurrency");
  });

  it("branchement auto : coach-telegram* reçoit son contacts.json et l'envoi Telegram ; coach-colony* détecté prend colony-<id>.json s'il existe", () => {
    moreCoaches();
    // Compte propre de coach-colony-8 (faux fichier, jamais lu ici) ; aucun pour coach-colony.
    fs.writeFileSync(path.join(dir, "colony-coach-colony-8.json"), "{}");
    const byId = Object.fromEntries(detectRoomAgents(workspace, FROM, dir).map((a) => [a.id, a]));
    expect(byId["coach-colony-8"]!.owner.colony).toBe("colony-coach-colony-8.json");
    expect(byId["coach-colony"]!.owner.colony).toBe("colony-fixeur.json");
    // Sans dossier de données : compte de agentsFrom, comportement historique.
    expect(detectRoomAgents(workspace, FROM).find((a) => a.id === "coach-colony-8")!.owner.colony).toBe("colony-fixeur.json");
    for (const id of ["coach-telegram", "coach-telegram-2"]) {
      expect(byId[id]!.telegramContacts).toBe(path.join(holders, id, "contacts.json"));
      expect(byId[id]!.readable).toEqual(DEFAULT_TELEGRAM_READABLE.map((d) => path.resolve(d)));
    }
    expect(byId["coach-colony"]!.readable).toBeUndefined();
    // Export lisible réglable par agentsFrom.telegramReadable ; seul un dossier existant est ouvert.
    const exportDir = path.join(dir, "export-telegram");
    fs.mkdirSync(exportDir);
    const custom = detectRoomAgents(workspace, { ...FROM, telegramReadable: [exportDir, path.join(dir, "absent")] }, dir);
    const tg2 = custom.find((x) => x.id === "coach-telegram-2")!;
    expect(roomAgentReadable(tg2)).toEqual([exportDir]);
    expect(byId["coach-colony"]!.telegramContacts).toBeUndefined();
    expect(byId["coach-reddit"]!.telegramContacts).toBeUndefined();
    const env = (agentId: string) =>
      (JSON.parse(roomAgentMcpConfig(2, dir, byId[agentId]!, "node", "R:/repo")!) as { mcpServers: { mind: { env: Record<string, string> } } })
        .mcpServers.mind.env;
    expect(env("coach-telegram-2")).toMatchObject({
      MIND_WAKE_OWNER_TOOLS: "none",
      MIND_WAKE_OWNER_TELEGRAM_COACH: "coach-telegram-2",
      MIND_WAKE_OWNER_TELEGRAM_CONTACTS: path.join(holders, "coach-telegram-2", "contacts.json"),
    });
    expect(env("coach-colony-8")).toMatchObject({ MIND_WAKE_OWNER_COLONY: "colony-coach-colony-8.json", MIND_WAKE_OWNER_TOOLS: "publish" });
    expect(env("coach-colony-8")).not.toHaveProperty("MIND_WAKE_OWNER_TELEGRAM_COACH");
    const a = validateAssignment({ instructions: path.join(workspace, "room-fixeurs", "ROOM2.md"), workspace, agentsFrom: FROM });
    expect(roomAgentPrompt(2, a, byId["coach-telegram-2"]!)).toContain("telegram_user_send");
    expect(roomAgentPrompt(2, a, tg2)).toContain(`Tu peux aussi lire, sans y écrire : ${exportDir}.`);
    expect(roomAgentPrompt(2, a, tg2)).toContain("WebFetch");
    expect(() =>
      validateAssignment({ instructions: path.join(workspace, "room-fixeurs", "ROOM2.md"), workspace, agentsFrom: { ...FROM, telegramReadable: ["relatif"] } }),
    ).toThrow("telegramReadable");
    expect(resolveRoomAgents(a, dir).find((x) => x.id === "coach-colony-8")!.owner.colony).toBe("colony-coach-colony-8.json");
  });

  it("un agent explicite garde la priorité sur l'agent détecté de même id", () => {
    moreCoaches();
    const a = validateAssignment({
      instructions: path.join(workspace, "room-fixeurs", "ROOM2.md"),
      workspace,
      agents: [{ ...AGENTS()[0], name: "Coach Colony (explicite)", tools: "read" }],
      agentsFrom: FROM,
    });
    const agents = resolveRoomAgents(a);
    expect(agents.filter((x) => x.id === "coach-colony")).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: "coach-colony", name: "Coach Colony (explicite)", tools: "read" });
    expect(agents.map((x) => x.id)).toEqual(["coach-colony", "coach-colony-8", "coach-reddit", "coach-telegram", "coach-telegram-2"]);
  });

  it("un dossier apparu en cours de route devient un agent au tour suivant, sans relance ni réaffectation", async () => {
    assignAuto();
    sendToFork(dir, 2, "Bonjour à tous.");
    const first = await turn();
    // coach-colony-2 n'a pas de _holder.md : pas encore un agent.
    expect(woken(first).sort()).toEqual(["coach-colony", "coach-telegram"]);
    fs.mkdirSync(path.join(holders, "coach-colony-9"), { recursive: true });
    fs.writeFileSync(path.join(holders, "coach-colony-9", "_holder.md"), "# Coach Colony 9\nNouveau.");
    sendToFork(dir, 2, "Coach Colony 9, présente-toi.");
    const second = await turn((agent) => (agent === "coach-colony-9" ? "Présent." : "SILENCE"));
    expect(woken(second).sort()).toEqual(["coach-colony", "coach-colony-9", "coach-telegram"]);
    const nine = second.find((c) => c.agent!.key.includes(":agent:coach-colony-9:"))!;
    expect(nine.agent!.prompt).toContain("Nouveau.");
    expect(entries().filter((e) => e.role === "agent").map((e) => e.text)).toEqual(["Coach Colony 9 : Présent."]);
    const env = (JSON.parse(nine.agent!.mcpConfig!) as { mcpServers: { mind: { env: Record<string, string> } } }).mcpServers.mind.env;
    expect(env).toMatchObject({ MIND_WAKE_OWNER_TOOLS: "publish", MIND_WAKE_OWNER_COLONY: "colony-fixeur.json" });
  });
});

describe("hub : le coach des coachs centralise (NLR, 16 nov. 2026 11:49)", () => {
  const HUB = "coach-des-coachs";
  function assignHub(withHub = true) {
    // Coach Colony 2 reçoit son _holder.md : quatre coachs prêts, plus le hub.
    fs.writeFileSync(path.join(holders, "coach-colony-2", "_holder.md"), "# Coach Colony 2\nCinq agents.");
    if (withHub) {
      fs.mkdirSync(path.join(holders, HUB), { recursive: true });
      fs.writeFileSync(path.join(holders, HUB, "_holder.md"), "# Coach des coachs\nJe centralise.");
    }
    const a = saveForkAssignment(forkDir(dir, 2), {
      instructions: path.join(workspace, "room-fixeurs", "ROOM2.md"),
      engine: "claude",
      workspace,
      inbox: "explicit",
      agentsFrom: { dir: "artifacts/pattern-holders", prefix: "coach-", exclude: [HUB], hub: HUB },
    });
    setForkEnabled(dir, 2, true);
    return a;
  }
  const relays = () => {
    const store = new SecondThreadStore(forkDir(dir, 2));
    try {
      return readRoomRelays(store).map((r) => ({ from: r.from, to: [...r.to].sort(), text: r.text }));
    } finally {
      store.close();
    }
  };
  const callOf = (calls: TurnInput[], id: string) => calls.find((c) => c.agent!.key.includes(`:agent:${id}:`));

  it("le hub est détecté même exclu, sans aucun outil ; chacun connaît la règle dans son prompt", async () => {
    const a = assignHub();
    expect(a.agentsFrom).toMatchObject({ hub: HUB, exclude: [HUB] });
    const hub = resolveRoomAgents(a).find((x) => x.id === HUB)!;
    expect(hub).toMatchObject({ name: "Coach des coachs", tools: "none", private: false, owner: { colony: null } });
    sendToFork(dir, 2, "Tour de table.");
    const calls = await turn();
    expect(callOf(calls, HUB)!.agent!.prompt).toContain("Tu es le coach des coachs, au centre de la room");
    expect(callOf(calls, "coach-colony")!.agent!.prompt).toContain("remise au coach des coachs (Coach des coachs @coach-des-coachs) seulement");
    expect(callOf(calls, "coach-telegram")!.agent!.prompt).toContain("il ne reçoit qu'une notice « tu as répondu », jamais ton texte");
    const env = (JSON.parse(callOf(calls, HUB)!.agent!.mcpConfig!) as { mcpServers: { mind: { env: Record<string, string> } } }).mcpServers.mind.env;
    expect(env).toMatchObject({ MIND_WAKE_OWNER_TOOLS: "none", MIND_WAKE_OWNER_COLONY: "" });
    const base = { instructions: path.join(workspace, "room-fixeurs", "ROOM2.md"), workspace };
    expect(() => validateAssignment({ ...base, agentsFrom: { dir: "artifacts/pattern-holders", hub: "../x" } })).toThrow("agentsFrom.hub");
  });

  it("un message de NLR va à tous, hub compris, même s'il nomme un coach", async () => {
    assignHub();
    sendToFork(dir, 2, "Coach Telegram, tu en penses quoi ?");
    const calls = await turn();
    expect(woken(calls).sort()).toEqual(["coach-colony", "coach-colony-2", HUB, "coach-telegram"]);
    for (const c of calls) expect(c.message).toContain("NLR [");
    expect(entries().find((e) => e.role === "human")?.delivered).toBe(true);
  });

  it("room désactivée : un message de NLR non adressé réveille le hub seul, une notice ciblée son agent seul", async () => {
    assignHub();
    setForkEnabled(dir, 2, false);
    // Une autre room active garde le worker vivant le temps d'un tour (maxTurns).
    const room4 = path.join(workspace, "room4.md");
    fs.writeFileSync(room4, "Consigne.");
    saveForkAssignment(forkDir(dir, 4), { instructions: room4, engine: "claude", workspace });
    setForkEnabled(dir, 4, true);
    const s = new SecondThreadStore(forkDir(dir, 2));
    s.set("oneshot-since", "1970-01-01T00:00:00.000Z");
    s.close();
    sendToFork(dir, 2, "Tour de table ?");
    sendToFork(dir, 4, "tour 4 a");
    expect(woken((await turn()).filter((c) => c.agent !== undefined))).toEqual([HUB]);
    telegramSent = [];
    sendNoticeToFork(dir, 2, "@coach-telegram tu es là ?", "telegram-route:abcdefgh01", "NLR (Telegram) → Coach Telegram", true);
    sendToFork(dir, 4, "tour 4 b");
    expect(woken((await turn((agent) => (agent === "coach-telegram" ? "Oui, je suis là." : "SILENCE"))).filter((c) => c.agent !== undefined))).toEqual(["coach-telegram"]);
    // Seule la réponse de l'agent adressé part vers le téléphone de NLR, signée de son nom.
    expect(telegramSent.map((t) => t.text)).toEqual(["Coach Telegram : Oui, je suis là."]);
    // Message d'agent : aucun réveil.
    sendNoticeToFork(dir, 2, "Note du principal", "post:principal:abcdefgh", "Principal");
    sendToFork(dir, 4, "tour 4 c");
    expect((await turn()).filter((c) => c.agent !== undefined)).toEqual([]);
    expect(forkEnabled(dir, 2)).toBe(false);
  });

  it("une réponse de coach va au hub seulement, même si elle nomme un autre coach : rien entre coachs", async () => {
    assignHub();
    sendToFork(dir, 2, "Bonjour à tous.");
    await turn((agent) => (agent === "coach-colony" ? "Coach Colony 2, prends la suite ; @coach-telegram aussi." : "SILENCE"));
    expect(relays()).toEqual([{ from: "coach-colony", to: [HUB], text: "Coach Colony 2, prends la suite ; @coach-telegram aussi." }]);
    const next = await turn(() => "SILENCE");
    expect(woken(next)).toEqual([HUB]);
    expect(next[0]!.message).toContain("réponses des coachs, remises au coach des coachs");
    expect(next[0]!.message).toMatch(/Coach Colony \(agent de la room\) \[[^\]]+\] : Coach Colony 2, prends la suite/);
    expect(relays()).toEqual([]);
    expect(pending()).toBe(0);
  });

  it("une réponse du hub va à tous les coachs", async () => {
    assignHub();
    sendToFork(dir, 2, "Bonjour à tous.");
    await turn((agent) => (agent === HUB ? "À tous : on publie demain." : "SILENCE"));
    expect(relays()).toEqual([{ from: HUB, to: ["coach-colony", "coach-colony-2", "coach-telegram"], text: "À tous : on publie demain." }]);
    const next = await turn(() => "Reçu.");
    expect(woken(next).sort()).toEqual(["coach-colony", "coach-colony-2", "coach-telegram"]);
    // Trois réponses de coachs, toutes vers le hub seul ; celle du coach privé réduite à la notice.
    expect(relays().map((r) => [r.from, r.to])).toEqual([
      ["coach-colony", [HUB]],
      ["coach-colony-2", [HUB]],
      ["coach-telegram", [HUB]],
    ].sort());
    for (const c of next) {
      expect(c.message).toContain("réponse du coach des coachs, remise à tous les coachs");
      expect(c.message).toContain("Coach des coachs (agent de la room) [");
    }
    // Les réponses des coachs repartent vers le hub seul ; la chaîne reste bornée.
    let rounds = 0;
    while (pending() > 0 && rounds < 10) {
      await turn((agent) => (agent === HUB ? "Encore un point." : "Reçu."));
      rounds++;
    }
    expect(pending()).toBe(0);
    expect(entries().some((e) => e.role === "event" && e.text.includes("non transmis"))).toBe(true);
    expect(entries().filter((e) => e.role === "human")).toHaveLength(1);
  });

  it("un coach privé n'envoie au hub qu'une notice, sans ses mots ni les noms de ses contacts", async () => {
    assignHub();
    sendToFork(dir, 2, "Bonjour à tous.");
    await turn((agent) => (agent === "coach-telegram" ? "Marie (@marie_t) a dit oui pour jeudi." : "SILENCE"));
    expect(relays()).toEqual([{ from: "coach-telegram", to: [HUB], text: "Coach Telegram a répondu (coach privé : contenu non transmis)" }]);
    const next = await turn(() => "SILENCE");
    expect(woken(next)).toEqual([HUB]);
    expect(next[0]!.message).toContain("Coach Telegram a répondu (coach privé : contenu non transmis)");
    for (const leak of ["Marie", "marie_t", "jeudi"]) expect(next[0]!.message).not.toContain(leak);
    // NLR voit la réponse, une fois, signée.
    expect(entries().filter((e) => e.role === "agent").map((e) => e.text)).toEqual(["Coach Telegram : Marie (@marie_t) a dit oui pour jeudi."]);
  });

  it("hub absent : les coachs répondent, rien n'attend ; hub en échec : les coachs continuent", async () => {
    assignHub(false);
    sendToFork(dir, 2, "Bonjour à tous.");
    const calls = await turn((agent) => (agent === "coach-colony" ? "Coach Colony 2, à toi." : "SILENCE"));
    expect(woken(calls).sort()).toEqual(["coach-colony", "coach-colony-2", "coach-telegram"]);
    expect(relays()).toEqual([]);
    expect(pending()).toBe(0);
    // Le hub apparaît puis tombe en panne : ses messages l'attendent, les coachs ne sont pas bloqués.
    fs.mkdirSync(path.join(holders, HUB), { recursive: true });
    fs.writeFileSync(path.join(holders, HUB, "_holder.md"), "# Coach des coachs");
    sendToFork(dir, 2, "Deuxième message.");
    const failing = await turn((agent) => (agent === HUB ? { outcome: "error" } : agent === "coach-colony" ? "Fait." : "SILENCE"));
    expect(woken(failing).sort()).toEqual(["coach-colony", "coach-colony-2", HUB, "coach-telegram"]);
    expect(entries().filter((e) => e.role === "agent").map((e) => e.text)).toEqual(["Coach Colony : Coach Colony 2, à toi.", "Coach Colony : Fait."]);
    expect(relays()).toEqual([{ from: "coach-colony", to: [HUB], text: "Fait." }]);
    sendToFork(dir, 2, "Troisième message.");
    const third = await turn((agent) => (agent === HUB ? { outcome: "error" } : agent === "coach-telegram" ? "Toujours là." : "SILENCE"));
    // Les coachs traitent le nouveau message ; seul le hub reprend ses messages en retard.
    expect(woken(third).sort()).toEqual(["coach-colony", "coach-colony-2", HUB, "coach-telegram"]);
    expect(entries().filter((e) => e.role === "agent").map((e) => e.text).at(-1)).toBe("Coach Telegram : Toujours là.");
    // Le hub retiré : son relais en attente est abandonné, plus rien ne reste en attente.
    fs.rmSync(path.join(holders, HUB), { recursive: true, force: true });
    const after = await turn(() => "SILENCE");
    expect(woken(after)).toEqual([]);
    expect(relays()).toEqual([]);
    expect(pending()).toBe(0);
  }, 30_000);
});

describe("écho : une réponse d'agent ne devient jamais une entrée human (Room 2, 16 nov. 2026)", () => {
  it("réponse qui nomme d'autres agents : affichée une fois, relayée hors du fil, étiquetée de son auteur", async () => {
    assignRoom2();
    sendToFork(dir, 2, "prepare dans un fichier un blog post de notre activité");
    // Motif réel (entrée 1628) : Coach Telegram nomme les autres en fin de réponse.
    await turn((agent) =>
      agent === "coach-telegram" ? "J'ai écrit ma partie.\n\n@coach-colony @coach-colony-2 : prenez la mienne." : "SILENCE",
    );
    const human = () => entries().filter((e) => e.role === "human");
    expect(human().map((e) => e.text)).toEqual(["prepare dans un fichier un blog post de notre activité"]);
    expect(entries().filter((e) => e.role === "agent").map((e) => e.text)).toEqual([
      "Coach Telegram : J'ai écrit ma partie.\n\n@coach-colony @coach-colony-2 : prenez la mienne.",
    ]);
    // Le relais attend les agents nommés, hors du fil.
    const store = new SecondThreadStore(forkDir(dir, 2));
    expect(readRoomRelays(store).map((r) => [r.from, r.to])).toEqual([["coach-telegram", ["coach-colony", "coach-colony-2"]]]);
    store.close();
    const relayed = await turn(() => "SILENCE");
    expect(woken(relayed).sort()).toEqual(["coach-colony", "coach-colony-2"]);
    for (const c of relayed) {
      expect(c.message).toContain("Coach Telegram (agent de la room) [");
      expect(c.message).not.toContain("NLR [");
    }
    // Toujours un seul message humain ; plus aucun relais en attente.
    expect(human()).toHaveLength(1);
    const after = new SecondThreadStore(forkDir(dir, 2));
    expect(readRoomRelays(after)).toEqual([]);
    after.close();
  });
});

describe("agents en parallèle", () => {
  async function direct(
    reply: (agent: string) => Promise<{ outcome: "completed" | "rate_limited"; text: string }>,
    concurrency?: number,
  ) {
    const store = new SecondThreadStore(forkDir(dir, 2));
    try {
      const assignment = readForkAssignment(forkDir(dir, 2))!;
      const human = store.pendingHuman();
      const n = store.beginTurn(null);
      return await runRoomAgentsTurn({
        dataDir: dir,
        dir: forkDir(dir, 2),
        id: 2,
        assignment,
        store,
        human,
        n,
        control: () => "run",
        ...(concurrency === undefined ? {} : { concurrency }),
        claudeTurn: async (input) => {
          const agent = /agent:([a-z0-9-]+):/.exec(input.agent?.key ?? "")?.[1] ?? "room";
          const r = await reply(agent);
          const ok = r.outcome === "completed";
          return { ...r, tokens: 1, accepted: ok, detail: ok ? null : "limite", retryAtMs: ok ? null : 123, sessionId: "s" };
        },
      });
    } finally {
      store.close();
    }
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("les agents d'un même tour répondent en même temps ; l'affichage suit l'ordre de fin", async () => {
    assignRoom2();
    sendToFork(dir, 2, "Bonjour à tous.");
    let inFlight = 0;
    let peak = 0;
    const delays: Record<string, number> = { "coach-colony": 150, "coach-colony-2": 10, "coach-telegram": 70 };
    const r = await direct(async (agent) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(delays[agent] ?? 0);
      inFlight--;
      return { outcome: "completed", text: `fini ${agent}` };
    });
    expect(r.outcome).toBe("completed");
    expect(peak).toBe(3);
    expect(entries().filter((e) => e.role === "agent").map((e) => e.text)).toEqual([
      "Coach Colony 2 : fini coach-colony-2",
      "Coach Telegram : fini coach-telegram",
      "Coach Colony : fini coach-colony",
    ]);
    expect(entries().find((e) => e.role === "human")?.delivered).toBe(true);
  });

  it("la concurrence est bornée (agentsConcurrency) ; une limite du fournisseur arrête les agents restants, repris au tour suivant", async () => {
    assignRoom2({ agentsConcurrency: 2 });
    sendToFork(dir, 2, "Bonjour à tous.");
    let inFlight = 0;
    let peak = 0;
    const started: string[] = [];
    const r = await direct(async (agent) => {
      started.push(agent);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(agent === "coach-colony" ? 5 : 80);
      inFlight--;
      return agent === "coach-colony" ? { outcome: "rate_limited", text: "" } : { outcome: "completed", text: "SILENCE" };
    });
    expect(peak).toBe(2);
    expect(r.outcome).toBe("rate_limited");
    expect(r.retryAtMs).toBe(123);
    // coach-telegram n'est pas parti ; coach-colony-2, déjà en cours, a terminé.
    expect(started).toEqual(["coach-colony", "coach-colony-2"]);
    expect(entries().find((e) => e.role === "human")?.delivered).toBe(false);
    const next: string[] = [];
    const r2 = await direct(async (agent) => {
      next.push(agent);
      return { outcome: "completed", text: "SILENCE" };
    });
    expect(r2.outcome).toBe("completed");
    expect(next.sort()).toEqual(["coach-colony", "coach-telegram"]);
    expect(entries().find((e) => e.role === "human")?.delivered).toBe(true);
  });
});

// 16 nov. 2026 : lecture commune à tous les agents d'une room (plus besoin d'ajouter `readable`
// à la main à chaque agent explicite) ; relecture du fil principal de NLR pour chacun.
describe("lecture commune (agentsFrom.readable) et fil principal", () => {
  const FROM = { dir: "artifacts/pattern-holders", prefix: "coach-", exclude: [] as string[] };
  const ROOM = () => path.join(workspace, "room-fixeurs", "ROOM2.md");
  const DEFAULT = DEFAULT_TELEGRAM_READABLE.map((d) => path.resolve(d));

  it("défaut : l'export Telegram pour chaque agent, explicite ou détecté", () => {
    const a = validateAssignment({ instructions: ROOM(), workspace, agents: [{ ...AGENTS()[0], id: "coach-colony-x", name: "Colony X" }], agentsFrom: FROM });
    const agents = resolveRoomAgents(a);
    expect(agents.map((x) => x.id)).toEqual(["coach-colony-x", "coach-colony", "coach-telegram"]);
    for (const x of agents) expect(x.readable).toEqual(DEFAULT);
  });

  it("agentsFrom.readable remplace le défaut, s'ajoute au readable propre, et telegramReadable reste un alias", () => {
    const common = path.join(dir, "commun");
    const own = path.join(dir, "propre");
    const alias = path.join(dir, "alias");
    for (const d of [common, own, alias]) fs.mkdirSync(d);
    const explicit = { ...AGENTS()[0], id: "coach-colony-x", name: "Colony X", readable: [own, common] };
    const a = validateAssignment({ instructions: ROOM(), workspace, agents: [explicit], agentsFrom: { ...FROM, readable: [common] } });
    expect(a.agentsFrom?.readable).toEqual([common]);
    const byId = Object.fromEntries(resolveRoomAgents(a).map((x) => [x.id, x]));
    expect(byId["coach-colony-x"]!.readable).toEqual([own, common]);
    expect(byId["coach-colony"]!.readable).toEqual([common]);
    expect(byId["coach-telegram"]!.readable).toEqual([common]);
    expect(roomAgentPrompt(2, a, byId["coach-colony"]!)).toContain(`Tu peux aussi lire, sans y écrire : ${common}.`);
    // Alias historique seul, puis fusionné avec readable.
    const old = validateAssignment({ instructions: ROOM(), workspace, agentsFrom: { ...FROM, telegramReadable: [alias] } });
    for (const x of resolveRoomAgents(old)) expect(x.readable).toEqual([alias]);
    const both = validateAssignment({ instructions: ROOM(), workspace, agentsFrom: { ...FROM, readable: [common], telegramReadable: [alias] } });
    for (const x of resolveRoomAgents(both)) expect(x.readable).toEqual([common, alias]);
    // `[]` : aucune lecture commune.
    const none = validateAssignment({ instructions: ROOM(), workspace, agentsFrom: { ...FROM, readable: [] } });
    expect(resolveRoomAgents(none).find((x) => x.id === "coach-colony")!.readable).toBeUndefined();
    expect(() => validateAssignment({ instructions: ROOM(), workspace, agentsFrom: { ...FROM, readable: ["relatif"] } })).toThrow("agentsFrom.readable");
  });

  it("chaque agent sait relire le fil principal (list_owner_messages, lecture seule)", () => {
    const a = validateAssignment({ instructions: ROOM(), workspace, agentsFrom: FROM });
    for (const x of resolveRoomAgents(a)) expect(roomAgentPrompt(2, a, x)).toContain("list_owner_messages (lecture seule");
  });
});
