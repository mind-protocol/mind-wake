import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHolderPassTrigger, principalActivityChange, principalActivityState, watchPrincipalActivity } from "./holder-pass-trigger.js";
import { MAIN_EDITOR, appendToPrincipalElement, editPrincipalMessage, recordClaudePrincipalEdit } from "./principal-file-editor.js";
import { readPrincipalThread } from "./principal-thread-view.js";
import { OwnerMessages } from "./owner-messages.js";

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

it("groups writes in one window, runs one pass at a time and queues one more after it", async () => {
  vi.useFakeTimers();
  const gates: ReturnType<typeof deferred>[] = [];
  let runs = 0;
  const trigger = createHolderPassTrigger(() => { runs++; const gate = deferred(); gates.push(gate); return gate.promise; }, { windowMs: 45_000 });
  trigger.notify(); await vi.advanceTimersByTimeAsync(20_000);
  trigger.notify(); trigger.notify(); // same window: not extended, not doubled
  await vi.advanceTimersByTimeAsync(25_000);
  expect(runs).toBe(1);
  expect(trigger.running).toBe(true);
  trigger.notify(); trigger.notify(); // during the pass: one more pass, after it
  await vi.advanceTimersByTimeAsync(120_000);
  expect(runs).toBe(1);
  gates[0]!.resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(runs).toBe(1); // a new window opens after the pass
  await vi.advanceTimersByTimeAsync(45_000);
  expect(runs).toBe(2);
  gates[1]!.resolve(); await vi.advanceTimersByTimeAsync(200_000);
  expect(runs).toBe(2);
});

it("end of turn: flush cancels the window, waits for a running pass, then runs the final pass", async () => {
  vi.useFakeTimers();
  const order: string[] = [];
  const first = deferred();
  let runs = 0;
  const trigger = createHolderPassTrigger(async () => {
    runs++; order.push(`start ${String(runs)}`);
    if (runs === 1) await first.promise;
    order.push(`end ${String(runs)}`);
  }, { windowMs: 45_000 });
  trigger.notify(); await vi.advanceTimersByTimeAsync(45_000);
  trigger.notify(); // queued behind the running pass
  const flushed = trigger.flush();
  await vi.advanceTimersByTimeAsync(10);
  expect(order).toEqual(["start 1"]);
  first.resolve();
  await flushed;
  expect(order).toEqual(["start 1", "end 1", "start 2", "end 2"]);
  await vi.advanceTimersByTimeAsync(200_000);
  expect(runs).toBe(2); // the queued window was absorbed by the final pass
  await trigger.stop();
  trigger.notify(); await vi.advanceTimersByTimeAsync(200_000);
  expect(runs).toBe(2);
});

it("a failing pass is logged and does not block the next one", async () => {
  const logs: string[] = [];
  let runs = 0;
  const trigger = createHolderPassTrigger(async () => { runs++; if (runs === 1) throw Error("holder en panne"); }, { log: l => logs.push(l) });
  await trigger.flush(); await trigger.flush();
  expect(runs).toBe(2);
  expect(logs.join("\n")).toContain("holder en panne");
});

function threadFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "holder-trigger-")); roots.push(dataDir);
  const workspace = path.join(dataDir, "workspace"), file = path.join(workspace, "artifacts/principal/90-fil.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "---\n\n<!-- source : 2026-11-20T10:00:00.000Z (own_a) -->\n\n**Marco —** Début.\n");
  readPrincipalThread(workspace); // baseline of the corpus
  const edit = (editor: { id: string; name: string; icon: string }, target = file) =>
    recordClaudePrincipalEdit(workspace, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: target } }, editor);
  let state = principalActivityState(dataDir);
  /** One poll: the reasons that would wake the holders. */
  const poll = () => { const change = principalActivityChange(dataDir, state); state = change.state; return change.reasons; };
  return { dataDir, workspace, file, edit, poll };
}
const CRITIQUE = { id: "critique", name: "Critique", icon: "🔍" };

