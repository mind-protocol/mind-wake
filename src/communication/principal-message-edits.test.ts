import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { DELETED_MESSAGES_FILE, deletePrincipalMessage, editPrincipalMessage, recordClaudePrincipalEdit } from "./principal-file-editor.js";
import { readPrincipalThread } from "./principal-thread-view.js";
import { MESSAGE_EDITS_FILE } from "./principal-message-edits.js";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const source = "artifacts/principal/90-fil.md";
function fixture(text: string) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "principal-edits-")); roots.push(workspace);
  const file = path.join(workspace, source);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  return { workspace, file };
}
const FIL = [
  "# Fil", "",
  "---", "", "Source historique : 2026-11-20T10:00:00.000Z (own_a)", "", "**Marco —** Premier message", "> sur deux lignes", "",
  "---", "", "<!-- source : 2026-11-20T10:05:00.000Z (chat-b) -->", "", "**Humain —** Deuxième", "",
  "---", "", "<!-- source : 2026-11-20T10:10:00.000Z (own_c) -->", "", "**Marco —** Troisième", "",
].join("\r\n");
const item = (workspace: string, id: string) => readPrincipalThread(workspace)!.items.find(i => i.id === `principal:90-fil.md:${id}`)!;

it("rewrites only the edited message, keeps its speaker marker and the rest byte-identical", () => {
  const { workspace, file } = fixture(FIL);
  const first = item(workspace, "own_a");
  expect(first.text).toBe("Premier message\r\n> sur deux lignes".replace(/\r\n/g, "\n"));
  const result = editPrincipalMessage(workspace, { source, id: first.id, revision: first.revision, text: "Premier message corrigé\navec une suite" });
  const after = fs.readFileSync(file, "utf8");
  expect(after).toBe(FIL.replace("**Marco —** Premier message\r\n> sur deux lignes", "**Marco —** Premier message corrigé\r\navec une suite"));
  expect(result.text).toBe("Premier message corrigé\navec une suite");
  expect(item(workspace, "own_a").text).toBe("Premier message corrigé\navec une suite");
  // The source markers (visible line or invisible comment) never become message text.
  expect(readPrincipalThread(workspace)!.items.map(i => i.speaker)).toEqual(["Contexte éditorial", "Marco", "Humain", "Marco"]);
  expect(readPrincipalThread(workspace)!.items.some(i => /source/i.test(i.text))).toBe(false);
});

it("refuses a save when this message changed meanwhile, but not when another message did", () => {
  const { workspace, file } = fixture(FIL);
  const third = item(workspace, "own_c");
  // Someone appends to the same file: the inline save still goes through.
  fs.appendFileSync(file, "\r\n**Critique —** Un ajout\r\n");
  editPrincipalMessage(workspace, { source, id: third.id, revision: third.revision, text: "Troisième v2" });
  const v2 = item(workspace, "own_c");
  // A holder rewrites this very message: the stale draft is refused and the file is untouched.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Troisième v2", "Troisième resserré"));
  const before = fs.readFileSync(file, "utf8");
  expect(() => editPrincipalMessage(workspace, { source, id: v2.id, revision: v2.revision, text: "Mon brouillon" })).toThrow("brouillon");
  expect(fs.readFileSync(file, "utf8")).toBe(before);
  expect(() => editPrincipalMessage(workspace, { source, id: "principal:90-fil.md:nope", revision: "x", text: "y" })).toThrow("brouillon");
  expect(() => editPrincipalMessage(workspace, { source: "artifacts/principal/../../AGENTS.md", id: v2.id, revision: v2.revision, text: "y" })).toThrow();
});

it("orders a modified message by its modification time, whoever modified it", () => {
  const { workspace, file } = fixture(FIL);
  const baseline = readPrincipalThread(workspace)!;
  expect(baseline.items.map(i => i.orderAt)).toEqual([null, "2026-11-20T10:00:00.000Z", "2026-11-20T10:05:00.000Z", "2026-11-20T10:10:00.000Z"]);
  expect(baseline.items.every(i => i.edited === null)).toBe(true);
  // Human inline edit: exact time and editor.
  const first = item(workspace, "own_a");
  editPrincipalMessage(workspace, { source, id: first.id, revision: first.revision, text: "Premier, édité par NLR" });
  const edited = item(workspace, "own_a");
  expect(edited.edited).toMatchObject({ id: "human", name: "NLR" });
  expect(Date.parse(edited.orderAt!)).toBeGreaterThan(Date.parse("2026-11-20T10:10:00.000Z"));
  // Holder edit through its tool hook: stamped with the holder as editor.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Deuxième", "Deuxième, resserré"));
  recordClaudePrincipalEdit(workspace, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file } }, { id: "critique", name: "Critique", icon: "🔍" });
  expect(item(workspace, "chat-b").edited).toMatchObject({ id: "critique" });
  // Edit outside any hook: detected at read time and dated by the file's modification time.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Troisième", "Troisième, retouché"));
  const mtime = new Date("2026-11-21T08:00:00.000Z");
  fs.utimesSync(file, mtime, mtime);
  const third = item(workspace, "own_c");
  expect(third.edited).toEqual({ at: mtime.toISOString() });
  expect(third.orderAt).toBe(mtime.toISOString());
  // Unchanged messages keep their creation time; the stamp survives later reads.
  expect(item(workspace, "own_c").orderAt).toBe(mtime.toISOString());
  expect(JSON.parse(fs.readFileSync(path.join(workspace, MESSAGE_EDITS_FILE), "utf8"))).toHaveProperty(["principal:90-fil.md:own_c"]);
});

