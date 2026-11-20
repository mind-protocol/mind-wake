import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PRINCIPAL_CONVERSATIONS_DIR, principalSpeakerNames } from "./markdown-conversation.js";
import { stampPrincipalMessages } from "./principal-message-edits.js";
import { principalFileTurns } from "./principal-thread-view.js";

export interface PrincipalEditor { id: string; name: string; icon: string }
export interface PrincipalEdit extends PrincipalEditor { at: string; revision: string }
export const MAIN_EDITOR: PrincipalEditor = { id: "principal", name: "Principal", icon: "🌱" };
export const HUMAN_EDITOR: PrincipalEditor = { id: "human", name: "NLR", icon: "👤" };
export const principalFileRevision = (text: string): string => createHash("sha256").update(text).digest("hex");

function target(workspace: string, source: string): string {
  if (!/^artifacts\/principal\/(?!_)[^/\\:<>"|?*]+\.md$/.test(source)) throw Error("Fichier de conversation non autorisé.");
  const dir = path.join(workspace, PRINCIPAL_CONVERSATIONS_DIR);
  if (fs.lstatSync(dir).isSymbolicLink()) throw Error("Dossier de conversation lié refusé.");
  const file = path.join(workspace, source), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error("Fichier de conversation lié refusé.");
  return file;
}
function metadataFile(workspace: string, source: string): string {
  return path.join(workspace, PRINCIPAL_CONVERSATIONS_DIR, "_editors", principalFileRevision(source) + ".json");
}
export function lastPrincipalEditor(workspace: string, source: string, text: string): PrincipalEdit | null {
  try {
    const value = JSON.parse(fs.readFileSync(metadataFile(workspace, source), "utf8")) as PrincipalEdit;
    if (value.revision !== principalFileRevision(text) || ![value.id, value.name, value.icon, value.at].every(v => typeof v === "string")) return null;
    return value;
  } catch { return null; }
}
export function recordPrincipalEditor(workspace: string, file: string, editor: PrincipalEditor): void {
  const source = path.relative(workspace, path.resolve(workspace, file)).replace(/\\/g, "/");
  // Other project files are outside this conversation's provenance.
  if (!source.startsWith(PRINCIPAL_CONVERSATIONS_DIR + "/")) return;
  try {
    const text = fs.readFileSync(target(workspace, source), "utf8");
    const record = metadataFile(workspace, source);
    fs.mkdirSync(path.dirname(record), { recursive: true });
    if (fs.lstatSync(path.dirname(record)).isSymbolicLink()) return;
    if (fs.existsSync(record)) {
      const stat = fs.lstatSync(record);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return;
    }
    const at = new Date().toISOString();
    fs.writeFileSync(record, JSON.stringify({ ...editor, at, revision: principalFileRevision(text) }) + "\n");
    stampFile(workspace, source, text, editor, at);
  } catch { /* Missing/deleted/unsafe files carry no attribution. */ }
}
const speakerNames = (workspace: string) => [...principalSpeakerNames(workspace), "Humain", "NLR", "Coach"];
/** Date the messages this edit changed (see `principal-message-edits.ts`). */
function stampFile(workspace: string, source: string, text: string, editor: PrincipalEditor, at: string): void {
  stampPrincipalMessages(workspace, principalFileTurns(path.basename(source), text, speakerNames(workspace)), editor, at);
}
export function recordClaudePrincipalEdit(workspace: string, event: Record<string, unknown>, editor: PrincipalEditor): void {
  if (event["hook_event_name"] !== "PostToolUse" || !["Write", "Edit", "MultiEdit"].includes(String(event["tool_name"]))) return;
  const input = event["tool_input"] as { file_path?: unknown } | undefined;
  if (typeof input?.file_path === "string") recordPrincipalEditor(workspace, input.file_path, editor);
}
export function recordCodexPrincipalEdit(workspace: string, item: Record<string, unknown> | null, editor: PrincipalEditor): void {
  if (item?.["type"] !== "fileChange" || item["status"] !== "completed" || !Array.isArray(item["changes"])) return;
  for (const change of item["changes"] as { path?: unknown }[]) if (typeof change.path === "string") recordPrincipalEditor(workspace, change.path, editor);
}
export function deletedPrincipalMessages(workspace: string): string[] {
  const file = path.join(workspace, PRINCIPAL_CONVERSATIONS_DIR, "_deleted-messages.json");
  if (!fs.existsSync(file)) return [];
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error("Registre de suppression invalide.");
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(value) || !value.every(id => typeof id === "string")) throw Error("Registre de suppression invalide.");
  return value;
}
export function editPrincipalFile(workspace: string, request: { action: string; source?: unknown; text?: unknown; revision?: unknown; id?: unknown }) {
  if (request.action === "principalDeleted" || request.action === "principalDismiss") {
    const ids = deletedPrincipalMessages(workspace);
    if (request.action === "principalDismiss") {
      if (typeof request.id !== "string" || !request.id || request.id.length > 500) throw Error("Message invalide.");
      const dir = path.join(workspace, PRINCIPAL_CONVERSATIONS_DIR);
      fs.mkdirSync(dir, {recursive:true});
      if (fs.lstatSync(dir).isSymbolicLink()) throw Error("Dossier lié refusé.");
      if (!ids.includes(request.id)) ids.push(request.id);
      fs.writeFileSync(path.join(dir, "_deleted-messages.json"), JSON.stringify(ids));
    }
    return {text:JSON.stringify(ids), revision:""};
  }
  if (typeof request.source !== "string") throw Error("Fichier manquant.");
  const file = target(workspace, request.source), current = fs.readFileSync(file, "utf8");
  if (request.action === "principalRead") return { text: current, revision: principalFileRevision(current), source: request.source };
  if (request.action !== "principalSave" || typeof request.text !== "string" || request.text.length > 240_000) throw Error("Contenu de conversation invalide.");
  if (request.revision !== principalFileRevision(current)) throw Error("Ce fichier a changé depuis son ouverture. Ton brouillon est conservé ; recharge la version actuelle avant de sauvegarder.");
  fs.writeFileSync(file, request.text);
  recordPrincipalEditor(workspace, file, HUMAN_EDITOR);
  return { text: request.text, revision: principalFileRevision(request.text), source: request.source };
}

/**
 * Element of a conversation file addressed by the UI, checked against the revision the UI showed.
 * Editorial passages (section titles `##`/`###`, prose) are editable only when their lines hold
 * nothing hidden (no `---` or source marker that a rewrite would drop).
 */
function locate(workspace: string, request: { source?: unknown; id?: unknown; revision?: unknown }, missing: string, changed: string) {
  if (typeof request.source !== "string" || typeof request.id !== "string") throw Error("Message manquant.");
  const file = target(workspace, request.source), current = fs.readFileSync(file, "utf8");
  const turns = principalFileTurns(path.basename(file), current, speakerNames(workspace));
  const turn = turns.find(t => t.id === request.id);
  if (!turn) throw Error(missing);
  const lines = current.split(/\r?\n/);
  if (turn.editorial && lines.slice(turn.line - 1, turn.end).join("\n").trim() !== turn.text) throw Error("Ce passage éditorial contient des marques cachées : modifie-le dans son fichier.");
  if (request.revision !== turn.revision) throw Error(changed);
  return { file, current, turns, turn, lines, eol: current.includes("\r\n") ? "\r\n" : "\n" };
}

/**
 * Inline edit of one message: only that message's lines are rewritten, the speaker marker is
 * kept, and the rest of the file stays byte-identical. `revision` is the message's own revision
 * (hash of its text when NLR started editing): appends or edits elsewhere in the same file do not
 * block the save, but a concurrent change of this message does, and the draft stays in the UI.
 */
export function editPrincipalMessage(workspace: string, request: { source?: unknown; id?: unknown; text?: unknown; revision?: unknown }) {
  if (typeof request.source !== "string" || typeof request.id !== "string") throw Error("Message manquant.");
  if (typeof request.text !== "string" || !request.text.trim() || request.text.length > 60_000) throw Error("Contenu du message invalide.");
  const { file, turn, lines, eol } = locate(workspace, request,
    "Ce message n'existe plus dans son fichier. Ton brouillon est conservé.",
    "Ce message a changé depuis le début de ta modification. Ton brouillon est conservé ; annule pour voir la version actuelle.");
  const body = request.text.replace(/\r\n/g, "\n").trim().split("\n");
  const replacement = [turn.head + (body[0] ?? ""), ...body.slice(1)];
  const text = [...lines.slice(0, turn.line - 1), ...replacement, ...lines.slice(turn.end)].join(eol);
  if (text.length > 240_000) throw Error("Contenu de conversation invalide.");
  fs.writeFileSync(file, text);
  recordPrincipalEditor(workspace, file, HUMAN_EDITOR);
  const saved = principalFileTurns(path.basename(file), text, speakerNames(workspace)).find(t => t.id === request.id);
  return { id: request.id, source: request.source, text: saved?.text ?? request.text, revision: saved?.revision ?? null };
}

/** Local undo trail of deleted messages: one JSON line per deletion, with the exact removed lines. */
export const DELETED_MESSAGES_FILE = `${PRINCIPAL_CONVERSATIONS_DIR}/_editors/supprimes.jsonl`;

/**
 * Deletion (× button): removes this message and its own separator block (`---`, source marker)
 * from its file, with the same per-message revision check as the inline edit. Its source id stays
 * in `_imports.json`, so a wake never re-imports it; the removed lines are kept in
 * `_editors/supprimes.jsonl` for undo.
 */
export function deletePrincipalMessage(workspace: string, request: { source?: unknown; id?: unknown; revision?: unknown }) {
  if (typeof request.source !== "string" || typeof request.id !== "string") throw Error("Message manquant.");
  const { file, turn, lines, eol } = locate(workspace, request, "Ce message n'existe plus dans son fichier.",
    "Ce message a changé depuis son affichage : rien n'a été supprimé. Relis-le avant de le supprimer.");
  const from = turn.lead - 1;
  const removed = lines.slice(from, turn.end);
  const rest = [...lines.slice(0, from), ...lines.slice(turn.end)];
  // Do not leave two blank lines where the message was.
  if (from > 0 && !rest[from - 1]?.trim() && from < rest.length && !rest[from]?.trim()) rest.splice(from, 1);
  const at = new Date().toISOString();
  const trail = path.join(workspace, DELETED_MESSAGES_FILE);
  fs.mkdirSync(path.dirname(trail), { recursive: true });
  if (fs.lstatSync(path.dirname(trail)).isSymbolicLink()) throw Error("Dossier de conversation lié refusé.");
  fs.appendFileSync(trail, JSON.stringify({ at, source: request.source, id: turn.id, speaker: turn.speaker, line: turn.lead,
    text: turn.text, removed: removed.join("\n") }) + "\n");
  if (turn.historicId) {
    const imports = path.join(workspace, PRINCIPAL_CONVERSATIONS_DIR, "_imports.json");
    const ids: unknown = fs.existsSync(imports) ? JSON.parse(fs.readFileSync(imports, "utf8")) : [];
    if (Array.isArray(ids) && !ids.includes(turn.historicId)) fs.writeFileSync(imports, JSON.stringify([...ids, turn.historicId]) + "\n");
  }
  fs.writeFileSync(file, rest.join(eol));
  recordPrincipalEditor(workspace, file, HUMAN_EDITOR);
  return { id: turn.id, source: request.source, deleted: true };
}

/** Speaker written by the 🎤 button (NLR, 20 nov. 19:23 : « Humain : <son message> »). */
export const DICTATION_SPEAKER = "Humain";
const heading = (text: string): number => /^(#{1,6})\s/.exec(text)?.[1]?.length ?? 0;

/**
 * 🎤 button: adds `Humain : <texte>` at the end of an element. For a message, right after it; for
 * a section title (`##`, `###`), after the last line of that section (before the next title of the
 * same or a higher level). Same revision check as the inline edit, on the element itself.
 * Returns the new message's id and revision, so the next dictated segment extends it in place.
 */
export function appendToPrincipalElement(workspace: string, request: { source?: unknown; id?: unknown; revision?: unknown; text?: unknown }) {
  if (typeof request.text !== "string" || !request.text.trim() || request.text.length > 8_000) throw Error("Transcription vide ou trop longue.");
  const { file, turns, turn, lines, eol } = locate(workspace, request, "Cet élément n'existe plus dans son fichier. La transcription n'a pas été ajoutée.",
    "Cet élément a changé depuis son affichage. La transcription n'a pas été ajoutée.");
  let end = turn.end;
  const level = turn.editorial ? heading(turn.text) : 0;
  if (level) {
    for (const next of turns.slice(turns.indexOf(turn) + 1)) {
      const nextLevel = next.editorial ? heading(next.text) : 0;
      if (nextLevel && nextLevel <= level) break;
      end = next.end;
    }
  }
  const spoken = request.text.replace(/\s*\r?\n\s*/g, " ").trim();
  const inserted = ["", `${DICTATION_SPEAKER} : ${spoken}`];
  // Keep one blank line before whatever followed the element.
  if (end < lines.length && lines[end]?.trim()) inserted.push("");
  const text = [...lines.slice(0, end), ...inserted, ...lines.slice(end)].join(eol);
  if (text.length > 240_000) throw Error("Contenu de conversation invalide.");
  fs.writeFileSync(file, text);
  recordPrincipalEditor(workspace, file, HUMAN_EDITOR);
  const added = principalFileTurns(path.basename(file), text, speakerNames(workspace)).find(t => t.line === end + 2);
  return { id: added?.id ?? null, source: request.source, text: added?.text ?? spoken, revision: added?.revision ?? null };
}
