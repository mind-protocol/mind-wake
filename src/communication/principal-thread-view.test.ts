import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readPrincipalThread } from "./principal-thread-view.js";
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, {recursive: true, force: true}); });
function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "principal-view-")); roots.push(workspace);
  const dir = path.join(workspace, "artifacts/principal"); fs.mkdirSync(dir, {recursive: true});
  return {workspace, dir};
}
it("projects edits, additions and deletions without writing or restoring the archive", () => {
  const {workspace, dir} = fixture(), file = path.join(dir, "90-fil.md");
  fs.writeFileSync(path.join(dir, "_imports.json"), '["old"]');
  fs.writeFileSync(file, "Source historique : 2026-11-20T10:00:00Z (old)\n\n**Marco —** Avant");
  const before = readPrincipalThread(workspace);
  if (!before) throw Error("Missing corpus");
  fs.writeFileSync(file, "Source historique : 2026-11-20T10:00:00Z (old)\n\n**Marco —** Après\n\n**Critique —** Vérifier.");
  const after = readPrincipalThread(workspace);
  if (!after) throw Error("Missing corpus");
  expect(after.items[0]?.id).toBe(before.items[0]?.id);
  expect(after.items[0]?.revision).not.toBe(before.items[0]?.revision);
  expect(after.items.map(i => i.text)).toEqual(["Après", "Vérifier."]);
  expect(after.items[1]?.speaker).toBe("Critique");
  fs.unlinkSync(file);
  expect(readPrincipalThread(workspace)).toMatchObject({items: [], importedIds: ["old"]});
  // Only the per-message dating sidecar is written; no conversation is restored.
  expect(fs.readdirSync(dir)).toEqual(["_editors", "_imports.json"]);
  expect(fs.readdirSync(path.join(dir, "_editors"))).toEqual(["messages.json"]);
});
it("keeps file order, editorial prose and explicit speakers without inventing dates", () => {
  const {workspace, dir} = fixture();
  fs.writeFileSync(path.join(dir, "02.md"), "**Coach —** Deux");
  fs.writeFileSync(path.join(dir, "01.md"), "# Décisions\n\n**Marco —** Un\n> **Humain —** citation");
  const view = readPrincipalThread(workspace);
  if (!view) throw Error("Missing corpus");
  expect(view.items.map(i => i.speaker)).toEqual(["Contexte éditorial", "Marco", "Coach"]);
  expect(view.items.every(i => i.at === null)).toBe(true);
});
