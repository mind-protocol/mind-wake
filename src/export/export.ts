/**
 * Export cohérent et expurgé (SPEC §8.3, §9 ; AGENTS §3.10). L'état de contrôle est lu
 * dans une seule transaction de lecture, expurgé, puis écrit avec les artefacts
 * référencés et un manifeste versionné dans un dossier choisi par l'humain.
 *
 * Garanties :
 * - lecture seule de la base : l'export ne remet aucun compteur de budget à zéro et ne
 *   libère aucune réservation ; les compteurs sont copiés tels quels ;
 * - aucune variable d'environnement n'est lue ni écrite ; les chaînes passent par
 *   l'expurgation des secrets ; un artefact où un secret est détecté est exclu ;
 * - écriture dans un dossier temporaire voisin puis renommage : un export interrompu
 *   ne laisse jamais un dossier cible incomplet, et une cible existante est refusée.
 *
 * Limite : l'expurgation est heuristique (formats et clés connus). Un artefact binaire
 * n'est examiné que pour ces mêmes motifs.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SchemaVersion } from "../contracts/index.js";
import { redactString, redactValue } from "../journal/index.js";
import { isConfinedPath } from "../policy/index.js";
import { openStoreReadOnly } from "../store/index.js";
import { readSnapshot, type DatabaseSnapshot, type SnapshotRow } from "./snapshot.js";

export const EXPORT_MANIFEST_SCHEMA = "mind-wake.export";
/** Version du format d'export ; à incrémenter à tout changement incompatible. */
export const EXPORT_MANIFEST_SCHEMA_VERSION: SchemaVersion = 1;

export const MANIFEST_FILE = "manifest.json";
export const STATE_FILE = "state.json";
export const ARTIFACTS_DIR = "artifacts";

/**
 * Racine des artefacts dans le dossier de données, relative. Hypothèse en attendant le
 * gestionnaire de checkpoints (S8) : à aligner sur l'emplacement qu'il retiendra.
 */
export const DEFAULT_ARTIFACTS_SUBDIR = "workspace";

/** Au-delà, un artefact n'est pas copié (motif `too_large`). */
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

export type ExportErrorCode =
  "no_database" | "target_exists" | "target_inside_data_dir" | "invalid_target";