it("wakes on any change of the fil by the principal or NLR, stamped or not, never on a holder's own edit", () => {
  const { dataDir, workspace, file, edit, poll } = threadFixture();
  expect(poll()).toEqual([]);
  // Holder edit stamped by its hook: no loop.
  fs.appendFileSync(file, "\n**Critique —** Resserré.\n"); edit(CRITIQUE);
  expect(poll()).toEqual([]);
  expect(poll()).toEqual([]);
  // Principal's hooked tool edit.
  fs.appendFileSync(file, "\n**Marco —** Réponse écrite dans le fil.\n"); edit(MAIN_EDITOR);
  expect(poll().join()).toContain("90-fil.md");
  expect(poll()).toEqual([]);
  // Marco writes with a shell or python: no stamp. Confirmed at the next poll.
  fs.appendFileSync(file, "\n**Marco —** Écrit par un script.\n");
  expect(poll()).toEqual([]);
  expect(poll()).toEqual(["artifacts/principal/90-fil.md modifié hors outil signé"]);
  expect(poll()).toEqual([]);
  // A holder's write whose stamp arrives just after the poll is not mistaken for Marco's.
  fs.appendFileSync(file, "\n**Critique —** Encore resserré.\n");
  expect(poll()).toEqual([]);
  edit(CRITIQUE);
  expect(poll()).toEqual([]);
  // NLR's inline save in the desktop app, then a holder rewrites the same file before the poll.
  const first = readPrincipalThread(workspace)!.items.find(i => i.id === "principal:90-fil.md:own_a")!;
  editPrincipalMessage(workspace, { source: "artifacts/principal/90-fil.md", id: first.id, revision: first.revision, text: "Début, corrigé par NLR." });
  fs.appendFileSync(file, "\n**Critique —** Après NLR.\n"); edit(CRITIQUE);
  expect(poll()).toEqual(["édition signée du principal ou de NLR"]);
  // 🎤 append by NLR.
  const last = readPrincipalThread(workspace)!.items.at(-1)!;
  appendToPrincipalElement(workspace, { source: "artifacts/principal/90-fil.md", id: last.id, revision: last.revision, text: "Dicté." });
  expect(poll().length).toBeGreaterThan(0);
  // Another conversation file written by hand; `_` files are ignored.
  fs.writeFileSync(path.join(workspace, "artifacts/principal/_principal.md"), "système");
  expect(poll()).toEqual([]); expect(poll()).toEqual([]);
  fs.writeFileSync(path.join(workspace, "artifacts/principal/80-technique.md"), "# Technique\n");
  expect(poll()).toEqual([]);
  expect(poll()).toEqual(["artifacts/principal/80-technique.md modifié hors outil signé"]);
  // Publications: the principal's wake the holders, a holder's do not.
  const holderOwn = new OwnerMessages(dataDir, "principal");
  try { holderOwn.publish("Note de holder", "pattern-holder:critique:x"); } finally { holderOwn.close(); }
  expect(poll()).toEqual([]);
  const own = new OwnerMessages(dataDir, "principal");
  try { own.publish("Message publié", "own-request"); } finally { own.close(); }
  expect(poll()).toEqual(["message publié par le principal"]);
});

it("the watcher notifies the trigger on a fil change, whether or not the principal's turn runs", async () => {
  const { dataDir, file, edit } = threadFixture();
  vi.useFakeTimers();
  const notify = vi.fn();
  const logs: string[] = [];
  const stop = watchPrincipalActivity(dataDir, { notify }, 5_000, line => logs.push(line));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(notify).not.toHaveBeenCalled();
  fs.appendFileSync(file, "\n**Critique —** Resserré.\n"); edit(CRITIQUE);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(notify).not.toHaveBeenCalled();
  fs.appendFileSync(file, "\n**Marco —** Encore.\n"); edit(MAIN_EDITOR);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(notify).toHaveBeenCalledTimes(1);
  fs.appendFileSync(file, "\n**Humain —** Écrit à la main dans le fichier.\n");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(notify).toHaveBeenCalledTimes(2);
  expect(logs.join("\n")).toContain("hors outil signé");
  stop();
});
