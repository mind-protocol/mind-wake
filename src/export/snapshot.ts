/**
 * Lecture cohérente de la base de contrôle : toutes les tables sont lues dans une seule
 * transaction de lecture. En WAL, cette transaction voit un instantané figé ; une
 * écriture concurrente validée pendant la lecture n'y apparaît pas, ni à moitié.
 */

import type { SqliteDatabase } from "../store/index.js";

export type SnapshotRow = Readonly<Record<string, unknown>>;

export interface DatabaseSnapshot {
  /** Migrations appliquées, dans l'ordre. */
  readonly migrations: readonly { readonly version: number; readonly name: string }[];
  /** Lignes par table, dans l'ordre de la clé primaire. */
  readonly tables: Readonly<Record<string, readonly SnapshotRow[]>>;
}

export interface SnapshotOptions {
  /**
   * Appelée une fois l'instantané ouvert, avant la lecture des tables. Réservée aux
   * tests de concurrence : une écriture faite ici ne doit pas apparaître dans l'export.
   */
  readonly onSnapshotOpen?: () => void;
}

/** Colonnes `*_json` : décodées pour un export lisible, jamais réinterprétées. */
function decodeRow(row: Record<string, unknown>): SnapshotRow {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith("_json") && typeof value === "string") {
      try {
        out[key] = JSON.parse(value) as unknown;
      } catch {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function readSnapshot(db: SqliteDatabase, options: SnapshotOptions = {}): DatabaseSnapshot {
  const read = db.transaction((): DatabaseSnapshot => {
    // Première lecture : fixe l'instantané WAL de la transaction.
    const migrations = db
      .prepare<[], { version: number; name: string }>(
        "SELECT version, name FROM schema_migrations ORDER BY version",
      )
      .all();
    options.onSnapshotOpen?.();
    const names = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    const tables: Record<string, readonly SnapshotRow[]> = {};
    for (const name of names) {
      const rows = db
        .prepare<[], Record<string, unknown>>(
          `SELECT * FROM ${quoteIdentifier(name)} ORDER BY ${orderBy(db, name)}`,
        )
        .all();
      tables[name] = rows.map(decodeRow);
    }
    return { migrations, tables };
  });
  return read.deferred();
}

/** Ordre stable : colonnes de la clé primaire, sinon rowid. */
function orderBy(db: SqliteDatabase, table: string): string {
  const pk = db
    .prepare<[], { name: string; pk: number }>(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => quoteIdentifier(column.name));
  return pk.length > 0 ? pk.join(", ") : "rowid";
}
