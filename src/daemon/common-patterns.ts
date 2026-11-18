/**
 * Patterns communs à tous les agents (NLR, 18 nov. 2026 18:00) : sections de
 * `<workspace>/artifacts/pattern-holders/_commun/`, ajoutées au prompt système de chaque agent
 * (agents de room, rooms à un agent, pattern holders), relues à chaque tour.
 */
import fs from "node:fs";
import path from "node:path";

export const PROMPT_CHARS = 200_000;
/** Dossier des pattern holders, relatif à l'espace. */
export const HOLDERS_DIR = path.join("artifacts", "pattern-holders");
/** Dossier des patterns communs, dans celui des holders. */
export const COMMON_PATTERNS_DIR = "_commun";
export const COMMON_PATTERNS_TITLE = "Patterns communs à tous les agents (NLR) :";
/** Sous-dossiers d'un dossier de holder qui ne sont pas des sections du prompt. */
const SKIPPED_DIRS = new Set(["sources"]);
/** Séparateur entre deux sections d'un prompt en dossier (même que les pattern holders). */
export const SECTION_SEPARATOR = "\n\n---\n\n";

/** Sections `.md` d'un dossier : `_holder.md` d'abord, puis les autres, puis les sous-dossiers. */
export function sectionFiles(dir: string, depth = 0): string[] {
  const names = fs.readdirSync(dir).sort();
  const files: string[] = [];
  const dirs: string[] = [];
  for (const n of names) {
    if (n.startsWith(".")) continue;
    const full = path.join(dir, n);
    const s = fs.lstatSync(full);
    if (s.isSymbolicLink()) continue;
    if (s.isFile() && n.endsWith(".md")) files.push(n);
    else if (s.isDirectory() && depth < 3 && !SKIPPED_DIRS.has(n) && !n.startsWith("_")) dirs.push(full);
  }
  files.sort((a, b) => (a === "_holder.md" ? -1 : b === "_holder.md" ? 1 : a < b ? -1 : a > b ? 1 : 0));
  return [...files.map((n) => path.join(dir, n)), ...dirs.flatMap((d) => sectionFiles(d, depth + 1))];
}

/**
 * Bloc des patterns communs pour un dossier de holders (`<workspace>/artifacts/pattern-holders`) :
 * titre puis sections de `_commun/`. Chaîne vide si le dossier est absent, illisible ou sans texte.
 */
export function commonPatternsBlock(holdersDir: string): string {
  const dir = path.join(holdersDir, COMMON_PATTERNS_DIR);
  let text: string;
  try {
    const s = fs.lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink()) return "";
    text = sectionFiles(dir)
      .map((f) => fs.readFileSync(f, "utf8").trim())
      .filter((t) => t !== "")
      .join(SECTION_SEPARATOR);
  } catch {
    return "";
  }
  if (text === "") return "";
  const bounded = text.length > PROMPT_CHARS ? `${text.slice(0, PROMPT_CHARS)}\n\n[… patterns communs tronqués par le runtime]` : text;
  return `${COMMON_PATTERNS_TITLE}\n\n${bounded}`;
}

/**
 * Dossier des holders de l'espace Wake : l'espace d'une room peut être un sous-dossier de projet
 * (`artifacts/projets/<id>`), donc on remonte jusqu'au dossier qui contient `artifacts/pattern-holders`.
 */
export function findHoldersDir(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, HOLDERS_DIR);
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // on remonte
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.join(path.resolve(start), HOLDERS_DIR);
    dir = parent;
  }
}

/** Bloc des patterns communs d'un espace de travail (ou d'un de ses sous-dossiers). */
export function workspaceCommonPatterns(workspace: string): string {
  return commonPatternsBlock(findHoldersDir(workspace));
}
