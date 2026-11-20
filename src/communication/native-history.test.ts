import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { parseMarkdownConversation, markdownNativeHistory, principalSeedHistory } from "./markdown-conversation.js";
import { codexHistoryItems, writeClaudeHistory } from "./native-history.js";
import { holderNativeHistory } from "./pattern-holders.js";
import { principalNativeHistory } from "./fil-continuity.js";
import { OwnerMessages } from "./owner-messages.js";

it("parses explicit speakers with bold and dash variants, keeping multiline paragraphs", () => {
  const markdown = "# Scène\nUne conversation imaginée.\n\n**NLR —** Bonjour\n\nSuite du même tour.\n\n**Marco** : Salut\n**Coach :** Pourquoi ?\nMarco — Voilà.\nNLR: Merci\n";
  const turns = parseMarkdownConversation(markdown, ["NLR"]);
  expect(turns.map(t => t.speaker)).toEqual([null, "NLR", "Marco", "Coach", "Marco", "NLR"]);
  expect(turns[1]?.text).toBe("Bonjour\n\nSuite du même tour.");
  const native = markdownNativeHistory(markdown, "scene.md", ["Marco"]);
  expect(native.map(t => t.role)).toEqual(["user", "user", "assistant", "user", "assistant", "user"]);
  expect(native[0]?.text).toContain("imaginée");
});

it("does not parse quoted, indented, fenced, or ordinary colon text as speaker markers", () => {
  const markdown = "**Marco** : Réponse\n> **NLR** : citation\n    **Coach** : code\n```md\n**Marco** : faux tour\n```\nSource: document\n## Autre scène\nContexte sans locuteur.";
  const turns = parseMarkdownConversation(markdown);
  expect(turns.map(t => t.speaker)).toEqual(["Marco", null]);
  expect(turns[0]?.text).toContain("faux tour");
  expect(turns[1]?.text).toContain("Contexte sans locuteur");
});

it("only treats the target holder's own seed and live messages as assistant turns", () => {
  const holder = { name: "Critique", slug: "critique", file: "critique/", seed: "**Marco** : Ton avis ?\n**Critique** : Voici." };
  const fil = [
    { id: "one", at: "2026-11-20T10:00:00Z", author: "agent" as const, holder: "critique", text: "Ma réponse" },
    { id: "two", at: "2026-11-20T10:01:00Z", author: "agent" as const, holder: "cockpit", text: "Une autre voix" },
  ];
  const history = holderNativeHistory(holder, fil, fil.slice(1));
  expect(history.map(m => m.role)).toEqual(["user", "assistant", "assistant", "user"]);
  expect(history.filter(m => m.id === "two")).toHaveLength(1);
  expect(codexHistoryItems(history).map(m => m.content[0]?.type)).toEqual(["input_text", "output_text", "output_text", "input_text"]);
});

it("reloads the Markdown directory in filename order, uses configured aliases and preserves provenance", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-seed-"));
  try {
    const dir = path.join(root, "artifacts/principal"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "_principal.md"), '```json principal\n{"name":"Aube","aliases":["Agent Wake"]}\n```');
    fs.writeFileSync(path.join(dir, "02.md"), "**Aube** : Deuxième.");
    fs.writeFileSync(path.join(dir, "01.md"), "Une scène imaginée.\n**Agent Wake —** Première.");
    const seed = principalSeedHistory(root);
    expect(seed.map(m => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(seed[0]?.text).toBe("Une scène imaginée.");
    const file = writeClaudeHistory(path.join(root, "transcripts"), seed, root);
    const rows = fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line) as { uuid: string; parentUuid: string | null; message: { role: string } });
    expect(rows[1]?.parentUuid).toBe(rows[0]?.uuid);
    expect(rows.map(row => row.message.role)).toEqual(["user", "assistant", "assistant"]);
    fs.writeFileSync(path.join(dir, "02.md"), "**Aube** : Corrigé.");
    expect(principalSeedHistory(root).at(-1)?.text).toBe("Corrigé.");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("separates holders from the principal even when they publish using the same agent id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-author-"));
  try {
    const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
    const messages = new OwnerMessages(root, "claude-wake");
    messages.publish("Principal répond", "reply-principal");
    const holder = messages.publish("Critique intervient", "pattern-holder:critique:trigger");
    const changed = messages.publish("Version initiale", "reply-change");
    messages.change(changed.id, 1, "Version corrigée"); messages.close();
    const history = principalNativeHistory(root, workspace, "claude-wake");
    expect(history.find(m => m.text === "Principal répond")?.role).toBe("assistant");
    expect(history.find(m => m.id === holder.id)).toMatchObject({ role: "user", author: "Agent tiers @critique" });
    expect(history.filter(m => m.id === changed.id)).toHaveLength(1);
    expect(history.find(m => m.id === changed.id)?.text).toBe("Version corrigée");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
