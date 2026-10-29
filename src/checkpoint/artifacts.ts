/**
 * Artefacts : écriture atomique (temporaire puis renommage) et vérification
 * d'intégrité au moment de l'accès. Les artefacts restent sous une racine dédiée de
 * l'espace d'exploration ; leurs références vivent dans SQLite (`publish.ts`).
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  ArtifactId,
  ArtifactRef,
  CheckpointRejectionReason,
  ConfinedRelativePath,
  Sha256Hex,
} from "../contracts/index.js";
import {
  checkRelativePath,
  ConfinementError,
  isNotFound,
  openConfined,
  resolveConfined,
  TEMP_PREFIX,
  type ConfinedRoot,
} from "./paths.js";

/** Taille maximale d'un artefact référencé par un checkpoint. */
export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

const CHUNK_BYTES = 64 * 1024;

export class ArtifactTooLargeError extends Error {
  override readonly name = "ArtifactTooLargeError";
}

function sha256Hex(data: Uint8Array): Sha256Hex {
  return createHash("sha256").update(data).digest("hex") as Sha256Hex;
}

function ensureParents(root: ConfinedRoot, path: ConfinedRelativePath): void {
  const segments = path.split("/").slice(0, -1);
  let current = root.real;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      mkdirSync(current);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
    }
    // Recontrôlé après création : un lien posé entre-temps est refusé.
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new ConfinementError("path_escape", "composant lien symbolique ou jonction");
    }
    if (!stat.isDirectory()) {
      throw new ConfinementError("not_a_file", "composant intermédiaire non répertoire");
    }
  }
}

function fsyncDirectory(path: string): void {
  // Windows n'ouvre pas un répertoire en écriture : NTFS journalise le renommage, sans
  // garantie équivalente à `fsync` du répertoire. Limite documentée dans le README.
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface WriteArtifactOptions {
  readonly id: ArtifactId;
  readonly maxBytes?: number;
  /** Injection de fautes pour les tests : appelé après `fsync`, avant le renommage. */
  readonly beforeRename?: () => void;
}

/**
 * Écrit `content` à `path` sous la racine : fichier temporaire exclusif dans le même
 * répertoire, `fsync`, puis renommage. Un crash laisse soit l'ancien fichier, soit le
 * nouveau, soit un temporaire `.mw-tmp-*` détecté par la réconciliation. La cible
 * existante ne peut être qu'un fichier ordinaire : jamais un lien, une jonction ou un
 * répertoire. La référence renvoyée n'est pas encore enregistrée dans SQLite.
 */
export function writeArtifactAtomic(
  root: ConfinedRoot,
  path: string,
  content: Uint8Array | string,
  options: WriteArtifactOptions,
): ArtifactRef {
  const lexical = checkRelativePath(path);
  if (!lexical.ok) throw new ConfinementError("path_escape", lexical.detail);
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (data.byteLength > (options.maxBytes ?? MAX_ARTIFACT_BYTES)) {
    throw new ArtifactTooLargeError("artefact trop volumineux");
  }
  ensureParents(root, lexical.path);
  const target = resolveConfined(root, lexical.path, { allowMissing: true });
  if (target.stat !== null && !target.stat.isFile()) {
    throw new ConfinementError("not_a_file", "la cible existe et n'est pas un fichier ordinaire");
  }
  const directory = dirname(target.absolute);
  const temp = join(directory, `${TEMP_PREFIX}${randomUUID()}`);
  // `wx` : création exclusive, échoue si un lien ou fichier occupe déjà ce nom.
  const fd = openSync(temp, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < data.byteLength) {
      offset += writeSync(fd, data, offset, data.byteLength - offset);
    }
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
  closeSync(fd);
  options.beforeRename?.();
  try {
    renameSync(temp, target.absolute);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  fsyncDirectory(directory);
  return { id: options.id, path: lexical.path, sha256: sha256Hex(data), bytes: data.byteLength };
}

export interface FileDigest {
  readonly sha256: Sha256Hex;
  readonly bytes: number;
}

/** Empreinte d'un fichier confiné, lu par descripteur après contrôle des liens. */
export function digestConfined(
  root: ConfinedRoot,
  path: ConfinedRelativePath,
  maxBytes: number = MAX_ARTIFACT_BYTES,
): FileDigest {
  const fd = openConfined(root, path);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK_BYTES, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) throw new ArtifactTooLargeError("artefact trop volumineux");
      hash.update(buffer.subarray(0, read));
    }
    return { sha256: hash.digest("hex") as Sha256Hex, bytes: total };
  } finally {
    closeSync(fd);
  }
}

export type ArtifactCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: Extract<
        CheckpointRejectionReason,
        "path_escape" | "missing_artifact" | "integrity_mismatch" | "too_large"
      >;
      readonly detail: string;
    };

/** Vérifie qu'une référence désigne, sous la racine, un fichier conforme à l'empreinte. */
export function verifyArtifact(
  root: ConfinedRoot,
  ref: Pick<ArtifactRef, "path" | "sha256" | "bytes">,
  maxBytes: number = MAX_ARTIFACT_BYTES,
): ArtifactCheck {
  try {
    const digest = digestConfined(root, ref.path, maxBytes);
    if (digest.sha256 !== ref.sha256 || digest.bytes !== ref.bytes) {
      return { ok: false, reason: "integrity_mismatch", detail: "empreinte ou taille différente" };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof ArtifactTooLargeError) {
      return { ok: false, reason: "too_large", detail: error.message };
    }
    if (error instanceof ConfinementError) {
      return error.reason === "path_escape"
        ? { ok: false, reason: "path_escape", detail: error.message }
        : { ok: false, reason: "missing_artifact", detail: error.message };
    }
    if (isNotFound(error)) {
      return { ok: false, reason: "missing_artifact", detail: "fichier absent" };
    }
    throw error;
  }
}
