/**
 * Purge sur demande explicite de l'humain (SPEC §9). Seul le journal est purgé, et
 * seulement son préfixe expiré au sens de `planJournalPurge` (S5) : jamais une
 * expérience, un checkpoint, une révision, un consentement ni une ligne du ledger. La
 * mémoire courante et le dernier checkpoint restent donc intacts.
 *
 * Le résultat est explicite : nombre d'événements retirés, séquence, octets avant et
 * après. La suppression est logique (lignes SQLite supprimées, WAL tronqué) : aucune
 * promesse d'effacement physique sécurisé du disque.
 */

import type {
  JournalEvent,
  ProfileId,
  SessionId,
  UnitOfWork,
  UtcTimestamp,
} from "../contracts/index.js";
import {
  JournalWriter,
  planJournalPurge,
  retentionRuleFromPolicy,
  type PurgePlan,
  type RetentionRule,
} from "../journal/index.js";
import { resolvePolicy } from "../policy/index.js";
import type { SqliteDatabase } from "../store/index.js";

export const PURGE_PHYSICAL_NOTE =
  "suppression logique : les lignes sont retirées de la base, mais des fragments peuvent subsister sur le disque ; aucun effacement physique sécurisé n'est promis";

export type RetentionSource = "option" | "policy";

export type PurgeRuleResult =
  | { readonly ok: true; readonly rule: RetentionRule; readonly source: RetentionSource }
  | { readonly ok: false; readonly detail: string };

/**
 * Règle de rétention : `--older-than-days` fourni par l'humain, sinon la rétention de
 * la révision en vigueur. Sans l'une ni l'autre, rien n'est purgeable.
 */
export function purgeRule(
  uow: UnitOfWork,
  profileId: ProfileId,
  olderThanDays: number | null,
): PurgeRuleResult {
  if (olderThanDays !== null) {
    if (!Number.isSafeInteger(olderThanDays) || olderThanDays < 1) {
      return { ok: false, detail: "--older-than-days attend un entier ≥ 1" };
    }
    return {
      ok: true,
      rule: { retentionDays: olderThanDays, automatic: false },
      source: "option",
    };
  }
  const resolution = resolvePolicy(uow.policies, profileId);
  if (resolution.status !== "active") {
    return {
      ok: false,
      detail:
        "aucune rétention consentie : préciser --older-than-days N pour purger les événements plus anciens que N jours",
    };
  }
  const rule = retentionRuleFromPolicy(resolution.revision.groups.data);
  return rule.valid
    ? { ok: true, rule: rule.rule, source: "policy" }
    : { ok: false, detail: rule.detail };
}

/**
 * Sessions dont les événements restent protégés : session sans résultat terminal, ou
 * réservation encore ouverte ou incertaine (consommation non rapprochée).
 */
export function protectedSessions(db: SqliteDatabase, profileId: ProfileId): Set<SessionId> {
  const rows = db
    .prepare<[string, string], { id: string }>(
      `SELECT id FROM sessions WHERE profile_id = ? AND outcome IS NULL
       UNION
       SELECT session_id AS id FROM reservations
       WHERE profile_id = ? AND status IN ('open', 'uncertain')`,
    )
    .all(profileId, profileId);
  return new Set(rows.map((row) => row.id as SessionId));
}

export function planPurge(
  db: SqliteDatabase,
  events: readonly JournalEvent[],
  profileId: ProfileId,
  rule: RetentionRule,
  now: Date,
): PurgePlan {
  return planJournalPurge(events, rule, {
    now,
    protectedSessionIds: protectedSessions(db, profileId),
  });
}

export interface PurgeOutcome {
  readonly deletedEvents: number;
  readonly throughSequence: number | null;
}

/**
 * Supprime le préfixe planifié et journalise la purge, dans une même transaction. La
 * séquence du journal n'est jamais réutilisée (`journal_sequences` inchangée).
 */
export function applyPurge(
  db: SqliteDatabase,
  uow: UnitOfWork,
  profileId: ProfileId,
  plan: PurgePlan,
  source: RetentionSource,
  at: UtcTimestamp,
): PurgeOutcome {
  const outcome = uow.transaction((tx): PurgeOutcome => {
    let deleted = 0;
    if (plan.throughSequence !== null) {
      deleted = db
        .prepare("DELETE FROM journal_events WHERE profile_id = ? AND sequence <= ?")
        .run(profileId, plan.throughSequence).changes;
    }
    new JournalWriter(tx.journal).record({
      type: "data_purged",
      at,
      profileId,
      reason:
        deleted === 0
          ? "purge demandée par l'humain : aucun événement expiré"
          : "purge du journal demandée par l'humain",
      metadata: {
        deletedEvents: deleted,
        throughSequence: plan.throughSequence,
        cutoff: plan.cutoff,
        retentionSource: source,
        stoppedBy: plan.stoppedBy.kind,
      },
    });
    return { deletedEvents: deleted, throughSequence: plan.throughSequence };
  });
  // Rend la place du WAL au système ; n'efface pas physiquement les pages libérées.
  db.pragma("wal_checkpoint(TRUNCATE)");
  return outcome;
}
