/** Pattern holders : appels Claude simulés, aucun appel fournisseur. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { callClaude as CallClaude } from "./fast-reply.js";
import { claimOwnerMessages } from "./owner-inbox.js";
import { OwnerMessages, readOwnerMessages } from "./owner-messages.js";
import { forkDir, sendToFork, setForkEnabled } from "../daemon/forks.js";
import { saveForkAssignment } from "../daemon/fork-assignment.js";
import { SecondThreadStore } from "../daemon/second-thread.js";
import {
  holderThread,
  humanText,
  loadPatternHolders,
  mentionsTopic,
  withoutOwnPrefix,
  parsePatternHolder,
  PATTERN_HOLDER_NOTE,
  PatternHolderService,
  previewPatternHolder,
  readPatternHolderState,
  savePatternHoldersEnabled,
  tickPatternHolders,
  extractSections,
  writeHolderSections,
} from "./pattern-holders.js";

let dataDir: string;
let clock: number;
const claude = { executable: "unused", model: "sonnet" };
const now = () => clock;
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();

const HOLDER = `# Holder

\`\`\`json pattern-holder
{ "name": "Organisation des agents", "emoji": "🧭", "quietMinutes": 10 }
\`\`\`

**NLR** (23:17) : Il ne faut pas calquer les postes sur l'organisation d'une entreprise.
`;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pattern-holders-"));
  fs.mkdirSync(path.join(dataDir, "workspace", "artifacts", "pattern-holders"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dataDir, "workspace", "artifacts", "pattern-holders", "orga-agents.md"),
    HOLDER,
  );
  clock = Date.parse("2026-11-06T10:00:00.000Z");
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function human(id: string, text: string, at: string) {
  fs.appendFileSync(
    path.join(dataDir, "human-messages.jsonl"),
    `${JSON.stringify({ id, at, text })}\n`,
  );
}
function agent(text: string, key: string, at: string) {
  const messages = new OwnerMessages(dataDir, "claude-wake");
  try {
    messages.publish(text, key, at);
  } finally {
    messages.close();
  }
}
const replying =
  (text: string, seen: string[] = []): typeof CallClaude =>
  (_claude, args, prompt) => {
    seen.push(prompt, args.join(" "));
    return Promise.resolve({ text });
  };
const tick = (call: typeof CallClaude) =>
  tickPatternHolders({ dataDir, claude, call, now });

it("parses holders and reports invalid files without stopping", () => {
  fs.writeFileSync(
    path.join(dataDir, "workspace", "artifacts", "pattern-holders", "sans-entete.md"),
    "# rien",
  );
  const { holders, invalid } = loadPatternHolders(dataDir);
  expect(holders.map((h) => [h.slug, h.name, h.quietMs])).toEqual([
    ["orga-agents", "Organisation des agents", 600_000],
  ]);
  expect(invalid).toHaveLength(1);
  expect(parsePatternHolder("x/Bad Name.md", HOLDER)).toEqual({
    error: "nom de fichier invalide : Bad Name",
  });
});

const holdersDir = () => path.join(dataDir, "workspace", "artifacts", "pattern-holders");
function writeSections(slug: string, sections: Record<string, string>) {
  const dir = path.join(holdersDir(), slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(sections)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

it("reads a folder holder: sections sorted by name, joined, json from the first file holding it", () => {
  const dir = writeSections("sections", {
    "zz-objectif.md": "Objectif.\n",
    "b-deux.md": "Deux.\n",
    "_holder.md":
      '# Sections\n\n```json pattern-holder\n{ "name": "Sections", "emoji": "🌱" }\n```\n',
    "a-un.md": '```json pattern-holder\n{ "name": "Ignoré" }\n```\nUn.\n',
    "notes.txt": "pas une section",
  });
  const holder = loadPatternHolders(dataDir).holders.find((h) => h.slug === "sections");
  expect(holder).toEqual(
    expect.objectContaining({
      name: "Sections",
      emoji: "🌱",
      file: dir,
      sections: ["_holder.md", "a-un.md", "b-deux.md", "zz-objectif.md"],
    }),
  );
  expect(holder?.seed.endsWith("\n\n---\n\nDeux.\n\n---\n\nObjectif.")).toBe(true);
  expect(holder?.seed.startsWith("# Sections")).toBe(true);
  expect(holder?.seed.split("\n\n---\n\n")).toHaveLength(4);
});

it("prefers the folder over a file of the same slug, keeps single files and ignores _ entries", () => {
  fs.writeFileSync(path.join(holdersDir(), "sections.md"), HOLDER);
  writeSections("sections", {
    "_holder.md": '```json pattern-holder\n{ "name": "Dossier" }\n```\n',
  });
  writeSections("_brouillon", {
    "_holder.md": '```json pattern-holder\n{ "name": "Brouillon" }\n```\n',
  });
  fs.writeFileSync(path.join(holdersDir(), "_ancien.md"), HOLDER);
  writeSections("vide", { "notes.txt": "rien" });
  const { holders, invalid } = loadPatternHolders(dataDir);
  expect(holders.map((h) => [h.slug, h.name])).toEqual([
    ["orga-agents", "Organisation des agents"],
    ["sections", "Dossier"],
  ]);
  expect(holders[0]?.sections).toBeUndefined();
  expect(invalid).toEqual([
    { file: path.join(holdersDir(), "vide"), error: "dossier sans section .md" },
  ]);
});

it("matches whole words without accents and reads dictation envelopes", () => {
  expect(mentionsTopic("Pas d'Organigramme humain", "organigramme")).toBe(true);
  expect(mentionsTopic("les sous-sessions meurent", "sous-sessions")).toBe(true);
  expect(mentionsTopic("réorganigrammes", "organigramme")).toBe(false);
  expect(mentionsTopic("la delegation", "délégation")).toBe(true);
  expect(
    humanText(JSON.stringify({ schema: "mind.voice.part.v1", text: "Bonjour @orga-agents" })),
  ).toBe("Bonjour @orga-agents");
});

it("stays off by default, then ignores history on its first pass", async () => {
  human("ui-old", "parlons organigramme", iso(-60_000));
  const service = new PatternHolderService({ dataDir, claude, call: replying("x"), now });
  await service.tick();
  expect(readPatternHolderState(dataDir)).toEqual({});
  savePatternHoldersEnabled(dataDir, true);
  await service.tick();
  expect(readPatternHolderState(dataDir)["orga-agents"]?.cursor).toBe(iso(-60_000));
  const outcomes = await tick(replying("jamais"));
  expect(outcomes).toEqual([]);
  expect(readPatternHolderState(dataDir)["orga-agents"]?.cursor).toBe(iso(-60_000));
});

it("wakes on any new message, publishes in the fil and hands the message to the main session", async () => {
  human("ui-0", "bonsoir", iso(-120_000));
  await tick(replying("x"));
  human("ui-1", "On fait un organigramme avec un CEO ?", iso(-30_000));
  const seen: string[] = [];
  const outcomes = await tick(
    replying("Accord du 5 novembre : pas d'organigramme d'entreprise.", seen),
  );
  expect(outcomes).toEqual([
    expect.objectContaining({ slug: "orga-agents", state: "spoke", reason: "fil" }),
  ]);
  expect(seen[0]).toContain("On fait un organigramme avec un CEO ?");
  expect(seen[1]).toContain("--tools");
  expect(readOwnerMessages(dataDir)?.at(-1)?.text).toBe(
    "🧭 Organisation des agents · Accord du 5 novembre : pas d'organigramme d'entreprise.",
  );
  const inbox = claimOwnerMessages(dataDir, "claude", "c1");
  expect(inbox).toHaveLength(1);
  expect(inbox[0]?.origin?.channel).toBe("pattern-holder");
  expect(inbox[0]?.text).toContain("@orga-agents");
  expect(inbox[0]?.text).toContain(
    "ajoute ou modifie une section dans artifacts/pattern-holders/orga-agents/",
  );
  expect(inbox[0]?.text).not.toContain("sourcée et datée");
});

it("asks for posture and patterns, not sourced agreements", () => {
  expect(PATTERN_HOLDER_NOTE).toContain("bonne posture");
  expect(PATTERN_HOLDER_NOTE).toContain("SILENCE");
  expect(PATTERN_HOLDER_NOTE).not.toContain("Cite l'accord");
  expect(PATTERN_HOLDER_NOTE).not.toContain("N'invente aucun accord");
});

it("lets SILENCE pass, keeps its chosen pause after speaking, but always answers a mention", async () => {
  await tick(replying("x"));
  human("ui-1", "organigramme ?", iso(-60_000));
  expect((await tick(replying("SILENCE")))[0]?.state).toBe("silent");
  expect(readOwnerMessages(dataDir) ?? []).toEqual([]);

  clock += 60_000;
  human("ui-2", "et les sous-sessions ?", iso(-30_000));
  expect((await tick(replying("Elles portent le dev.")))[0]?.state).toBe("spoke");

  clock += 60_000;
  agent("la session principale parle encore d'organigramme", "w-3", iso(-30_000));
  expect((await tick(replying("trop bavard")))[0]?.state).toBe("quiet");

  clock += 60_000;
  human("ui-4", "@orga-agents tu en penses quoi ?", iso(-30_000));
  const outcome = (await tick(replying("Je maintiens l'accord.")))[0];
  expect(outcome).toEqual(expect.objectContaining({ state: "spoke", reason: "mention" }));
});

it("wakes when the human answers its last message, and never on holder messages", async () => {
  await tick(replying("x"));
  human("ui-1", "@orga-agents salut", iso(-60_000));
  await tick(replying("Bonjour."));
  clock += 60_000;
  human("ui-2", "d'accord, continue", iso(-30_000));
  expect((await tick(replying("Merci.")))[0]?.reason).toBe("reply");

  clock += 60_000;
  agent("🧭 autre holder", "pattern-holder:autre:x", iso(-30_000));
  expect(await tick(replying("jamais"))).toEqual([]);
  clock += 60_000;
  agent("message de la session principale", "w-1", iso(-30_000));
  expect((await tick(replying("SILENCE")))[0]?.reason).toBe("fil");
});

it("waits for a dictation series to settle", async () => {
  await tick(replying("x"));
  human("ui-1", "organigramme", iso(-2_000));
  expect(await tick(replying("trop tôt"))).toEqual([]);
  clock += 10_000;
  expect((await tick(replying("Maintenant.")))[0]?.state).toBe("spoke");
});

it("previews a reply without publishing or touching state", async () => {
  human("ui-1", "bonjour", iso(-30_000));
  const result = await previewPatternHolder({
    dataDir,
    slug: "orga-agents",
    since: iso(-60_000),
    claude,
    call: replying("Aperçu."),
  });
  expect(result).toEqual({ reason: "fil", natural: true, text: "Aperçu." });
  expect(readOwnerMessages(dataDir) ?? []).toEqual([]);
  expect(readPatternHolderState(dataDir)).toEqual({});
});

it("drops a prefix the model copied from its own past messages", () => {
  const holder = loadPatternHolders(dataDir).holders[0];
  if (holder === undefined) throw Error("holder attendu");
  expect(withoutOwnPrefix(holder, "🧭 Organisation des agents · 🧭 Reste ouvert.")).toBe(
    "Reste ouvert.",
  );
  expect(withoutOwnPrefix(holder, "Organisation des agents : Accord.")).toBe("Accord.");
  expect(withoutOwnPrefix(holder, "SILENCE")).toBe("SILENCE");
});

it("lets a folder holder write its own sections, within its guardrails", async () => {
  writeSections("dossier", {
    "_holder.md": '```json pattern-holder\n{ "name": "Dossier", "emoji": "🧭" }\n```\n',
    "posture.md": "Ancienne posture.\n",
    "zz-objectif.md": "Objectif.\n",
  });
  const dir = path.join(dataDir, "workspace", "artifacts", "pattern-holders", "dossier");
  await tickPatternHolders({ dataDir, claude, call: replying("x"), now, only: ["dossier"] });
  human("ui-1", "@dossier retiens : vérifier n'est pas un feu vert", iso(-30_000));
  const answer = [
    "J'ai enrichi ma posture.",
    "```section posture.md",
    "**NLR** : Vérifier n'est pas un feu vert à attendre.",
    "```",
    "```section zz-fin.md",
    "interdit",
    "```",
  ].join("\n");
  const [outcome] = await tickPatternHolders({
    dataDir,
    claude,
    call: replying(answer),
    now,
    only: ["dossier"],
  });
  expect(outcome?.state).toBe("spoke");
  expect(fs.readFileSync(path.join(dir, "posture.md"), "utf8")).toBe(
    "**NLR** : Vérifier n'est pas un feu vert à attendre.\n",
  );
  expect(fs.existsSync(path.join(dir, "zz-fin.md"))).toBe(false);
  const published = readOwnerMessages(dataDir)?.at(-1)?.text ?? "";
  expect(published).toContain("J'ai enrichi ma posture.");
  expect(published).toContain("(section posture.md mise à jour)");
  expect(published).toContain("(section zz-fin.md non enregistrée");
  expect(published).not.toContain("```");
});

it("refuses sections for a single-file holder, bad names, and more than two per wake", () => {
  const single = loadPatternHolders(dataDir).holders.find((h) => h.slug === "orga-agents");
  if (single === undefined) throw Error("holder attendu");
  expect(writeHolderSections(dataDir, single, [{ name: "a.md", content: "x" }])[0]?.state).toBe(
    "refusée",
  );
  writeSections("dossier", {
    "_holder.md": '```json pattern-holder\n{ "name": "Dossier" }\n```\n',
  });
  const folder = loadPatternHolders(dataDir).holders.find((h) => h.slug === "dossier");
  if (folder === undefined) throw Error("holder attendu");
  const states = writeHolderSections(dataDir, folder, [
    { name: "_holder.md", content: "x" },
    { name: "../evasion.md", content: "x" },
    { name: "trois.md", content: "x" },
  ]).map((w) => w.state);
  expect(states).toEqual(["refusée", "refusée", "refusée"]);
  expect(extractSections("Rien.\nSILENCE")).toEqual({ text: "Rien.\nSILENCE", sections: [] });
});

it("listens to and speaks in the fork that names it in its assignment", async () => {
  const space = path.join(dataDir, "vox");
  fs.mkdirSync(space, { recursive: true });
  fs.writeFileSync(path.join(space, "DEPART.md"), "Tu es VOX.");
  setForkEnabled(dataDir, 7, true);
  saveForkAssignment(forkDir(dataDir, 7), {
    instructions: path.join(space, "DEPART.md"),
    engine: "claude",
    workspace: space,
    holder: "orga-agents",
  });
  expect(holderThread(dataDir, "orga-agents")).toBe("fork:7");
  sendToFork(dataDir, 7, "premier message");
  clock = Date.now() + 60_000; // sendToFork horodate avec l'horloge système, pas l'horloge du test.
  await tick(replying("x"));
  human("ui-1", "message du fil principal", iso(-30_000));
  sendToFork(dataDir, 7, "VOX, on fait un organigramme ?");
  clock = Date.now() + 60_000;
  const seen: string[] = [];
  const outcomes = await tick(replying("Pas d'organigramme d'entreprise.", seen));
  expect(outcomes).toEqual([expect.objectContaining({ state: "spoke", reason: "fil" })]);
  expect(seen[0]).toContain("Fil du fork 7 récent");
  expect(seen[0]).toContain("VOX, on fait un organigramme ?");
  expect(seen[0]).not.toContain("message du fil principal");
  expect(readOwnerMessages(dataDir) ?? []).toEqual([]);
  const store = new SecondThreadStore(forkDir(dataDir, 7));
  try {
    const entries = store.entries(20);
    expect(entries.some((e) => e.role === "agent" && e.text.startsWith("🧭 Organisation des agents · Pas d'organigramme"))).toBe(true);
    expect(entries.some((e) => e.notice?.hidden === true && e.text.includes("ton pattern holder"))).toBe(true);
  } finally {
    store.close();
  }
  // Son propre message ne le réveille pas.
  expect(await tick(replying("jamais"))).toEqual([]);
});

it("keeps an assigned holder quiet while its fork is disabled instead of falling back to principal", async () => {
  const space = path.join(dataDir, "vox-disabled");
  fs.mkdirSync(space, { recursive: true });
  fs.writeFileSync(path.join(space, "DEPART.md"), "Tu es VOX.");
  saveForkAssignment(forkDir(dataDir, 7), {
    instructions: path.join(space, "DEPART.md"), engine: "claude", workspace: space, holder: "orga-agents",
  });
  expect(holderThread(dataDir, "orga-agents")).toBeNull();
  human("main-1", "message du principal", iso(-30_000));
  const seen: string[] = [];
  expect(await tick(replying("ne doit pas répondre", seen))).toEqual([]);
  expect(seen).toEqual([]);
  expect(readOwnerMessages(dataDir) ?? []).toEqual([]);
});