it("does not mistake an inserted message for edits of the following ones", () => {
  const { workspace, file } = fixture("**Marco —** Un\n\n**Marco —** Deux\n\n**Marco —** Trois\n");
  readPrincipalThread(workspace);
  fs.writeFileSync(file, "**Marco —** Zéro\n\n**Marco —** Un\n\n**Marco —** Deux\n\n**Marco —** Trois\n");
  const items = readPrincipalThread(workspace)!.items;
  expect(items.map(i => i.text)).toEqual(["Zéro", "Un", "Deux", "Trois"]);
  // Marco:2..4 only moved; Marco:1 now holds new content and counts as one change.
  expect(items.slice(1).every(i => i.edited === null)).toBe(true);
});

it("dates an undated new message by when it was first seen, after the baseline", () => {
  const { workspace, file } = fixture(FIL);
  readPrincipalThread(workspace);
  fs.appendFileSync(file, "\r\n**Marco —** Réponse écrite à la main\r\n");
  const seen = new Date("2026-11-20T12:00:00.000Z");
  fs.utimesSync(file, seen, seen);
  const last = readPrincipalThread(workspace)!.items.at(-1)!;
  expect(last).toMatchObject({ text: "Réponse écrite à la main", at: null, edited: null, orderAt: seen.toISOString() });
});

it("deletes one message with its separator, keeps it imported and leaves an undo trail", () => {
  const { workspace, file } = fixture(FIL);
  fs.writeFileSync(path.join(workspace, "artifacts/principal/_imports.json"), '["own_a"]');
  const second = item(workspace, "chat-b");
  const result = deletePrincipalMessage(workspace, { source, id: second.id, revision: second.revision });
  expect(result).toMatchObject({ deleted: true });
  const after = fs.readFileSync(file, "utf8");
  expect(after).toBe(FIL.replace("---\r\n\r\n<!-- source : 2026-11-20T10:05:00.000Z (chat-b) -->\r\n\r\n**Humain —** Deuxième\r\n\r\n", ""));
  expect(readPrincipalThread(workspace)!.items.map(i => i.text)).toEqual(["# Fil", "Premier message\n> sur deux lignes", "Troisième"]);
  expect(JSON.parse(fs.readFileSync(path.join(workspace, "artifacts/principal/_imports.json"), "utf8"))).toEqual(["own_a", "chat-b"]);
  const trail = fs.readFileSync(path.join(workspace, DELETED_MESSAGES_FILE), "utf8").trim().split("\n").map(l => JSON.parse(l) as Record<string, unknown>);
  expect(trail).toEqual([expect.objectContaining({ id: second.id, speaker: "Humain", text: "Deuxième",
    removed: "---\n\n<!-- source : 2026-11-20T10:05:00.000Z (chat-b) -->\n\n**Humain —** Deuxième" })]);
});

it("deletes a block that has only a separator and a speaker header, and refuses a stale deletion", () => {
  const cleaned = "**Humain —** Bonjour\n\n---\n\n**Marco —** Réponse\n\n---\n\n**Marco —** Suite\n";
  const { workspace, file } = fixture(cleaned);
  const reply = item(workspace, "Marco:1");
  fs.writeFileSync(file, cleaned.replace("Réponse", "Réponse resserrée"));
  expect(() => deletePrincipalMessage(workspace, { source, id: reply.id, revision: reply.revision })).toThrow("rien n'a été supprimé");
  expect(fs.readFileSync(file, "utf8")).toBe(cleaned.replace("Réponse", "Réponse resserrée"));
  const fresh = item(workspace, "Marco:1");
  deletePrincipalMessage(workspace, { source, id: fresh.id, revision: fresh.revision });
  expect(fs.readFileSync(file, "utf8")).toBe("**Humain —** Bonjour\n\n---\n\n**Marco —** Suite\n");
});
