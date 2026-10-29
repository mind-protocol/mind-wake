/**
 * Sessions Claude Code et Codex de l'humain, lues seulement dans les dossiers qu'il a
 * autorisés (opt-in, `helpers.json`). Lecture des fichiers de transcription locaux, en
 * fin de fichier et bornée ; seuls les textes des tours humain / assistant sont gardés.
 * Les sessions de l'agent Wake lui-même sont toujours exclues.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Runtime = "claude" | "codex";

export interface SessionDoc {
  readonly runtime: Runtime;
  readonly sessionId: string;
  readonly cwd: string;
  readonly file: string;
  readonly updatedAt: string;
  readonly text: string;
}

/** Fin de fichier lue au plus (les conversations récentes portent le contexte utile). */
const MAX_BYTES = 2_000_000;
/** Texte gardé par session pour l'index. */
const MAX_TEXT = 200_000;

export function normalizeDir(dir: string): string {
  return path
    .resolve(dir)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

export function isUnder(dir: string, root: string): boolean {
  const d = normalizeDir(dir);
  const r = normalizeDir(root);
  return d === r || d.startsWith(`${r}${path.sep}`) || d.startsWith(`${r}/`);
}

function readTail(file: string): string {
  const stats = fs.statSync(file);
  const fd = fs.openSync(file, "r");
  try {
    const start = Math.max(0, stats.size - MAX_BYTES);
    const buffer = Buffer.alloc(stats.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    // Première ligne possiblement tronquée : écartée si on n'a pas lu depuis le début.
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally {
    fs.closeSync(fd);
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      const p = part as { type?: unknown; text?: unknown };
      return (p.type === "text" || p.type === "input_text" || p.type === "output_text") &&
        typeof p.text === "string"
        ? p.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Une transcription Claude Code (`~/.claude/projects/<dossier>/<id>.jsonl`). */
export function parseClaude(file: string, raw: string): Omit<SessionDoc, "updatedAt"> | null {
  let cwd: string | null = null;
  let sessionId: string | null = null;
  const parts: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof o["cwd"] === "string") cwd = o["cwd"];
    if (typeof o["sessionId"] === "string") sessionId = o["sessionId"];
    if ((o["type"] !== "user" && o["type"] !== "assistant") || o["isMeta"] === true) continue;
    if (o["isSidechain"] === true) continue;
    const message = o["message"] as { content?: unknown } | undefined;
    const text = contentText(message?.content);
    if (text !== "") parts.push(text);
  }
  if (cwd === null || sessionId === null || parts.length === 0) return null;
  return { runtime: "claude", sessionId, cwd, file, text: parts.join("\n").slice(-MAX_TEXT) };
}

/** Une transcription Codex (`~/.codex/sessions/AAAA/MM/JJ/rollout-*.jsonl`). */
export function parseCodex(file: string, raw: string): Omit<SessionDoc, "updatedAt"> | null {
  let cwd: string | null = null;
  let sessionId: string | null = null;
  const parts: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let o: { type?: unknown; payload?: Record<string, unknown> };
    try {
      o = JSON.parse(line) as typeof o;
    } catch {
      continue;
    }
    const p = o.payload ?? {};
    if (o.type === "session_meta") {
      if (typeof p["cwd"] === "string") cwd = p["cwd"];
      if (typeof p["id"] === "string") sessionId = p["id"];
      continue;
    }
    if (o.type === "turn_context" && typeof p["cwd"] === "string") cwd ??= p["cwd"];
    if (o.type !== "response_item" || p["type"] !== "message") continue;
    if (p["role"] !== "user" && p["role"] !== "assistant") continue;
    const text = contentText(p["content"]);
    // Les instructions injectées par l'outil ne sont pas la conversation.
    if (
      text !== "" &&
      !text.startsWith("<environment_context>") &&
      !text.startsWith("# AGENTS.md")
    ) {
      parts.push(text);
    }
  }
  if (cwd === null || sessionId === null || parts.length === 0) return null;
  return { runtime: "codex", sessionId, cwd, file, text: parts.join("\n").slice(-MAX_TEXT) };
}

function walk(dir: string, depth: number, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(full, depth - 1, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
}

export interface DiscoverOptions {
  readonly roots: readonly string[];
  /** Dossiers jamais lus (données et espace de l'agent Wake). */
  readonly excluded: readonly string[];
  readonly claudeDir?: string;
  readonly codexDir?: string;
  /** Sessions plus anciennes ignorées. */
  readonly maxAgeDays?: number;
  readonly now?: number;
}

/**
 * Sessions dont le dossier de travail est sous une racine autorisée et hors des dossiers
 * exclus. Sans racine autorisée, rien n'est lu.
 */
export function discoverSessions(options: DiscoverOptions): SessionDoc[] {
  if (options.roots.length === 0) return [];
  const claudeDir = options.claudeDir ?? path.join(os.homedir(), ".claude", "projects");
  const codexDir = options.codexDir ?? path.join(os.homedir(), ".codex", "sessions");
  const now = options.now ?? Date.now();
  const maxAge = (options.maxAgeDays ?? 60) * 86_400_000;
  const files: { runtime: Runtime; file: string }[] = [];
  const claudeFiles: string[] = [];
  walk(claudeDir, 1, claudeFiles);
  const codexFiles: string[] = [];
  walk(codexDir, 3, codexFiles);
  files.push(...claudeFiles.map((file) => ({ runtime: "claude" as const, file })));
  files.push(...codexFiles.map((file) => ({ runtime: "codex" as const, file })));

  const docs: SessionDoc[] = [];
  for (const { runtime, file } of files) {
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtime > maxAge) continue;
    let raw: string;
    try {
      raw = readTail(file);
    } catch {
      continue;
    }
    const doc = runtime === "claude" ? parseClaude(file, raw) : parseCodex(file, raw);
    if (doc === null) continue;
    if (!options.roots.some((root) => isUnder(doc.cwd, root))) continue;
    if (options.excluded.some((root) => isUnder(doc.cwd, root))) continue;
    docs.push({ ...doc, updatedAt: new Date(mtime).toISOString() });
  }
  return docs;
}
