import fs from "node:fs";
import path from "node:path";
import type { NativeHistoryMessage } from "./native-history.js";

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();
/** `line`/`end`: 1-based first and last source lines; `head`: speaker marker kept verbatim on edit. */
export interface MarkdownTurn { speaker: string | null; text: string; line: number; end: number; head: string }

/** Only explicit line-leading speaker markers. Fenced code and quotations are never speakers. */
export function parseMarkdownConversation(markdown: string, knownSpeakers: readonly string[] = []): MarkdownTurn[] {
  const turns: MarkdownTurn[] = [];
  let speaker: string | null = null, start = 1, head = "", body: string[] = [], fence: string | null = null;
  const flush = () => {
    const text = body.join("\n").trim();
    let last = body.length - 1;
    while (last > 0 && !body[last]?.trim()) last--;
    if (text) turns.push({ speaker, text, line: start, end: start + last, head });
    body = []; head = "";
  };
  const known = new Set(knownSpeakers.map(fold));
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    const fenced = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenced) {
      if (!fence) fence = fenced;
      else if (fenced[0] === fence[0] && fenced.length >= fence.length) fence = null;
      body.push(line); continue;
    }
    if (fence) { body.push(line); continue; }
    // **Marco** : text, **Marco :** text, **Marco —** text, Marco — text.
    const marker = /^\s{0,3}\*\*([^*\n]{1,80}?)\*\*\s*[:：—–]\s*(.*)$/.exec(line)
      ?? /^\s{0,3}\*\*([^*\n]{1,80}?)\s*[:：—–]\*\*\s*(.*)$/.exec(line)
      ?? /^\s{0,3}([\p{L}\p{N}][\p{L}\p{N} ._'’@()-]{0,79}?)\s+[—–]\s+(.*)$/u.exec(line);
    const plain = !marker ? /^\s{0,3}([^:\n]{1,80}):\s*(.*)$/.exec(line) : null;
    const match = marker ?? (plain && known.has(fold(plain[1] ?? "")) ? plain : null);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      flush(); speaker = match[1].trim(); start = index + 1; head = line.slice(0, line.length - match[2].length); body.push(match[2]);
    } else if (/^\s{0,3}(?:#{1,6}\s|---\s*$)/.test(line)) {
      flush(); speaker = null; start = index + 1; body.push(line);
    } else body.push(line);
  }
  flush(); return turns;
}

export function markdownNativeHistory(markdown: string, source: string, self: readonly string[]): NativeHistoryMessage[] {
  const own = new Set(self.map(fold));
  return parseMarkdownConversation(markdown, [...self, "NLR", "Humain", "Coach", "Marco", "Codex", "Agent Wake"]).map((turn, index) => ({
    id: `${source}:${String(turn.line)}:${String(index)}`, at: "conversation Markdown",
    author: turn.speaker ?? "Contexte éditorial (sans locuteur)",
    role: turn.speaker && own.has(fold(turn.speaker)) ? "assistant" : "user",
    text: turn.text,
  }));
}

export const PRINCIPAL_CONVERSATIONS_DIR = "artifacts/principal";
/** Hard limit of the principal's Markdown corpus loaded at each wake. */
export const PRINCIPAL_CORPUS_MAX_CHARS = 240_000;
export function principalSpeakerNames(workspace: string): string[] {
  const directory = path.join(workspace, PRINCIPAL_CONVERSATIONS_DIR);
  let self = ["Marco", "Principal", "Agent Wake"];
  const identity = path.join(directory, "_principal.md");
  if (fs.existsSync(identity)) {
    if (!fs.lstatSync(identity).isFile() || fs.lstatSync(identity).isSymbolicLink()) throw Error("Invalid principal identity file");
    const match = /```json\s+principal\s*\n([\s\S]*?)```/.exec(fs.readFileSync(identity, "utf8"));
    if (match?.[1] !== undefined) {
      const meta = JSON.parse(match[1]) as { name?: unknown; aliases?: unknown };
      if (typeof meta.name !== "string" || !meta.name.trim() ||
          (meta.aliases !== undefined && (!Array.isArray(meta.aliases) || !meta.aliases.every(a => typeof a === "string" && a.trim())))) throw Error("Invalid principal speaker names");
      self = [meta.name, ...((meta.aliases ?? []) as string[])];
    }
  }
  return self;
}

