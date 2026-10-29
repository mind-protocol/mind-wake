/**
 * Index des sessions autorisées, tenu en cache (`session-index.json` dans l'état de
 * l'aide) et rafraîchi de façon incrémentale et asynchrone : seules les transcriptions
 * nouvelles ou modifiées depuis le dernier passage sont relues, en parallèle. Un message
 * de l'agent est donc apparié tout de suite, sur l'index déjà prêt.
 *
 * Opt-in strict : côté Claude Code, le nom du dossier de projet encode le chemin
 * (`C--Users-reyno-projet`), seuls les projets sous une racine autorisée sont ouverts ;
 * côté Codex, seule la première ligne (métadonnées, dont le dossier) est lue avant de
 * décider. Le cache ne garde que les fréquences de termes, pas le texte.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { termFrequencies } from "./keywords.js";
import { isUnder, parseClaude, parseCodex, type Runtime } from "./sessions.js";

export const INDEX_FILE = "session-index.json";
const MAX_BYTES = 2_000_000;
const MAX_TERMS = 400;
const CONCURRENCY = 16;

export interface IndexedSession {
  readonly runtime: Runtime;
  readonly sessionId: string;
  readonly cwd: string;
  readonly file: string;
  readonly updatedAt: string;
  readonly mtimeMs: number;
  readonly terms: Readonly<Record<string, number>>;
}

interface IndexFile {
  readonly version: 1;
  readonly roots: readonly string[];
  readonly entries: Readonly<
    Record<string, IndexedSession | { readonly mtimeMs: number; readonly skip: true }>
  >;
}

export interface IndexOptions {
  readonly roots: readonly string[];
  readonly excluded: readonly string[];
  readonly claudeDir?: string;
  readonly codexDir?: string;
  readonly maxAgeDays?: number;
  readonly now?: number;
}

/** Encodage du chemin dans le nom des dossiers de projet de Claude Code. */
export function claudeProjectName(dir: string): string {
  return path.resolve(dir).replace(/[^A-Za-z0-9]/g, "-");
}

function topTerms(text: string): Record<string, number> {
  return Object.fromEntries(
    [...termFrequencies(text).entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TERMS),
  );
}

async function readTail(file: string, size: number): Promise<string> {
  const handle = await fsp.open(file, "r");
  try {
    const start = Math.max(0, size - MAX_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally {
    await handle.close();
  }
}

async function readFirstLine(file: string): Promise<string> {
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(64_000);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
  } finally {
    await handle.close();
  }
}

async function listJsonl(dir: string, depth: number): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map(async (e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0) return listJsonl(full, depth - 1);
      return e.isFile() && e.name.endsWith(".jsonl") ? [full] : [];
    }),
  );
  return nested.flat();
}

async function pool<T>(items: readonly T[], worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        if (item !== undefined) await worker(item);
      }
    }),
  );
}

export function loadIndex(stateDir: string): IndexFile {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, INDEX_FILE), "utf8"),
    ) as Partial<IndexFile>;
    if (raw.version === 1 && typeof raw.entries === "object" && Array.isArray(raw.roots)) {
      return { version: 1, roots: raw.roots, entries: raw.entries };
    }
  } catch {
    // Cache absent ou illisible : reconstruit.
  }
  return { version: 1, roots: [], entries: {} };
}

/** Sessions indexées utilisables pour un appariement (racines et exclusions appliquées). */
export function indexedSessions(index: IndexFile, options: IndexOptions): IndexedSession[] {
  const now = options.now ?? Date.now();
  const maxAge = (options.maxAgeDays ?? 60) * 86_400_000;
  return Object.values(index.entries).filter(
    (e): e is IndexedSession =>
      !("skip" in e) &&
      now - e.mtimeMs <= maxAge &&
      options.roots.some((r) => isUnder(e.cwd, r)) &&
      !options.excluded.some((r) => isUnder(e.cwd, r)),
  );
}

/** Met l'index à jour (fichiers nouveaux ou modifiés seulement) et le sauvegarde. */
export async function refreshIndex(
  stateDir: string,
  options: IndexOptions,
): Promise<{ sessions: IndexedSession[]; reread: number }> {
  const previous = loadIndex(stateDir);
  const sameRoots =
    JSON.stringify([...previous.roots].sort()) === JSON.stringify([...options.roots].sort());
  const old = sameRoots ? previous.entries : {};
  const entries: Record<string, IndexFile["entries"][string]> = {};
  const now = options.now ?? Date.now();
  const maxAge = (options.maxAgeDays ?? 60) * 86_400_000;
  const claudeDir = options.claudeDir ?? path.join(os.homedir(), ".claude", "projects");
  const codexDir = options.codexDir ?? path.join(os.homedir(), ".codex", "sessions");

  const prefixes = options.roots.map(claudeProjectName);
  let projects: string[];
  try {
    projects = (await fsp.readdir(claudeDir)).filter((name) =>
      prefixes.some((p) => name === p || name.startsWith(`${p}-`)),
    );
  } catch {
    projects = [];
  }
  const claudeFiles = (
    await Promise.all(projects.map((p) => listJsonl(path.join(claudeDir, p), 0)))
  ).flat();
  const codexFiles = options.roots.length === 0 ? [] : await listJsonl(codexDir, 3);

  let reread = 0;
  const tasks = [
    ...claudeFiles.map((file) => ({ runtime: "claude" as const, file })),
    ...codexFiles.map((file) => ({ runtime: "codex" as const, file })),
  ];
  await pool(tasks, async ({ runtime, file }) => {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(file);
    } catch {
      return;
    }
    if (now - stat.mtimeMs > maxAge) return;
    const cached = old[file];
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) {
      entries[file] = cached;
      return;
    }
    try {
      if (runtime === "codex") {
        // Dossier lu dans les seules métadonnées avant toute lecture de la conversation.
        const meta = JSON.parse(await readFirstLine(file)) as { payload?: { cwd?: unknown } };
        const cwd = typeof meta.payload?.cwd === "string" ? meta.payload.cwd : null;
        if (
          cwd === null ||
          !options.roots.some((r) => isUnder(cwd, r)) ||
          options.excluded.some((r) => isUnder(cwd, r))
        ) {
          entries[file] = { mtimeMs: stat.mtimeMs, skip: true };
          return;
        }
      }
      reread += 1;
      const raw = await readTail(file, stat.size);
      const doc = runtime === "claude" ? parseClaude(file, raw) : parseCodex(file, raw);
      entries[file] =
        doc === null
          ? { mtimeMs: stat.mtimeMs, skip: true }
          : {
              runtime,
              sessionId: doc.sessionId,
              cwd: doc.cwd,
              file,
              updatedAt: new Date(stat.mtimeMs).toISOString(),
              mtimeMs: stat.mtimeMs,
              terms: topTerms(doc.text),
            };
    } catch {
      entries[file] = { mtimeMs: stat.mtimeMs, skip: true };
    }
  });

  const index: IndexFile = { version: 1, roots: [...options.roots], entries };
  const target = path.join(stateDir, INDEX_FILE);
  await fsp.writeFile(`${target}.tmp`, JSON.stringify(index));
  await fsp.rename(`${target}.tmp`, target);
  return { sessions: indexedSessions(index, options), reread };
}
