/**
 * Réveil par @id (NLR, 18 nov. 2026) : n'importe qui écrit @id, la cible fait un tour ; une room
 * éteinte reste éteinte. Appels Claude simulés, aucun appel fournisseur.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { callClaude as CallClaude } from "./fast-reply.js";
import { OwnerMessages } from "./owner-messages.js";
import { forkDir, forkEnabled, oneShotTriggers, setForkEnabled } from "../daemon/forks.js";
import { readForkAssignment, resolveRoomAgents, saveForkAssignment } from "../daemon/fork-assignment.js";
import { routeRoomMessage } from "../daemon/room-agents.js";
import { SecondThreadStore } from "../daemon/second-thread.js";
import { MENTION_PAIR_CAP, mentionsId } from "./mention-wake.js";
import { loadPatternHolders, patternHolderSystemPrompt, tickPatternHolders } from "./pattern-holders.js";
import { deliverLocalMessage } from "./local-message.js";
import { readOwnerInboxHistory } from "./owner-inbox.js";
import { seedSimulatedProfile } from "../../test/demo/harness.js";

let dataDir: string;
let space: string;
let clock: number;
const claude = { executable: "unused", model: "sonnet" };
const now = () => clock;
const at = () => new Date(clock).toISOString();
const holderFile = (name: string, emoji: string, extra = "") =>
  `# ${name}\n\n\`\`\`json pattern-holder\n{ "name": "${name}", "emoji": "${emoji}", "wake": "mention"${extra} }\n\`\`\`\n\nSemence.\n`;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-wake-"));
  const holders = path.join(dataDir, "workspace", "artifacts", "pattern-holders");
  fs.mkdirSync(holders, { recursive: true });
  fs.writeFileSync(path.join(holders, "chef-de-projet.md"), holderFile("Chef de projet", "📋", ', "room": 6'));
  fs.writeFileSync(path.join(holders, "viz.md"), holderFile("Viz", "🎨"));
  space = path.join(dataDir, "room");
  fs.mkdirSync(space, { recursive: true });
  fs.writeFileSync(path.join(space, "ROOM.md"), "Tu es la room.");
  const agents = ["explorer-et-trouver:Explorer et trouver", "se-vendre:Se vendre", "assurer-le-poste:Assurer le poste"].map((x) => {
    const [id, name] = x.split(":") as [string, string];
    fs.writeFileSync(path.join(space, `${id}.md`), `Tu es ${name}.`);
    return { id, name, instructions: path.join(space, `${id}.md`), writable: [id] };
  });
  saveForkAssignment(forkDir(dataDir, 6), { instructions: path.join(space, "ROOM.md"), engine: "claude", workspace: space, agents });
  setForkEnabled(dataDir, 6, false);
  const store = new SecondThreadStore(forkDir(dataDir, 6));
  store.set("oneshot-since", "1970-01-01T00:00:00.000Z");
  store.close();
  clock = Date.parse("2026-11-18T18:00:00.000Z");
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function publish(text: string, key: string) {
  const messages = new OwnerMessages(dataDir, "claude-wake");
  try {
    messages.publish(text, key, at());
  } finally {
    messages.close();
  }
}
function roomSays(text: string) {
  const store = new SecondThreadStore(forkDir(dataDir, 6));
  try {
    store.add("agent", text);
  } finally {
    store.close();
  }
}
const room = <T>(fn: (s: SecondThreadStore) => T): T => {
  const store = new SecondThreadStore(forkDir(dataDir, 6));
  try {
    return fn(store);
  } finally {
    store.close();
  }
};
const notices = () => room((s) => s.entries(500).filter((e) => e.notice?.label.startsWith("@mention → ")));
const agentsOf6 = () => resolveRoomAgents(readForkAssignment(forkDir(dataDir, 6))!, dataDir);
const replying =
  (text: string, seen: string[] = []): typeof CallClaude =>
  (_claude, _args, prompt) => {
    seen.push(prompt);
    return Promise.resolve({ text });
  };
async function tick(call: typeof CallClaude = replying("SILENCE")) {
  clock += 10_000;
  return tickPatternHolders({ dataDir, claude, call, now });
}

it("matches whole @ids only", () => {
  expect(mentionsId("@se-vendre, lance-toi", "se-vendre")).toBe(true);
  expect(mentionsId("@se-vendre-2 lance-toi", "se-vendre")).toBe(false);
  expect(mentionsId("mail a@se-vendre", "se-vendre")).toBe(false);
  expect(mentionsId("Se vendre, lance-toi", "se-vendre")).toBe(false);
});

it("a holder reply mentioning @agent wakes that agent once in its stopped room, which stays stopped", async () => {
  publish("📋 Chef de projet · ancien @se-vendre", "pattern-holder:chef-de-projet:old");
  await tick(); // premier passage : l'historique ne réveille personne
  expect(notices()).toEqual([]);
  clock += 1000;
  publish("📋 Chef de projet · @se-vendre, dix minutes sur le pitch.", "pattern-holder:chef-de-projet:t1");
  await tick();
  await tick();
  const sent = notices();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.notice?.label).toBe("@mention → Se vendre");
  expect(sent[0]!.text).toContain("le pattern holder « Chef de projet » (@chef-de-projet) t'a mentionné");
  expect(sent[0]!.text).toContain("dix minutes sur le pitch");
  // Tour unique : déclencheur d'origine humaine, adressé à cet agent seul.
  expect(room((s) => oneShotTriggers(s).map((e) => e.id))).toEqual([sent[0]!.id]);
  expect(routeRoomMessage(sent[0]!, agentsOf6(), null).recipients).toEqual(["se-vendre"]);
  expect(forkEnabled(dataDir, 6)).toBe(false);
});

it("the main session's @agent and @holder both land, without a duplicate holder wake", async () => {
  await tick();
  clock += 1000;
  publish("Marco : @explorer-et-trouver et @chef-de-projet, on démarre.", "marco-1");
  const seen: string[] = [];
  const outcomes = await tick(replying("Je propose dix minutes.", seen));
  expect(notices().map((e) => e.notice?.label)).toEqual(["@mention → Explorer et trouver"]);
  expect(outcomes.filter((o) => o.slug === "chef-de-projet" && o.state === "spoke")).toHaveLength(1);
  expect(seen.filter((p) => p.includes("Tu es mentionné directement"))).toHaveLength(1);
});

it("a room agent's @holder wakes the holder in that room thread; self-mentions are ignored", async () => {
  await tick();
  roomSays("Se vendre : @chef-de-projet j'ai fini la passe (@se-vendre).");
  const seen: string[] = [];
  const outcomes = await tick(replying("Passe suivante : @assurer-le-poste.", seen));
  expect(outcomes).toContainEqual(expect.objectContaining({ slug: "chef-de-projet", state: "spoke", reason: "mention" }));
  expect(seen[0]).toContain("j'ai fini la passe");
  // Publié dans le fil de la room 6, puis sa mention @assurer-le-poste réveille cet agent.
  expect(room((s) => s.entries(50).some((e) => e.role === "agent" && e.text.startsWith("📋 Chef de projet · Passe suivante")))).toBe(true);
  await tick();
  expect(notices().map((e) => e.notice?.label)).toEqual(["@mention → Assurer le poste"]);
});

it("a holder mentioning another holder wakes it (wakeReason alone ignores holder authors)", async () => {
  await tick();
  publish("🎨 Viz · @chef-de-projet, ton avis sur le schéma ?", "pattern-holder:viz:t1");
  const seen: string[] = [];
  const outcomes = await tick(replying("Bon schéma.", seen));
  expect(outcomes).toContainEqual(expect.objectContaining({ slug: "chef-de-projet", state: "spoke", reason: "mention" }));
  expect(seen).toHaveLength(1);
});

it("caps ping-pong between two agents and ignores public Telegram content", async () => {
  await tick();
  for (let i = 0; i < MENTION_PAIR_CAP + 2; i += 1) {
    clock += 1000;
    publish(`📋 Chef de projet · @assurer-le-poste, relance ${String(i)}`, `pattern-holder:chef-de-projet:r${String(i)}`);
  }
  publish("@se-vendre: nouveau message public", "telegram-public:-100:1");
  await tick();
  await tick();
  expect(notices().map((e) => e.notice?.label)).toEqual(Array(MENTION_PAIR_CAP).fill("@mention → Assurer le poste"));
});

it("tells the holder how to wake its room's agents", () => {
  const holder = loadPatternHolders(dataDir).holders.find((h) => h.slug === "chef-de-projet")!;
  const prompt = patternHolderSystemPrompt(holder, dataDir);
  expect(prompt).toContain("Réveiller un agent : écris son @id dans ta réponse");
  expect(prompt).toContain("Agents de ta salle (Room 6) : Explorer et trouver @explorer-et-trouver, Se vendre @se-vendre, Assurer le poste @assurer-le-poste.");
});

it("the `message` tool to a holder lands in the fil it reads: the holder wakes by mention and its @agent gets a one-shot turn", async () => {
  // Test réel du 18 nov. 2026 (20:30Z) : `message` vers chef-de-projet restait dans la boîte de la
  // session principale ; ni le holder ni @explorer-et-trouver ne le voyaient.
  seedSimulatedProfile(dataDir);
  await tick();
  clock += 1000;
  const sent = deliverLocalMessage(dataDir, {
    to: "chef-de-projet",
    text: "Marco : salle six éteinte ; réveille @explorer-et-trouver pour son tri de dix minutes.",
    author: "Principal",
    key: "test-arobase-001",
  });
  expect(sent.status).toBe("recorded");
  expect(
    deliverLocalMessage(dataDir, { to: "chef-de-projet", text: "Marco : salle six éteinte ; réveille @explorer-et-trouver pour son tri de dix minutes.", author: "Principal", key: "test-arobase-001" }).status,
  ).toBe("duplicate");
  expect(readOwnerInboxHistory(dataDir)).toEqual([]);
  const seen: string[] = [];
  clock = Date.now() + 60_000;
  const outcomes = await tick(replying("Je lance la phase un : @explorer-et-trouver, dix minutes de tri.", seen));
  expect(outcomes).toContainEqual(expect.objectContaining({ slug: "chef-de-projet", state: "spoke", reason: "mention" }));
  expect(seen.filter((p) => p.includes("Tu es mentionné directement"))).toHaveLength(1);
  await tick();
  const woken = notices();
  // Une seule notice : la mention du message et celle de la réponse du holder viennent de deux auteurs.
  expect(woken.map((e) => e.notice?.label)).toContain("@mention → Explorer et trouver");
  expect(woken[0]!.text).toContain("la session principale t'a mentionné");
  expect(room((s) => oneShotTriggers(s).map((e) => e.id))).toContain(woken[0]!.id);
  expect(routeRoomMessage(woken[0]!, agentsOf6(), null).recipients).toEqual(["explorer-et-trouver"]);
  expect(forkEnabled(dataDir, 6)).toBe(false);
});
