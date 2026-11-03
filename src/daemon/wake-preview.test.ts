import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WakeManager } from "./wake-manager.js";
import { readWakePreview, readProjectWakeObjectives } from "./wake-preview.js";
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-preview-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
it("does not create a workspace or manager while reading an unavailable preview", () => {
  const missing = path.join(root, "missing");
  expect(readWakePreview(missing).state).toBe("unavailable");
  expect(fs.existsSync(missing)).toBe(false);
});
it("projects 500 wakes and the current reservation without reserving or changing state", () => {
  fs.mkdirSync(path.join(root, "artifacts"));
  fs.writeFileSync(path.join(root, "artifacts/projets-compteur.json"), JSON.stringify({ current: "a", projects: { a: { title: "Création", status: "en cours" }, b: { title: "Recherche", status: "en cours" } } }));
  const manager = new WakeManager(root);
  try {
    manager.configure(true);
    manager.plan("a", Array.from({ length: 10 }, (_, i) => ({ wake: i + 1, objective: `Étape ${i + 1}`, expected: "Preuve" })));
    manager.reserve("current"); manager.started("current");
    const before = JSON.stringify(manager.status()), pending = manager.pending();
    const preview = readWakePreview(root);
    expect(preview.state).toBe("ready");
    expect(preview.wakes).toHaveLength(500);
    expect(readWakePreview(root, 11).wakes).toHaveLength(11);
    expect(preview.wakes[0]).toMatchObject({ number: 1, phase: "prepare", objective: "Étape 1", state: "running" });
    expect(preview.wakes[10]).toMatchObject({ number: 11, projectId: "b", objective: null, state: "planned" });
    expect(JSON.stringify(manager.status())).toBe(before);
    expect(manager.pending()).toEqual(pending);
    expect(manager.db.prepare("SELECT count(*) AS n FROM allocations").get()).toEqual({ n: 1 });
    manager.finish("current", "completed"); manager.configure(false);
    expect(readWakePreview(root)).toMatchObject({ state: "disabled", completed: 1, wakes: [] });
  } finally { manager.close(); }
});
it("shows passage-specific intentions and leaves undetailed returns undefined instead of replaying the global plan", () => {
  fs.mkdirSync(path.join(root,"artifacts"));
  fs.writeFileSync(path.join(root,"artifacts/projets-compteur.json"),JSON.stringify({current:"a",projects:{a:{status:"en cours"}}}));
  const manager=new WakeManager(root);
  try {
    manager.configure(true);
    manager.plan("a",Array.from({length:10},(_,i)=>({wake:i+1,objective:"old global",expected:"old"})));
    manager.importPassages(["first","second","undetailed"].map(id=>({id,projectId:"a",question:id,expected:"proof",sources:[`${id}.md`],...(id==="undetailed"?{}:{steps:Array.from({length:10},(_,i)=>({wake:i+1,objective:`${id} ${i+1}`,expected:"proof"}))})})),manager.status()!.revision,"apply");
    const before=JSON.stringify(manager.status());
    expect(readWakePreview(root,30).wakes.filter(w=>w.inBlock===1)).toMatchObject([
      {passageId:"first",objective:"first 1"},{passageId:"second",objective:"second 1"},{passageId:"undetailed",objective:null},
    ]);
    expect(JSON.stringify(manager.status())).toBe(before);
  } finally {manager.close();}
});

it("projects ten objectives for the selected thread and never falls back from an undetailed passage", () => {
  fs.mkdirSync(path.join(root,"artifacts"));
  fs.writeFileSync(path.join(root,"artifacts/projets-compteur.json"),JSON.stringify({current:"a",projects:{a:{status:"en cours",title:"A"},b:{status:"en cours",title:"B"}}}));
  const manager=new WakeManager(root);
  try {
    manager.configure(true);
    manager.plan("a",Array.from({length:10},(_,i)=>({wake:i+1,objective:`A ${i+1}`,expected:"Preuve A"})));
    manager.plan("b",Array.from({length:10},(_,i)=>({wake:i+1,objective:`B ${i+1}`,expected:"Preuve B"})));
    manager.importPassages([{id:"new",projectId:"a",question:"Nouvelle piste",expected:"Preuve",sources:["new.md"]}],manager.status()!.revision,"apply");
    const before=JSON.stringify(manager.status());
    const a=readProjectWakeObjectives(root,"a",3);
    expect(a?.wakes).toHaveLength(10);
    expect(a).toMatchObject({projectId:"a",inBlock:3});
    expect(a?.wakes[2]).toMatchObject({wake:3,objective:"A 3",expected:"Preuve A"});
    expect(readProjectWakeObjectives(root,"b",6)?.wakes[5]?.objective).toBe("B 6");
    expect(readProjectWakeObjectives(root,"a",1,"new")?.wakes.every(s=>s.objective===null)).toBe(true);
    expect(readProjectWakeObjectives(root,"missing",1)).toBeNull();
    expect(JSON.stringify(manager.status())).toBe(before);
  } finally {manager.close();}
});
