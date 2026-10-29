/**
 * Exécutions du daemon (migration `daemon_runs`) : qui tourne, depuis quand, en quel
 * mode. Lu par `status` sans prendre le verrou d'instance : un démarrage concurrent
 * ne peut pas échouer à cause d'une consultation.
 */

import type { AdapterId, ProfileId, UtcTimestamp } from "../contracts/index.js";
import type { SqliteDatabase } from "../store/index.js";

export type DaemonMode = "simulated" | "real";

export interface DaemonRun {
  readonly id: string;
  readonly profileId: ProfileId;
  readonly pid: number;
  readonly mode: DaemonMode;
  readonly adapterId: AdapterId;
  readonly startedAt: UtcTimestamp;
  readonly endedAt: UtcTimestamp | null;
  readonly endReason: string | null;
}

interface Row {
  id: string;
  profile_id: string;
  pid: number;
  mode: DaemonMode;
  adapter_id: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
}

function fromRow(row: Row): DaemonRun {
  return {
    id: row.id,
    profileId: row.profile_id as ProfileId,
    pid: row.pid,
    mode: row.mode,
    adapterId: row.adapter_id as AdapterId,
    startedAt: row.started_at as UtcTimestamp,
    endedAt: row.ended_at as UtcTimestamp | null,
    endReason: row.end_reason,
  };
}

export function recordDaemonStart(db: SqliteDatabase, run: DaemonRun): void {
  db.prepare(
    `INSERT INTO daemon_runs (id, profile_id, pid, mode, adapter_id, started_at, ended_at, end_reason)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(run.id, run.profileId, run.pid, run.mode, run.adapterId, run.startedAt);
}

export function recordDaemonEnd(
  db: SqliteDatabase,
  id: string,
  at: UtcTimestamp,
  reason: string,
): void {
  db.prepare(
    "UPDATE daemon_runs SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL",
  ).run(at, reason, id);
}

/** Exécutions laissées sans fin (arrêt brutal) : closes au démarrage suivant. */
export function closeAbandonedRuns(
  db: SqliteDatabase,
  profileId: ProfileId,
  at: UtcTimestamp,
): readonly DaemonRun[] {
  const rows = db
    .prepare<[string], Row>(
      "SELECT * FROM daemon_runs WHERE profile_id = ? AND ended_at IS NULL ORDER BY started_at",
    )
    .all(profileId);
  for (const row of rows) {
    recordDaemonEnd(db, row.id, at, "arrêt brutal constaté au démarrage suivant");
  }
  return rows.map(fromRow);
}

/** Dernière exécution du profil ; `null` si la table n'existe pas encore (base ancienne). */
export function latestDaemonRun(db: SqliteDatabase, profileId: ProfileId): DaemonRun | null {
  try {
    const row = db
      .prepare<[string], Row>(
        "SELECT * FROM daemon_runs WHERE profile_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get(profileId);
    return row === undefined ? null : fromRow(row);
  } catch {
    return null;
  }
}

/** Le processus existe encore (aucun signal envoyé : sonde seulement). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}
