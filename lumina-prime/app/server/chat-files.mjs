import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Lecture des fichiers partagés par les agents dans le Chat (« [fichier: C:\...\X.md] ») :
 * uniquement .md et .pdf, uniquement sous la racine du workspace (chemin réel, liens résolus),
 * jamais un fichier qui ressemble à un secret, 10 Mo au plus.
 */
export class FileAccessError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export const FILE_MAX_BYTES = 10 * 1024 * 1024;
const TYPES = { '.md': 'text/markdown; charset=utf-8', '.pdf': 'application/pdf' };

/** Noms qui ressemblent à des secrets : refusés même sous la racine. */
export function looksSecret(filePath) {
  const parts = filePath.split(/[\\/]+/).map(part => part.toLowerCase());
  const name = parts.at(-1) ?? '';
  if (parts.some(part => ['secrets', 'secret', 'credentials', '.ssh', '.git'].includes(part))) return true;
  return /^\.env(\..*)?$/.test(name) || /\.session(\.|$)/.test(name) || /\.(key|pem|p12|pfx)$/.test(name) || name === 'keys.json'
    || /^telegram.*\.json$/.test(name) || name === 'reddit.json' || /^colony.*\.json$/.test(name)
    || /(^|[._-])(secret|token|password|private)([._-]|$)/.test(name);
}

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/** Chemin demandé → fichier lisible ; toute sortie des racines ou type non prévu est refusé.
 *  `roots` : une racine ou plusieurs (workspace actif d'abord). Un chemin relatif (« artifacts/x.md ») est cherché
 *  sous chaque racine dans l'ordre ; un chemin absolu doit être sous l'une d'elles. Aucun segment « .. » accepté. */
export async function resolveSharedFile(roots, requested) {
  if (typeof requested !== 'string' || !requested.trim() || requested.length > 1024 || requested.includes('\0'))
    throw new FileAccessError('file_invalid');
  const value = requested.trim();
  const list = (Array.isArray(roots) ? roots : [roots]).filter(root => typeof root === 'string' && root);
  if (!list.length) throw new FileAccessError('file_unavailable', 503);
  const absolute = path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
  if (!absolute && (/^[A-Za-z]:/.test(value) || /^[a-z][\w+.-]*:/i.test(value))) throw new FileAccessError('file_invalid');
  const extension = path.extname(value).toLowerCase();
  if (!TYPES[extension]) throw new FileAccessError('file_type_unsupported', 415);
  if (value.split(/[\\/]+/).includes('..')) throw new FileAccessError('file_forbidden', 403);
  let lastError = new FileAccessError('file_forbidden', 403);
  for (const root of list) {
    try { return await resolveUnder(root, absolute ? value : path.join(root, value)); }
    catch (error) {
      if (!(error instanceof FileAccessError)) throw error;
      // Relatif : racine suivante si absent ici ; absolu : racine suivante si hors de celle-ci.
      if (error.code === 'file_not_found' || (error.code === 'file_forbidden' && error.outside)) { if (error.code === 'file_not_found' || lastError.code !== 'file_not_found') lastError = error; continue; }
      throw error;
    }
  }
  throw lastError;
}

async function resolveUnder(root, value) {
  let realRoot; let real;
  try { realRoot = await fs.realpath(root); } catch { const error = new FileAccessError('file_forbidden', 403); error.outside = true; throw error; }
  const lexical = path.resolve(value);
  if (!inside(realRoot, lexical) && !inside(path.resolve(root), lexical)) { const error = new FileAccessError('file_forbidden', 403); error.outside = true; throw error; }
  if (looksSecret(lexical)) throw new FileAccessError('file_forbidden', 403);
  try { real = await fs.realpath(lexical); } catch { throw new FileAccessError('file_not_found', 404); }
  // Le chemin réel (jonctions, liens) doit lui aussi rester sous la racine réelle.
  if (!inside(realRoot, real) || looksSecret(real) || !TYPES[path.extname(real).toLowerCase()]) throw new FileAccessError('file_forbidden', 403);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new FileAccessError('file_not_found', 404);
  if (stat.size > FILE_MAX_BYTES) throw new FileAccessError('file_too_large', 413);
  return { path: real, name: path.basename(real), mime: TYPES[path.extname(real).toLowerCase()], size: stat.size };
}

export function createFileReader({ root, roots }) {
  const list = [...(roots ?? []), ...(root ? [root] : [])].filter(Boolean);
  if (!list.length) throw new Error('Workspace root required');
  return async requested => {
    const file = await resolveSharedFile(list, requested);
    const bytes = await fs.readFile(file.path);
    if (bytes.length > FILE_MAX_BYTES) throw new FileAccessError('file_too_large', 413);
    return { ...file, bytes };
  };
}

/** Racines servies : le workspace actif de Wake (workspace-settings.json, sinon dataDir/workspace), puis le dépôt
 *  Wake où travaille l'agent principal (docs/, output/…). Les mêmes refus s'appliquent partout. */
export function sharedFileRoots({ dataDir, wakeRoot }) {
  let active = path.join(dataDir, 'workspace');
  try {
    const settings = JSON.parse(readFileSync(path.join(dataDir, 'workspace-settings.json'), 'utf8'));
    if (typeof settings?.activeWorkspace === 'string' && path.isAbsolute(settings.activeWorkspace)) active = settings.activeWorkspace;
  } catch { /* pas de réglage : dossier par défaut */ }
  return [...new Set([active, ...(wakeRoot ? [path.resolve(wakeRoot)] : [])])];
}
