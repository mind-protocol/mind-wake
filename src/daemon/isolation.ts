/**
 * Autotests de refus exécutés par le daemon avant tout lancement réel (migration
 * `isolation_self_tests`). Une session réelle n'est lancée que si le dernier autotest du
 * profil a réussi, nettoyage vérifié, pour l'empreinte du lanceur en service : un binaire
 * modifié exige un nouvel autotest. `status` lit ce résultat sans rien exécuter.
 */

import { randomUUID } from "node:crypto";
import type { ProfileId, UtcTimestamp } from "../contracts/index.js";
import type { IsolationSelfTestReport } from "../sandbox/index.js";
import type { SqliteDatabase } from "../store/index.js";

export interface IsolationSelfTestRecord {
  readonly id: string;
  readonly profileId: ProfileId;
  readonly ranAt: UtcTimestamp;
  /** Empreinte de la source du lanceur testé ; `null` si le lanceur n'a pas pu être construit. */
  readonly sourceDigest: string | null;
  readonly passed: boolean;
  readonly checks: number;
  readonly failed: readonly string[];
  readonly cleanupVerified: boolean;
  readonly terminationMs: number | null;
  readonly durationMs: number;
}

interface Row {
  id: string;
  profile_id: string;
  ran_at: string;
  source_digest: string | null;
  passed: number;
  checks: number;
  failed: string;
  cleanup_verified: number;
  termination_ms: number | null;
  duration_ms: number;
}

/** Réussite exigée : toutes les vérifications passées et le nettoyage vérifié. */
export function selfTestRecordFor(
  profileId: ProfileId,
  report: IsolationSelfTestReport,
  sourceDigest: string | null,
  ranAt: UtcTimestamp,
): IsolationSelfTestRecord {
  const cleanup = report.cleanup;
  const cleanupVerified =
    cleanup !== null && cleanup.aclRemoved && cleanup.profileRemoved && cleanup.tempRemoved;
  const failed = report.checks.filter((c) => !c.passed).map((c) => c.id);
  if (report.error !== undefined) failed.push(`error: ${report.error.slice(0, 200)}`);
  return {
    id: `selftest-${randomUUID()}`,
    profileId,
    ranAt,
    sourceDigest,
    passed: report.passed && cleanupVerified && failed.length === 0,
    checks: report.checks.length,
    failed,
    cleanupVerified,
    terminationMs: report.termination?.elapsedMs ?? null,
    durationMs: report.durationMs,
  };
}

export function recordSelfTest(db: SqliteDatabase, record: IsolationSelfTestRecord): void {
  db.prepare(
    `INSERT INTO isolation_self_tests
       (id, profile_id, ran_at, source_digest, passed, checks, failed, cleanup_verified, termination_ms, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.profileId,
    record.ranAt,
    record.sourceDigest,
    record.passed ? 1 : 0,
    record.checks,
    JSON.stringify(record.failed),
    record.cleanupVerified ? 1 : 0,
    record.terminationMs,
    record.durationMs,
  );
}

export function latestSelfTest(
  db: SqliteDatabase,
  profileId: ProfileId,
): IsolationSelfTestRecord | null {
  const row = db
    .prepare<[string], Row>(
      "SELECT * FROM isolation_self_tests WHERE profile_id = ? ORDER BY ran_at DESC, rowid DESC LIMIT 1",
    )
    .get(profileId);
  if (row === undefined) return null;
  let failed: readonly string[];
  try {
    const parsed: unknown = JSON.parse(row.failed);
    failed = Array.isArray(parsed) ? parsed.filter((f) => typeof f === "string") : ["illisible"];
  } catch {
    failed = ["illisible"];
  }
  return {
    id: row.id,
    profileId: row.profile_id as ProfileId,
    ranAt: row.ran_at as UtcTimestamp,
    sourceDigest: row.source_digest,
    passed: row.passed === 1,
    checks: row.checks,
    failed,
    cleanupVerified: row.cleanup_verified === 1,
    terminationMs: row.termination_ms,
    durationMs: row.duration_ms,
  };
}

/** Le dernier autotest vaut pour ce lanceur : réussi et de la même empreinte. */
export function selfTestValidFor(
  record: IsolationSelfTestRecord | null,
  sourceDigest: string | null,
): { readonly ok: boolean; readonly detail: string } {
  if (record === null) return { ok: false, detail: "autotest de refus jamais exécuté" };
  if (!record.passed) {
    return {
      ok: false,
      detail: `autotest de refus en échec (${record.ranAt}) : ${record.failed.join(", ") || "nettoyage non vérifié"}`,
    };
  }
  if (sourceDigest === null || record.sourceDigest !== sourceDigest) {
    return { ok: false, detail: "lanceur modifié depuis le dernier autotest : autotest à refaire" };
  }
  return {
    ok: true,
    detail: `autotest de refus réussi (${record.ranAt}, ${String(record.checks)} vérifications, lanceur ${sourceDigest})`,
  };
}
