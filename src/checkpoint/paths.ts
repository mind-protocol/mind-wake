/**
 * Confinement des chemins d'artefacts (AGENTS §5, SPEC §9).
 *
 * Deux contrôles successifs :
 * - lexical, sur le texte proposé par l'agent : jamais absolu, jamais `..`, aucune
 *   forme Windows ambiguë (lecteur, UNC, flux alternatif `:`, nom de périphérique,
 *   point ou espace final) ;
 * - au moment de l'accès, sur le disque : aucun composant ne peut être un lien
 *   symbolique ou une jonction, le chemin réel reste sous la racine réelle et un
 *   fichier à plusieurs liens physiques (hardlink) est refusé.
 *
 * Ces vérifications sont applicatives : elles réduisent la fenêtre d'attaque mais ne
 * remplacent pas l'isolation système (AppContainer, ADR-003). Entre la vérification et
 * l'ouverture, un processus concurrent qui écrit dans l'espace peut encore substituer
 * un composant ; `openConfined` recontrôle l'identité du fichier ouvert pour fermer
 * l'essentiel de cette fenêtre, sans prétendre l'annuler.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, join, relative, sep, win32 } from "node:path";
import type { ConfinedRelativePath } from "../contracts/index.js";

/** Préfixe réservé aux fichiers temporaires d'écriture atomique ; interdit à l'agent. */
export const TEMP_PREFIX = ".mw-tmp-";

export const MAX_PATH_LENGTH = 240;
export const MAX_PATH_SEGMENTS = 16;
const MAX_SEGMENT_LENGTH = 120;

/** Noms de périphériques Windows, avec ou sans extension (`NUL.txt` est `NUL`). */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
// eslint-disable-next-line no-control-regex -- les caractères de contrôle sont précisément refusés
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f<>:"|?*\\]/;

export type PathRejection = "path_escape" | "malformed";

export type LexicalPathResult =
  | { readonly ok: true; readonly path: ConfinedRelativePath }
  | { readonly ok: false; readonly reason: PathRejection; readonly detail: string };

function reject(reason: PathRejection, detail: string): LexicalPathResult {
  return { ok: false, reason, detail };
}

/**
 * Contrôle lexical d'un chemin relatif proposé. La seule forme acceptée est canonique :
 * segments séparés par `/`, sans segment vide, `.` ni `..`. Un chemin non canonique
 * est refusé plutôt que normalisé, pour qu'un même fichier n'ait qu'une écriture.
 */
export function checkRelativePath(input: unknown): LexicalPathResult {
  if (typeof input !== "string" || input.length === 0) {
    return reject("malformed", "chemin vide ou non textuel");
  }
  if (input.length > MAX_PATH_LENGTH) return reject("malformed", "chemin trop long");
  if (
    isAbsolute(input) ||
    win32.isAbsolute(input) ||
    /^[A-Za-z]:/.test(input) ||
    input.startsWith("\\\\") ||
    input.startsWith("//")
  ) {
    return reject("path_escape", "chemin absolu, UNC ou relatif à un lecteur");
  }
  // Séparateur Windows : refusé comme sortie possible s'il introduit `..`, comme forme
  // non canonique sinon.
  if (input.includes("\\")) {
    return input.split(/[\\/]/).includes("..")
      ? reject("path_escape", "remontée `..`")
      : reject("malformed", "séparateur `\\` non canonique : utiliser `/`");
  }
  const segments = input.split("/");
  if (segments.includes("..")) return reject("path_escape", "remontée `..`");
  if (segments.length > MAX_PATH_SEGMENTS) return reject("malformed", "chemin trop profond");
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      return reject("malformed", "segment vide ou `.` : forme non canonique");
    }
    if (segment.length > MAX_SEGMENT_LENGTH) return reject("malformed", "segment trop long");
    if (segment.includes(":")) return reject("path_escape", "flux alternatif ou lecteur `:`");
    if (FORBIDDEN_CHARS.test(segment)) return reject("malformed", "caractère interdit");
    if (WINDOWS_DEVICE.test(segment)) return reject("path_escape", "nom de périphérique Windows");
    if (/[. ]$/.test(segment)) {
      // Windows retire point et espace finals : `a.` désignerait `a`.
      return reject("malformed", "segment terminé par un point ou un espace");
    }
    if (segment.startsWith(TEMP_PREFIX)) {
      return reject("malformed", "préfixe réservé aux écritures temporaires");
    }
  }
  return { ok: true, path: input as ConfinedRelativePath };
}

