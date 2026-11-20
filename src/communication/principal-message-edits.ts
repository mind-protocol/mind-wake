import fs from "node:fs";
import path from "node:path";
import { PRINCIPAL_CONVERSATIONS_DIR } from "./markdown-conversation.js";
import type { PrincipalEditor } from "./principal-file-editor.js";

/**
 * Per-message modification dates of the principal conversation.
 *
 * The Markdown stays free text: agents and holders edit it with ordinary file tools, so an
 * in-file timestamp would not be updated by them. Instead, each message's content hash is kept
 * in `artifacts/principal/_editors/messages.json` and compared on every change:
 * - hooked edits (NLR's inline save, Claude/Codex tool edits of the principal and holders) stamp
 *   the exact time and editor;
 * - an edit made outside those hooks is detected at the next read and dated by the file mtime;
 * - an identity that only moved (e.g. `Marco:3` became `Marco:4` after an insertion) keeps the
 *   record of the identical content instead of looking modified;
 * - a message first seen after the baseline gets `seen`, which dates undated new messages.
 */
export interface PrincipalMessageEdit extends Partial<PrincipalEditor> { at: string }
interface Row { hash: string; seen?: string; by?: string; edited?: PrincipalMessageEdit }
type Store = Record<string, Row>;
export interface StampedTurn { id: string; source: string; revision: string }

export const MESSAGE_EDITS_FILE = `${PRINCIPAL_CONVERSATIONS_DIR}/_editors/messages.json`;

function load(file: string): Store {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Store = {};
    for (const [id, row] of Object.entries(value as Record<string, Row>)) {
      if (typeof row?.hash !== "string") continue;
      const edited = row.edited && typeof row.edited.at === "string" && Number.isFinite(Date.parse(row.edited.at)) ? row.edited : undefined;
      out[id] = { hash: row.hash, ...(typeof row.seen === "string" ? { seen: row.seen } : {}), ...(typeof row.by === "string" ? { by: row.by } : {}), ...(edited ? { edited } : {}) };
    }
    return out;
  } catch { return {}; }
}

/**
 * Compare the current turns of one file with their recorded hashes and stamp the changed ones.
 * `editor` is null when the change was not observed (read-path detection).
 * Returns the modification and first-seen dates of the current messages of this file.
 */
export interface MessageStamps { edited: Map<string, PrincipalMessageEdit>; seen: Map<string, string> }
export function stampPrincipalMessages(workspace: string, turns: readonly StampedTurn[], editor: PrincipalEditor | null, at: string): MessageStamps {
  const file = path.join(workspace, MESSAGE_EDITS_FILE);
  const store = load(file);
  const result: MessageStamps = { edited: new Map(), seen: new Map() };
  if (!turns.length) return result;
  const source = turns[0]!.source;
  const prefix = `principal:${source.split("/").at(-1) ?? source}:`;
  const previous = Object.entries(store).filter(([id]) => id.startsWith(prefix));
  const baseline = previous.length === 0;
  const byHash = new Map(previous.map(([, row]) => [row.hash, row] as const));
  let changed = false;
  const next: Store = {};
  for (const turn of turns) {
    const old = store[turn.id];
    let row: Row;
    if (old?.hash === turn.revision) {
      // A read may have detected this edit just before the tool hook named its editor.
      const unnamed = editor && old.edited && !old.edited.id && Date.parse(at) - Date.parse(old.edited.at) < 120_000;
      const unclaimed = editor && !old.edited && old.seen && !old.by && Date.parse(at) - Date.parse(old.seen) < 120_000;
      row = unnamed ? { ...old, edited: { ...old.edited!, ...editor } } : unclaimed ? { ...old, by: editor.id } : old;
    }
    else if (byHash.has(turn.revision)) row = byHash.get(turn.revision)!; // moved, not modified
    else if (old) row = { hash: turn.revision, ...(old?.seen ? { seen: old.seen } : {}), edited: { at, ...(editor ?? {}) } };
    else row = { hash: turn.revision, ...(baseline ? {} : { seen: at, ...(editor ? { by: editor.id } : {}) }) };
    if (row !== old) changed = true;
    next[turn.id] = row;
    if (row.edited) result.edited.set(turn.id, row.edited);
    if (row.seen) result.seen.set(turn.id, row.seen);
  }
  for (const [id] of previous) if (!(id in next)) changed = true;
  if (changed) {
    const merged: Store = Object.fromEntries(Object.entries(store).filter(([id]) => !id.startsWith(prefix)));
    Object.assign(merged, next);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) return result;
      if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile())) return result;
      const temp = `${file}.${String(process.pid)}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(merged) + "\n");
      fs.renameSync(temp, file);
    } catch { /* Dating is best effort: the conversation itself stays readable. */ }
  }
  return result;
}
