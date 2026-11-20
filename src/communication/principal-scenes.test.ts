import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { appendToPrincipalElement, deletePrincipalMessage, editPrincipalMessage } from "./principal-file-editor.js";
import { readPrincipalThread } from "./principal-thread-view.js";
import { markdownNativeHistory } from "./markdown-conversation.js";

/** Format restructured by the principal on 20 nov.: scenes, no source lines. */
const SCENES = [
  "## Scènes en cours", "",
  "### Jeton et push", "",
  "**Marco —** Push coupé.", "",
  "**Improver —** Bon geste.", "",
  "**Ouvert —** prouver le Sync now.", "",
  "### Taille de l'historique", "",
  "**Marco —** 4,7 gigas.", "",
].join("\n");
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const source = "artifacts/principal/90-fil.md";
function fixture(text = SCENES) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "principal-scenes-")); roots.push(workspace);
  const file = path.join(workspace, source);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  return { workspace, file };
}
const find = (workspace: string, text: string) => readPrincipalThread(workspace)!.items.find(i => i.text === text)!;

it("projects scene titles and their messages without source lines", () => {
  const { workspace } = fixture();
  expect(readPrincipalThread(workspace)!.items.map(i => [i.speaker, i.text])).toEqual([
    ["Contexte éditorial", "## Scènes en cours"], ["Contexte éditorial", "### Jeton et push"],
    ["Marco", "Push coupé."], ["Improver", "Bon geste."], ["Ouvert", "prouver le Sync now."],
    ["Contexte éditorial", "### Taille de l'historique"], ["Marco", "4,7 gigas."],
  ]);
});

it("recognises « Humain : » as a human turn, in the view and in the injected history", () => {
  const text = "**Marco —** Question ?\n\nHumain : Oui, vas-y.\n";
  const { workspace } = fixture(text);
  expect(readPrincipalThread(workspace)!.items.map(i => [i.speaker, i.text])).toEqual([["Marco", "Question ?"], ["Humain", "Oui, vas-y."]]);
  expect(markdownNativeHistory(text, source, ["Marco"]).map(t => [t.author, t.role, t.text]))
    .toEqual([["Marco", "assistant", "Question ?"], ["Humain", "user", "Oui, vas-y."]]);
});

it("🎤 on a message adds « Humain : » right after it; on a section title, at the end of the section", () => {
  const { workspace, file } = fixture();
  const message = find(workspace, "Push coupé.");
  const added = appendToPrincipalElement(workspace, { source, id: message.id, revision: message.revision, text: "Et le\nhook ?" });
  expect(fs.readFileSync(file, "utf8")).toContain("**Marco —** Push coupé.\n\nHumain : Et le hook ?\n\n**Improver —** Bon geste.");
  expect(added).toMatchObject({ text: "Et le hook ?" });
  // The next dictated segment extends the same line through the inline edit.
  editPrincipalMessage(workspace, { source, id: added.id, revision: added.revision, text: "Et le hook ? Il tourne." });
  expect(fs.readFileSync(file, "utf8")).toContain("Humain : Et le hook ? Il tourne.\n\n**Improver —**");
  const title = find(workspace, "### Jeton et push");
  appendToPrincipalElement(workspace, { source, id: title.id, revision: title.revision, text: "Fin de scène." });
  expect(fs.readFileSync(file, "utf8")).toContain("**Ouvert —** prouver le Sync now.\n\nHumain : Fin de scène.\n\n### Taille de l'historique");
  const last = find(workspace, "### Taille de l'historique");
  appendToPrincipalElement(workspace, { source, id: last.id, revision: last.revision, text: "Dernier mot." });
  expect(fs.readFileSync(file, "utf8").endsWith("**Marco —** 4,7 gigas.\n\nHumain : Dernier mot.\n")).toBe(true);
  const stale = { source, id: message.id, revision: "stale", text: "x" };
  expect(() => appendToPrincipalElement(workspace, stale)).toThrow("n'a pas été ajoutée");
});

it("edits and deletes scene titles and messages in the scene format", () => {
  const { workspace, file } = fixture();
  const title = find(workspace, "### Jeton et push");
  editPrincipalMessage(workspace, { source, id: title.id, revision: title.revision, text: "### Jeton révoqué" });
  const geste = find(workspace, "Bon geste.");
  deletePrincipalMessage(workspace, { source, id: geste.id, revision: geste.revision });
  expect(fs.readFileSync(file, "utf8")).toBe(SCENES.replace("### Jeton et push", "### Jeton révoqué").replace("**Improver —** Bon geste.\n\n", ""));
});