/** Erreur de confinement constatée sur le disque. */
export class ConfinementError extends Error {
  override readonly name = "ConfinementError";
  readonly reason: "path_escape" | "missing" | "not_a_file";

  constructor(reason: ConfinementError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

function samePath(a: string, b: string): boolean {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** `child` est `parent` ou se trouve dessous, sur chemins réels. */
export function isInside(parent: string, child: string): boolean {
  if (samePath(parent, child)) return true;
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Racine confinée résolue une fois : chemin réel, jamais un lien. */
export interface ConfinedRoot {
  readonly real: string;
}

export function openRoot(root: string): ConfinedRoot {
  const stat = lstatOrNull(root);
  if (stat === null) throw new ConfinementError("missing", "racine d'artefacts absente");
  if (stat.isSymbolicLink()) {
    // Node signale les jonctions Windows comme liens symboliques.
    throw new ConfinementError("path_escape", "la racine d'artefacts est un lien ou une jonction");
  }
  if (!stat.isDirectory()) throw new ConfinementError("not_a_file", "racine non répertoire");
  return { real: realpathSync.native(root) };
}

export interface ResolvedPath {
  /** Chemin réel absolu, sous la racine. */
  readonly absolute: string;
  /** `null` si la cible n'existe pas encore (écriture). */
  readonly stat: Stats | null;
}

/**
 * Résout `path` sous `root` en refusant tout composant lien ou jonction, puis vérifie
 * le chemin réel. Les répertoires intermédiaires absents sont tolérés si
 * `allowMissing` (écriture) ; sinon l'absence est une erreur `missing`.
 */
export function resolveConfined(
  root: ConfinedRoot,
  path: ConfinedRelativePath,
  options: { readonly allowMissing?: boolean } = {},
): ResolvedPath {
  const lexical = checkRelativePath(path);
  if (!lexical.ok) throw new ConfinementError("path_escape", lexical.detail);
  const segments = path.split("/");
  let current = root.real;
  let stat: Stats | null = null;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    stat = lstatOrNull(current);
    if (stat === null) {
      if (options.allowMissing === true) return { absolute: current, stat: null };
      throw new ConfinementError("missing", "fichier absent");
    }
    if (stat.isSymbolicLink()) {
      throw new ConfinementError("path_escape", "composant lien symbolique ou jonction");
    }
    const last = index === segments.length - 1;
    if (!last && !stat.isDirectory()) {
      throw new ConfinementError("not_a_file", "composant intermédiaire non répertoire");
    }
  }
  const real = realpathSync.native(current);
  if (!isInside(root.real, real) || !samePath(real, current)) {
    throw new ConfinementError("path_escape", "chemin réel hors de la racine");
  }
  return { absolute: current, stat };
}

function assertRegularSingleLink(stat: Stats): void {
  if (!stat.isFile()) throw new ConfinementError("not_a_file", "pas un fichier ordinaire");
  if (stat.nlink > 1) {
    // Un lien physique peut désigner un fichier hors de l'espace : son autre nom est
    // invisible depuis la racine, donc refusé sans exception.
    throw new ConfinementError("path_escape", "fichier à liens physiques multiples (hardlink)");
  }
}

const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/**
 * Ouvre en lecture un fichier confiné et renvoie son descripteur. Après ouverture,
 * l'identité (`dev`, `ino`) du descripteur doit être celle du chemin contrôlé, puis le
 * chemin est recontrôlé : une substitution pendant l'ouverture est refusée.
 */
export function openConfined(root: ConfinedRoot, path: ConfinedRelativePath): number {
  const resolved = resolveConfined(root, path);
  if (resolved.stat === null) throw new ConfinementError("missing", "fichier absent");
  assertRegularSingleLink(resolved.stat);
  const fd = openSync(resolved.absolute, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    assertRegularSingleLink(opened);
    const again = resolveConfined(root, path);
    if (
      again.stat === null ||
      opened.ino !== resolved.stat.ino ||
      opened.dev !== resolved.stat.dev ||
      again.stat.ino !== opened.ino ||
      again.stat.dev !== opened.dev
    ) {
      throw new ConfinementError("path_escape", "fichier substitué pendant l'ouverture");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
