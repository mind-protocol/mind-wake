import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { workspaceDirFor } from "../daemon/paths.js";
import { MESSAGE_EDITS_FILE } from "./principal-message-edits.js";
import { HUMAN_EDITOR, MAIN_EDITOR, lastPrincipalEditor, principalFileRevision } from "./principal-file-editor.js";
import { PRINCIPAL_CONVERSATIONS_DIR } from "./markdown-conversation.js";

/**
 * Holder passes during the principal's turn (NLR, 20 nov. 19:12 : « si jamais tu envoies une
 * réponse dans le fil, ça les réveille »).
 *
 * - `notify()` opens a grouping window (default 45 s) at the first signal; later signals in that
 *   window join the same pass. The window is not extended, so continuous writing still triggers.
 * - At most one pass runs at a time. A signal during a pass schedules one more window after it.
 * - `flush()` (end of the principal's turn) cancels the window and runs a pass now, after the
 *   running one if any. It resolves when that pass has finished.
 */
export interface HolderPassTrigger { notify(): void; flush(): Promise<void>; stop(): Promise<void>; readonly running: boolean }
export function createHolderPassTrigger(run: () => Promise<void>, options: {
  windowMs?: number; log?: (line: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (handle: unknown) => void;
} = {}): HolderPassTrigger {
  const windowMs = options.windowMs ?? 45_000;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let timer: unknown = null, current: Promise<void> | null = null, again = false, stopped = false;
  const start = (): Promise<void> => {
    timer = null;
    const pass = (async () => {
      try { await run(); } catch (error) { options.log?.(`passage des holders interrompu : ${String(error)}`); }
    })();
    current = pass.finally(() => {
      current = null;
      if (again && !stopped) { again = false; schedule(); }
    });
    return current;
  };
  const schedule = () => { if (timer === null && !stopped) timer = setTimer(() => { void start(); }, windowMs); };
  return {
    get running() { return current !== null; },
    notify() {
      if (stopped) return;
      if (current) { again = true; return; }
      schedule();
    },
    async flush() {
      if (timer !== null) { clearTimer(timer); timer = null; }
      again = false;
      while (current) await current;
      if (timer !== null) { clearTimer(timer); timer = null; }
      if (!stopped) await start();
    },
    async stop() { stopped = true; if (timer !== null) clearTimer(timer); timer = null; while (current) await current; },
  };
}

/**
 * What wakes the holders (NLR, 20 nov. 19:48 : toute modification du fil, par lui ou par le
 * principal, les réveille ; pas celles des holders eux-mêmes).
 *
 * Three signals, compared poll after poll:
 * - the content of each conversation file `artifacts/principal/*.md` (not `_*.md`). A changed
 *   file wakes the holders unless its current revision is attributed to a holder in
 *   `_editors/<hash>.json` (holder tool edits are stamped by their hook). NLR's saves are stamped
 *   `human`, the principal's hooked edits `principal`; a change with no matching stamp (shell or
 *   python write, imported human message) wakes too, but only once it is still unattributed at
 *   the next poll, because a holder's stamp arrives from a hook process just after its write;
 * - the newest `principal`/`human` stamp in `_editors/messages.json`, so such an edit still counts
 *   when a holder rewrites the same file before the next poll;
 * - the number of messages published by the principal (holder publications excluded).
 */
export const NON_HOLDER_EDITORS: ReadonlySet<string> = new Set([MAIN_EDITOR.id, HUMAN_EDITOR.id]);
export interface PrincipalActivityState {
  stamps: string; published: string;
  /** source → content hash ("" once read as missing). */
  files: Map<string, string>;
  /** source → unattributed hash waiting one more poll for a holder stamp. */
  pending: Map<string, string>;
}

function conversationFiles(workspace: string): Map<string, string> {
  const files = new Map<string, string>();
  const dir = path.join(workspace, PRINCIPAL_CONVERSATIONS_DIR);
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return files; }
  for (const name of names.sort()) {
    if (name.startsWith("_") || !name.endsWith(".md")) continue;
    try { files.set(`${PRINCIPAL_CONVERSATIONS_DIR}/${name}`, fs.readFileSync(path.join(dir, name), "utf8")); }
    catch { /* Unreadable or a directory: not a conversation file. */ }
  }
  return files;
}

