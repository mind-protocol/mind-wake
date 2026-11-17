import { promises as fs } from 'node:fs';
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
  return /^\.env(\..*)?$/.test(name) || /\.(key|pem|p12|pfx)$/.test(name) || name === 'keys.json'
    || /^telegram.*\.json$/.test(name) || name === 'reddit.json' || /^colony.*\.json$/.test(name)
    || /(^|[._-])(secret|token|password|private)([._-]|$)/.test(name);
}

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/** Chemin demandé → fichier lisible ; toute sortie de la racine ou type non prévu est refusé. */
export async function resolveSharedFile(root, requested) {
  if (typeof requested !== 'string' || !requested.trim() || requested.length > 1024 || requested.includes('\0'))
    throw new FileAccessError('file_invalid');
  const value = requested.trim();
  if (!path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)) throw new FileAccessError('file_invalid');
  const extension = path.extname(value).toLowerCase();
  if (!TYPES[extension]) throw new FileAccessError('file_type_unsupported', 415);
  let realRoot; let real;
  try { realRoot = await fs.realpath(root); } catch { throw new FileAccessError('file_unavailable', 503); }
  const lexical = path.resolve(value);
  if (!inside(realRoot, lexical) && !inside(path.resolve(root), lexical)) throw new FileAccessError('file_forbidden', 403);
  if (looksSecret(lexical)) throw new FileAccessError('file_forbidden', 403);
  try { real = await fs.realpath(lexical); } catch { throw new FileAccessError('file_not_found', 404); }
  // Le chemin réel (jonctions, liens) doit lui aussi rester sous la racine réelle.
  if (!inside(realRoot, real) || looksSecret(real) || !TYPES[path.extname(real).toLowerCase()]) throw new FileAccessError('file_forbidden', 403);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new FileAccessError('file_not_found', 404);
  if (stat.size > FILE_MAX_BYTES) throw new FileAccessError('file_too_large', 413);
  return { path: real, name: path.basename(real), mime: TYPES[path.extname(real).toLowerCase()], size: stat.size };
}

export function createFileReader({ root }) {
  if (!root) throw new Error('Workspace root required');
  return async requested => {
    const file = await resolveSharedFile(root, requested);
    const bytes = await fs.readFile(file.path);
    if (bytes.length > FILE_MAX_BYTES) throw new FileAccessError('file_too_large', 413);
    return { ...file, bytes };
  };
}
