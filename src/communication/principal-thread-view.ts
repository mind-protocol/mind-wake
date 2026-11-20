import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { deletedPrincipalMessages, lastPrincipalEditor, type PrincipalEdit } from "./principal-file-editor.js";
import { parseMarkdownConversation, principalSpeakerNames, PRINCIPAL_CONVERSATIONS_DIR } from "./markdown-conversation.js";
import { stampPrincipalMessages, type PrincipalMessageEdit } from "./principal-message-edits.js";

export interface PrincipalThreadItem {
  id: string; text: string; speaker: string; at: string | null; source: string; revision: string;
  lastEditor?: PrincipalEdit | null;
  /** Last modification of this message only (human, agent or holder); absent while never modified. */
  edited?: PrincipalMessageEdit | null;
  /**
   * Display order: the later of its creation and its last modification. An undated message takes
   * the time it was first seen, else the date of the message before it in the file.
   */
  orderAt?: string | null;
}
export interface PrincipalThreadView {
  items: PrincipalThreadItem[];
  importedIds: string[];
  importedAt: string | null;
}
/** Speaker turn of a conversation file, with its source lines for in-place rewriting. */
/** `lead`: first line of the separator block (`---`, source marker) that belongs to this message. */
export interface PrincipalFileTurn extends PrincipalThreadItem { line: number; end: number; lead: number; head: string; editorial: boolean; historicId: string | null }

/** Imported source marker. New imports write the invisible comment; older files keep the visible line. */
export const SOURCE_MARKER = /^(?:Source historique : (\S+) \(([^\n]+)\)|<!-- source : (\S+) \(([^\n]+?)\) -->)\s*$/m;
export const sourceMarker = (at: string, id: string): string => `<!-- source : ${at} (${id.replace(/-->/g, "")}) -->`;
const SOURCE_LINES = /^(?:Source historique : .*|<!-- source : .* -->)$/gm;
export const principalRevision = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Same identities as the thread view: `principal:<file>:<historic id | speaker:ordinal | editorial:n>`. */
export function principalFileTurns(file: string, raw: string, names: readonly string[]): PrincipalFileTurn[] {
  const source = `${PRINCIPAL_CONVERSATIONS_DIR}/${file}`;
  const out: PrincipalFileTurn[] = [];
  let historic: { id: string; at: string } | null = null;
  let separator: number | null = null;
  const counts = new Map<string, number>();
  for (const turn of parseMarkdownConversation(raw, names)) {
    if (!turn.speaker) {
      const match = SOURCE_MARKER.exec(turn.text);
      const at = match?.[1] ?? match?.[3], id = match?.[2] ?? match?.[4];
      historic = at && id ? { at, id } : null;
      const editorial = turn.text.replace(SOURCE_LINES, "").replace(/^---\s*$/gm, "").trim();
      if (!editorial) { separator = turn.line; continue; }
      separator = null;
      const ordinal = (counts.get("editorial") ?? 0) + 1;
      counts.set("editorial", ordinal);
      out.push({ id: `principal:${file}:editorial:${String(ordinal)}`, text: editorial, speaker: "Contexte éditorial",
        at: null, source, revision: principalRevision(editorial), line: turn.line, end: turn.end, lead: turn.line, head: "", editorial: true, historicId: null });
      continue;
    }
    if (historic && /^(?:Tiers :|Agent tiers @)/.test(turn.speaker)) { historic = null; separator = null; continue; }
    const ordinal = (counts.get(turn.speaker) ?? 0) + 1;
    counts.set(turn.speaker, ordinal);
    out.push({
      id: `principal:${file}:${historic?.id ?? `${turn.speaker}:${String(ordinal)}`}`,
      text: turn.text, speaker: turn.speaker,
      at: historic && Number.isFinite(Date.parse(historic.at)) ? historic.at : null,
      source, revision: principalRevision(turn.text), line: turn.line, end: turn.end, lead: separator ?? turn.line, head: turn.head, editorial: false, historicId: historic?.id ?? null,
    });
    historic = null; separator = null;
  }
  return out;
}

export function principalConversationFiles(workspace: string): string[] {
  const directory = path.join(workspace, PRINCIPAL_CONVERSATIONS_DIR);
  return fs.readdirSync(directory).filter(f => f.endsWith(".md") && !f.startsWith("_")).sort().filter(file => {
    const stat = fs.lstatSync(path.join(directory, file));
    return stat.isFile() && !stat.isSymbolicLink();
  });
}

/**
 * Projection for the UI. The conversation files are never imported or rewritten here; the only
 * write is the per-message dating sidecar (`_editors/messages.json`), and only when a message
 * changed outside the hooked editors (dated then by the file's modification time).
 */
export function readPrincipalThread(workspace: string): PrincipalThreadView | null {
  const directory = path.join(workspace, PRINCIPAL_CONVERSATIONS_DIR);
  if (!fs.existsSync(directory)) return null;
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw Error("Invalid principal conversation directory");
  const names = [...principalSpeakerNames(workspace), "Humain", "NLR", "Coach"];
  // Messages dismissed from the UI (`_deleted-messages.json`) stay hidden even if a file still holds them.
  const deleted = new Set(deletedPrincipalMessages(workspace));
  const items: PrincipalThreadItem[] = [];
  let size = 0;
  for (const file of principalConversationFiles(workspace)) {
    const full = path.join(directory, file);
    const raw = fs.readFileSync(full, "utf8");
    const lastEditor = lastPrincipalEditor(workspace, `${PRINCIPAL_CONVERSATIONS_DIR}/${file}`, raw);
    size += raw.length;
    if (size > 240_000) throw Error("Principal conversation corpus too large");
    const turns = principalFileTurns(file, raw, names);
    const stamps = stampPrincipalMessages(workspace, turns, null, fs.statSync(full).mtime.toISOString());
    let created: string | null = null;
    for (const { line: _l, end: _e, lead: _le, head: _h, editorial: _ed, historicId, ...item } of turns) {
      if (historicId && deleted.has(historicId)) continue;
      const seen = stamps.seen.get(item.id);
      if (item.at) created = item.at;
      else if (seen && (!created || seen > created)) created = seen;
      const edited = stamps.edited.get(item.id) ?? null;
      const orderAt = edited && (!created || edited.at > created) ? edited.at : created;
      items.push({ ...item, lastEditor, edited, orderAt });
    }
  }
  const imports = path.join(directory, "_imports.json");
  const value: unknown = fs.existsSync(imports) ? JSON.parse(fs.readFileSync(imports, "utf8")) : [];
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string")) throw Error("Invalid principal import index");
  return { items, importedIds: value, importedAt: fs.existsSync(imports) ? fs.statSync(imports).mtime.toISOString() : null };
}