export class ExportError extends Error {
  override readonly name = "ExportError";
  constructor(
    readonly code: ExportErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ArtifactExclusionReason =
  | "path_escape"
  | "link_refused"
  | "missing"
  | "not_a_file"
  | "too_large"
  | "integrity_mismatch"
  | "contains_secret"
  | "no_artifacts_root";

export interface ExportedFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface BudgetCounters {
  readonly reservations: Readonly<Record<string, number>>;
  /** Consommation imputée par unité (et qualifiant), copiée depuis le ledger. */
  readonly charges: readonly {
    readonly unit: string;
    readonly qualifier: string;
    readonly amount: number;
  }[];
  readonly note: string;
}

export interface ExportManifest {
  readonly schema: typeof EXPORT_MANIFEST_SCHEMA;
  readonly schemaVersion: SchemaVersion;
  readonly createdAt: string;
  readonly consistency: "sqlite_read_transaction";
  readonly source: {
    readonly migrations: DatabaseSnapshot["migrations"];
    readonly tables: Readonly<Record<string, number>>;
  };
  readonly budget: BudgetCounters;
  readonly files: readonly ExportedFile[];
  readonly artifacts: {
    readonly copied: number;
    readonly excluded: readonly {
      readonly path: string;
      readonly reason: ArtifactExclusionReason;
    }[];
  };
  readonly redaction: {
    readonly secrets: "heuristic";
    readonly environment: "excluded";
    readonly credentials: "never_stored";
  };
  readonly limits: readonly string[];
}

export interface ExportOptions {
  /** Base de contrôle à lire. */
  readonly dbPath: string;
  /** Dossier de données : la cible ne peut pas s'y trouver. */
  readonly dataDir: string;
  /** Dossier à créer, choisi par l'humain ; il ne doit pas exister. */
  readonly target: string;
  /** Racine des artefacts référencés par les checkpoints, ou `null` si absente. */
  readonly artifactsRoot: string | null;
  readonly now: Date;
  readonly onSnapshotOpen?: () => void;
}

export interface ExportResult {
  readonly target: string;
  readonly manifest: ExportManifest;
}

export const EXPORT_LIMITS: readonly string[] = [
  "expurgation heuristique : formats de secrets et clés sensibles connus ; ne garantit pas l'absence de toute donnée sensible",
  "aucun import n'est fourni ; un import futur ne devra jamais remettre un compteur de budget à zéro",
  "la base de contrôle n'est pas copiée brute : seules les tables expurgées figurent dans state.json",
];

function isInside(parent: string, child: string, platform = process.platform): boolean {
  const norm = (p: string): string => (platform === "win32" ? p.toLowerCase() : p);
  const relative = path.relative(norm(path.resolve(parent)), norm(path.resolve(child)));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Recherche de motifs de secrets par blocs chevauchants, sans limite de taille. */
export function containsSecret(content: Buffer): boolean {
  const text = content.toString("latin1");
  const chunk = 32_768;
  const overlap = 4_096;
  for (let start = 0; start < text.length; start += chunk - overlap) {
    const part = text.slice(start, start + chunk);
    if (redactString(part) !== part) return true;
    if (start + chunk >= text.length) break;
  }
  return false;
}

function budgetCounters(tables: DatabaseSnapshot["tables"]): BudgetCounters {
  const reservations: Record<string, number> = {};
  for (const row of tables["reservations"] ?? []) {
    const status = String(row["status"]);
    reservations[status] = (reservations[status] ?? 0) + 1;
  }
  const totals = new Map<string, { unit: string; qualifier: string; amount: number }>();
  for (const row of tables["reservation_charges"] ?? []) {
    const unit = String(row["unit"]);
    const qualifier = String(row["qualifier"]);
    const key = `${unit}\u0000${qualifier}`;
    const current = totals.get(key) ?? { unit, qualifier, amount: 0 };
    totals.set(key, { ...current, amount: current.amount + Number(row["amount"]) });
  }
  return {
    reservations,
    charges: [...totals.values()],
    note: "compteurs copiés tels quels : un export ne remet aucun budget à zéro et ne libère aucune réservation",
  };
}

interface ArtifactRow {
  readonly path: string;
  readonly sha256: string;
}

function artifactRows(tables: DatabaseSnapshot["tables"]): readonly ArtifactRow[] {
  const seen = new Map<string, ArtifactRow>();
  for (const row of tables["checkpoint_artifacts"] ?? []) {
    const ref = { path: String(row["path"]), sha256: String(row["sha256"]) };
    seen.set(`${ref.path}\u0000${ref.sha256}`, ref);
  }
  return [...seen.values()];
}

type ArtifactRead =
  | { readonly ok: true; readonly content: Buffer }
  | { readonly ok: false; readonly reason: ArtifactExclusionReason };

/**
 * Lit un artefact confiné : chemin lexicalement confiné, aucun segment lien ou
 * jonction, chemin réel sous la racine réelle, intégrité conforme au checkpoint.
 */
function readArtifact(root: string, ref: ArtifactRow): ArtifactRead {
  if (!isConfinedPath(ref.path, false)) return { ok: false, reason: "path_escape" };
  let realRoot: string;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    return { ok: false, reason: "no_artifacts_root" };
  }
  let current = root;
  for (const segment of ref.path.split("/")) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stats === undefined) return { ok: false, reason: "missing" };
    if (stats.isSymbolicLink()) return { ok: false, reason: "link_refused" };
  }
  const stats = fs.lstatSync(current);
  if (!stats.isFile()) return { ok: false, reason: "not_a_file" };
  if (stats.size > MAX_ARTIFACT_BYTES) return { ok: false, reason: "too_large" };
  if (!isInside(realRoot, fs.realpathSync.native(current))) {
    return { ok: false, reason: "path_escape" };
  }
  const content = fs.readFileSync(current);
  if (sha256(content) !== ref.sha256) return { ok: false, reason: "integrity_mismatch" };
  if (containsSecret(content)) return { ok: false, reason: "contains_secret" };
  return { ok: true, content };
}

