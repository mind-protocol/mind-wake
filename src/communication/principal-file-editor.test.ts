import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach, expect, it} from "vitest";
import {editPrincipalFile, lastPrincipalEditor, recordClaudePrincipalEdit, recordCodexPrincipalEdit} from "./principal-file-editor.js";
import {readPrincipalThread} from "./principal-thread-view.js";
const roots: string[] = [];
afterEach(() => {for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true, force:true});});
function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "principal-editor-")); roots.push(workspace);
  const source = "artifacts/principal/01-fil.md", file = path.join(workspace, source);
  fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, "**Marco —** Bonjour **à tous**");
  return {workspace, source, file};
}
const holder = {id:"critique", name:"Critique", icon:"🔍"};
it("persists deletion of pending messages and hides an already imported copy", () => {
  const {workspace, file} = fixture();
  fs.writeFileSync(file, "Source historique : 2026-11-20T10:00:00Z (pending-id)\n\n**Humain —** À supprimer");
  editPrincipalFile(workspace,{action:"principalDismiss",id:"pending-id"});
  expect(JSON.parse(editPrincipalFile(workspace,{action:"principalDeleted"}).text)).toEqual(["pending-id"]);
  expect(readPrincipalThread(workspace)?.items).toEqual([]);
});
it("saves the source file and projects the human editor independently from the speaker", () => {
  const {workspace, source, file} = fixture();
  const before = editPrincipalFile(workspace, {action:"principalRead", source});
  editPrincipalFile(workspace, {action:"principalSave", source, revision:before.revision, text:"**Marco —** Après"});
  expect(fs.readFileSync(file,"utf8")).toBe("**Marco —** Après");
  expect(readPrincipalThread(workspace)?.items[0]).toMatchObject({speaker:"Marco", lastEditor:{id:"human", icon:"👤"}});
  expect(fs.readdirSync(path.dirname(file))).not.toContain("prompt-editor.lock");
});
it("preserves concurrent changes and rejects paths outside the corpus", () => {
  const {workspace, source, file} = fixture();
  const before = editPrincipalFile(workspace,{action:"principalRead",source});
  fs.writeFileSync(file,"Concurrent");
  expect(() => editPrincipalFile(workspace,{action:"principalSave",source,revision:before.revision,text:"Draft"})).toThrow("brouillon");
  expect(fs.readFileSync(file,"utf8")).toBe("Concurrent");
  for (const source of ["../AGENTS.md","artifacts/principal/../../AGENTS.md","artifacts/principal/_imports.json"]) {
    expect(() => editPrincipalFile(workspace,{action:"principalRead",source})).toThrow();
  }
});
it("tracks successful native tools and invalidates attribution after an untracked edit", () => {
  const {workspace, source, file} = fixture();
  const event = {hook_event_name:"PostToolUseFailure",tool_name:"Edit",tool_input:{file_path:file}};
  recordClaudePrincipalEdit(workspace,event,holder);
  expect(lastPrincipalEditor(workspace,source,fs.readFileSync(file,"utf8"))).toBeNull();
  recordClaudePrincipalEdit(workspace,{...event,hook_event_name:"PostToolUse"},holder);
  expect(readPrincipalThread(workspace)?.items[0]?.lastEditor).toMatchObject(holder);
  fs.writeFileSync(file,"**Marco —** Changed outside tools");
  expect(readPrincipalThread(workspace)?.items[0]?.lastEditor).toBeNull();
  recordCodexPrincipalEdit(workspace,{type:"fileChange",status:"completed",changes:[{path:file}]},holder);
  expect(readPrincipalThread(workspace)?.items[0]?.lastEditor).toMatchObject(holder);
});