function editorStamps(workspace: string): string {
  let latest = "";
  try {
    const store = JSON.parse(fs.readFileSync(path.join(workspace, MESSAGE_EDITS_FILE), "utf8")) as
      Record<string, { by?: string; seen?: string; edited?: { id?: string; at?: string } }>;
    for (const row of Object.values(store)) {
      if (row.by && NON_HOLDER_EDITORS.has(row.by) && row.seen && row.seen > latest) latest = row.seen;
      if (row.edited?.id && NON_HOLDER_EDITORS.has(row.edited.id) && row.edited.at && row.edited.at > latest) latest = row.edited.at;
    }
  } catch { /* No corpus activity recorded yet. */ }
  return latest;
}

function publishedCount(dataDir: string): string {
  const db = path.join(dataDir, "owner-messages.sqlite");
  if (!fs.existsSync(db)) return "0@";
  try {
    const handle = new Database(db, { readonly: true, fileMustExist: true });
    try {
      const row = handle.prepare("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE request_key NOT LIKE 'pattern-holder:%' AND request_key NOT LIKE 'call-opening:%'").get() as { n: number; last: string | null };
      return `${String(row.n)}@${row.last ?? ""}`;
    } finally { handle.close(); }
  } catch { return "0@"; /* Unreadable store: the files still count. */ }
}

/** Baseline: nothing that already exists wakes the holders. */
export function principalActivityState(dataDir: string): PrincipalActivityState {
  const workspace = workspaceDirFor(dataDir);
  const files = new Map([...conversationFiles(workspace)].map(([source, text]) => [source, principalFileRevision(text)]));
  return { stamps: editorStamps(workspace), published: publishedCount(dataDir), files, pending: new Map() };
}

/** Compare with the previous poll; `reasons` is empty when the holders stay asleep. */
export function principalActivityChange(dataDir: string, previous: PrincipalActivityState): { state: PrincipalActivityState; reasons: string[] } {
  const workspace = workspaceDirFor(dataDir);
  const reasons: string[] = [];
  const stamps = editorStamps(workspace), published = publishedCount(dataDir);
  if (stamps !== previous.stamps) reasons.push("édition signée du principal ou de NLR");
  if (published !== previous.published) reasons.push("message publié par le principal");
  const current = conversationFiles(workspace);
  const files = new Map<string, string>(), pending = new Map<string, string>();
  for (const source of new Set([...previous.files.keys(), ...current.keys()])) {
    const text = current.get(source);
    const hash = text === undefined ? "" : principalFileRevision(text);
    if (text !== undefined) files.set(source, hash);
    const waiting = previous.pending.get(source);
    if (hash === previous.files.get(source) && waiting === undefined) continue;
    if (text === undefined) { reasons.push(`${source} supprimé`); continue; }
    const editor = lastPrincipalEditor(workspace, source, text);
    if (editor && !NON_HOLDER_EDITORS.has(editor.id)) continue; // a holder's own edit: no loop
    if (editor) { reasons.push(`${source} modifié (${editor.id})`); continue; }
    // Unattributed: confirmed only if it is still the same unattributed revision one poll later.
    if (waiting === hash) reasons.push(`${source} modifié hors outil signé`);
    else pending.set(source, hash);
  }
  return { state: { stamps, published, files, pending }, reasons };
}

/**
 * Polls the principal's thread and notifies the trigger when it changed. The daemon runs it for
 * its whole life, so NLR's edits between two turns wake the holders too (no principal session).
 */
export function watchPrincipalActivity(dataDir: string, trigger: Pick<HolderPassTrigger, "notify">, intervalMs = 5_000, log?: (line: string) => void): () => void {
  let state = principalActivityState(dataDir);
  const handle = setInterval(() => {
    try {
      const change = principalActivityChange(dataDir, state);
      state = change.state;
      if (change.reasons.length) { log?.(`holders réveillés : ${change.reasons.join(", ")}`); trigger.notify(); }
    } catch (error) { log?.(`surveillance du fil indisponible : ${String(error)}`); }
  }, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