function writeFile(base: string, relative: string, content: Buffer | string): ExportedFile {
  const full = path.join(base, ...relative.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, { flag: "wx" });
  const bytes = typeof content === "string" ? Buffer.byteLength(content) : content.length;
  return { path: relative, sha256: sha256(content), bytes };
}

function checkTarget(options: ExportOptions): string {
  const target = path.resolve(options.target);
  if (path.parse(target).root === target) {
    throw new ExportError("invalid_target", "la cible ne peut pas être la racine d'un volume");
  }
  if (isInside(options.dataDir, target)) {
    throw new ExportError(
      "target_inside_data_dir",
      "la cible ne peut pas se trouver dans le dossier de données",
    );
  }
  if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    throw new ExportError("target_exists", "la cible existe déjà : choisir un nouveau dossier");
  }
  return target;
}

export function exportData(options: ExportOptions): ExportResult {
  const target = checkTarget(options);
  if (!fs.existsSync(options.dbPath)) {
    throw new ExportError("no_database", "aucune base de contrôle à exporter : lancer `init`");
  }
  const store = openStoreReadOnly(options.dbPath);
  let snapshot: DatabaseSnapshot;
  try {
    snapshot = readSnapshot(
      store.db,
      options.onSnapshotOpen === undefined ? {} : { onSnapshotOpen: options.onSnapshotOpen },
    );
  } finally {
    store.close();
  }

  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const staging = path.join(
    parent,
    `.${path.basename(target)}.partiel-${randomBytes(6).toString("hex")}`,
  );
  fs.mkdirSync(staging);
  try {
    const files: ExportedFile[] = [];
    const tables = redactValue(snapshot.tables) as Record<string, readonly SnapshotRow[]>;
    const state = {
      schema: EXPORT_MANIFEST_SCHEMA,
      schemaVersion: EXPORT_MANIFEST_SCHEMA_VERSION,
      tables,
    };
    files.push(writeFile(staging, STATE_FILE, `${JSON.stringify(state, null, 2)}\n`));

    const excluded: { path: string; reason: ArtifactExclusionReason }[] = [];
    let copied = 0;
    for (const ref of artifactRows(snapshot.tables)) {
      const label = redactString(ref.path);
      if (options.artifactsRoot === null) {
        excluded.push({ path: label, reason: "no_artifacts_root" });
        continue;
      }
      const read = readArtifact(options.artifactsRoot, ref);
      if (!read.ok) {
        excluded.push({ path: label, reason: read.reason });
        continue;
      }
      const relative = `${ARTIFACTS_DIR}/${ref.sha256}/${ref.path}`;
      files.push(writeFile(staging, relative, read.content));
      copied += 1;
    }

    const manifest: ExportManifest = {
      schema: EXPORT_MANIFEST_SCHEMA,
      schemaVersion: EXPORT_MANIFEST_SCHEMA_VERSION,
      createdAt: options.now.toISOString(),
      consistency: "sqlite_read_transaction",
      source: {
        migrations: snapshot.migrations,
        tables: Object.fromEntries(
          Object.entries(snapshot.tables).map(([name, rows]) => [name, rows.length]),
        ),
      },
      budget: budgetCounters(snapshot.tables),
      files,
      artifacts: { copied, excluded },
      redaction: { secrets: "heuristic", environment: "excluded", credentials: "never_stored" },
      limits: EXPORT_LIMITS,
    };
    writeFile(staging, MANIFEST_FILE, `${JSON.stringify(redactValue(manifest), null, 2)}\n`);
    fs.renameSync(staging, target);
    return { target, manifest };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
