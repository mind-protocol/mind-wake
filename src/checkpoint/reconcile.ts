/**
 * Réconciliation au redémarrage (SPEC §7) : compare les fichiers présents sous la
 * racine d'artefacts et les références enregistrées dans SQLite.
 *
 * Rapport seulement : rien n'est supprimé ni déplacé. Un fichier sans référence peut
 * être le résultat d'un crash entre écriture et enregistrement ; le supprimer
 * silencieusement effacerait peut-être le seul reste d'un travail (SPEC §9).
 */

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  CheckpointId,
  ConfinedRelativePath,
  ExperimentId,
  ProfileId,
  Sha256Hex,
} from "../contracts/index.js";
import type { SqliteDatabase } from "../store/index.js";
import { verifyArtifact } from "./artifacts.js";
import { TEMP_PREFIX, type ConfinedRoot } from "./paths.js";

export const MAX_SCANNED_ENTRIES = 100_000;

export interface ReferencedArtifact {
  readonly checkpointId: CheckpointId;
  readonly experimentId: ExperimentId;
  readonly sequence: number;
  readonly path: ConfinedRelativePath;
  readonly sha256: Sha256Hex;
  readonly bytes: number;
}

export type ArtifactAnomaly =
  | {
      readonly kind: "missing" | "integrity_mismatch" | "path_escape";
      readonly path: ConfinedRelativePath;
      readonly checkpointId: CheckpointId;
      readonly sequence: number;
    }
  /** Fichier présent sans référence : crash probable entre écriture et enregistrement. */
  | { readonly kind: "unreferenced"; readonly path: string }
  /** Temporaire `.mw-tmp-*` : écriture atomique interrompue avant renommage. */
  | { readonly kind: "interrupted_write"; readonly path: string }
  /** Lien symbolique ou jonction trouvé dans l'arborescence ; jamais suivi. */
  | { readonly kind: "link"; readonly path: string }
  /** Ni fichier ni répertoire (périphérique, socket…). */
  | { readonly kind: "unexpected_entry"; readonly path: string };

export interface ReconciliationReport {
  readonly referenced: number;
  readonly scannedFiles: number;
  /** Parcours arrêté à `MAX_SCANNED_ENTRIES` : le rapport est incomplet. */
  readonly truncated: boolean;
  readonly anomalies: readonly ArtifactAnomaly[];
}

interface ArtifactRow {
  readonly checkpoint_id: string;
  readonly experiment_id: string;
  readonly sequence: number;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * Références d'artefacts du profil. Pour un chemin cité par plusieurs checkpoints,
 * seule la référence la plus récente décrit le contenu attendu.
 */
export function listReferencedArtifacts(
  db: SqliteDatabase,
  profileId: ProfileId,
): readonly ReferencedArtifact[] {
  const rows = db
    .prepare<[string], ArtifactRow>(
      `SELECT c.id AS checkpoint_id, c.experiment_id, c.sequence, a.path, a.sha256, a.bytes
         FROM checkpoint_artifacts a
         JOIN checkpoints c ON c.id = a.checkpoint_id
         JOIN experiments e ON e.id = c.experiment_id
        WHERE e.profile_id = ?
        ORDER BY c.created_at, c.sequence, a.ordinal`,
    )
    .all(profileId);
  const latest = new Map<string, ReferencedArtifact>();
  for (const row of rows) {
    latest.set(pathKey(row.path), {
      checkpointId: row.checkpoint_id as CheckpointId,
      experimentId: row.experiment_id as ExperimentId,
      sequence: row.sequence,
      path: row.path as ConfinedRelativePath,
      sha256: row.sha256 as Sha256Hex,
      bytes: row.bytes,
    });
  }
  return [...latest.values()];
}

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

function pathKey(path: string): string {
  return caseInsensitive ? path.toLowerCase() : path;
}

interface Scan {
  readonly files: string[];
  readonly anomalies: ArtifactAnomaly[];
  truncated: boolean;
  entries: number;
}

function scan(directory: string, prefix: string, state: Scan): void {
  for (const name of readdirSync(directory).sort()) {
    if (state.entries >= MAX_SCANNED_ENTRIES) {
      state.truncated = true;
      return;
    }
    state.entries += 1;
    const relative = prefix === "" ? name : `${prefix}/${name}`;
    const absolute = join(directory, name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      state.anomalies.push({ kind: "link", path: relative });
    } else if (stat.isDirectory()) {
      scan(absolute, relative, state);
    } else if (!stat.isFile()) {
      state.anomalies.push({ kind: "unexpected_entry", path: relative });
    } else if (name.startsWith(TEMP_PREFIX)) {
      state.anomalies.push({ kind: "interrupted_write", path: relative });
    } else {
      state.files.push(relative);
    }
  }
}

/** Détecte références manquantes ou altérées et fichiers sans référence. */
export function reconcileArtifacts(
  db: SqliteDatabase,
  root: ConfinedRoot,
  profileId: ProfileId,
): ReconciliationReport {
  const references = listReferencedArtifacts(db, profileId);
  const anomalies: ArtifactAnomaly[] = [];
  for (const ref of references) {
    const check = verifyArtifact(root, ref);
    if (!check.ok) {
      const kind =
        check.reason === "missing_artifact"
          ? "missing"
          : check.reason === "path_escape"
            ? "path_escape"
            : "integrity_mismatch";
      anomalies.push({
        kind,
        path: ref.path,
        checkpointId: ref.checkpointId,
        sequence: ref.sequence,
      });
    }
  }
  const state: Scan = { files: [], anomalies: [], truncated: false, entries: 0 };
  scan(root.real, "", state);
  const known = new Set(references.map((ref) => pathKey(ref.path)));
  for (const file of state.files) {
    if (!known.has(pathKey(file))) anomalies.push({ kind: "unreferenced", path: file });
  }
  return {
    referenced: references.length,
    scannedFiles: state.files.length,
    truncated: state.truncated,
    anomalies: [...anomalies, ...state.anomalies],
  };
}