/**
 * `overflow: "partial"` (the principal's wake): above the limit, load the first file (index)
 * and the end of the last one (the fil), and name what is missing, instead of failing.
 */
export function principalSeedHistory(workspace: string, overflow: "throw" | "partial" = "throw"): NativeHistoryMessage[] {
  const directory = path.join(workspace, PRINCIPAL_CONVERSATIONS_DIR);
  if (!fs.existsSync(directory)) return [];
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw Error("Invalid principal conversation directory");
  const names = fs.readdirSync(directory).filter(n => n.endsWith(".md") && !n.startsWith("_")).sort();
  const self = principalSpeakerNames(workspace);
  const files: { file: string; text: string }[] = [];
  let size = 0;
  for (const file of names) {
    const full = path.join(directory, file), stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const text = fs.readFileSync(full, "utf8");
    size += text.length;
    if (size > PRINCIPAL_CORPUS_MAX_CHARS && overflow === "throw") throw Error("Principal Markdown conversations exceed 240000 characters; curate the corpus.");
    files.push({ file, text });
  }
  if (size > PRINCIPAL_CORPUS_MAX_CHARS) return partialPrincipalHistory(files, size, self);
  return files.flatMap(({ file, text }) => markdownNativeHistory(text, `${PRINCIPAL_CONVERSATIONS_DIR}/${file}`, self));
}

const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

function partialPrincipalHistory(files: readonly { file: string; text: string }[], size: number, self: readonly string[]): NativeHistoryMessage[] {
  const source = (file: string) => `${PRINCIPAL_CONVERSATIONS_DIR}/${file}`;
  const first = files[0], last = files.at(-1);
  if (!first || !last) return [];
  const index = files.length > 1 ? first.text.slice(0, Math.floor(PRINCIPAL_CORPUS_MAX_CHARS / 3)) : "";
  let tail = last.text.slice(-(PRINCIPAL_CORPUS_MAX_CHARS - index.length));
  if (tail.length < last.text.length) {
    // Start the excerpt on a turn boundary rather than in the middle of a message.
    const boundary = /\n(?:---[ \t]*\r?\n|\*\*[^*\n]{1,80}(?:\*\*\s*[:：—–]|\s*[:：—–]\*\*))/.exec(tail);
    if (boundary) tail = tail.slice(boundary.index + 1);
  }
  const loaded = [
    ...(files.length > 1 ? [`${first.file} ${index.length < first.text.length ? `(début, ${thousands(index.length)} sur ${thousands(first.text.length)} caractères)` : "(entier)"}`] : []),
    `${last.file} (fin, ${thousands(tail.length)} sur ${thousands(last.text.length)} caractères)`,
  ];
  const missing = [
    ...(files.length > 1 && index.length < first.text.length ? [`suite de ${first.file}`] : []),
    ...files.slice(1, -1).map(f => f.file),
    ...(tail.length < last.text.length ? [`début de ${last.file}`] : []),
  ];
  const notice: NativeHistoryMessage = {
    id: `${PRINCIPAL_CONVERSATIONS_DIR}:chargement-partiel`, at: "conversation Markdown", role: "user",
    author: "Contexte éditorial (sans locuteur)",
    text: `Chargement partiel : le corpus fait ${thousands(size)} caractères, au-delà de la limite de ${thousands(PRINCIPAL_CORPUS_MAX_CHARS)}. Chargé : ${loaded.join(" ; ")}. Non chargé : ${missing.join(" ; ") || "rien"}. Resserre le corpus pour repasser sous la limite ; les fichiers manquants restent lisibles dans ${PRINCIPAL_CONVERSATIONS_DIR}.`,
  };
  return [
    notice,
    ...(index ? markdownNativeHistory(index, source(first.file), self) : []),
    ...markdownNativeHistory(tail, `${source(last.file)}#fin`, self),
  ];
}
