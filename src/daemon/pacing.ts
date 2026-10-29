/**
 * Mesures du pilotage de la voie abonnement (migration `quota_pacing`, ADR-005,
 * complément). Le daemon observe chaque lecture officielle de la jauge :
 *
 * - **débit** : à la fin d'une session, `(usage fin − usage début) / durée`, en points
 *   de base par heure, sur chaque fenêtre restée la même (même remise à zéro) pendant au
 *   moins `MIN_RATE_SAMPLE_MS` ; moyenne glissante par runtime et par fenêtre. La jauge
 *   inclut l'usage de l'humain : le débit mesuré est donc prudent (surestimé) ;
 * - **marge** : à chaque changement de fenêtre (nouvelle remise à zéro), l'usage final
 *   de la fenêtre close est comparé à la cible : sous la cible → marge augmentée, cible
 *   atteinte trop tôt → marge réduite. Chaque ajustement est journalisé avec la projection.
 *
 * Rien ici n'autorise un lancement : `decideLaunch` décide, avec ces estimations.
 */

import type {
  AdapterId,
  ProfileId,
  ProviderQuotaSnapshot,
  SubscriptionQuotaGuard,
  UnitOfWork,
  UtcTimestamp,
} from "../contracts/index.js";
import { prepareJournalEvent } from "../journal/index.js";
import {
  HOUR_MS,
  adjustMargin,
  pacingDetail,
  planPacing,
  smoothRate,
  type PacingEstimate,
} from "../policy/index.js";
import type { SqliteDatabase } from "../store/index.js";

/** Durée minimale d'une session pour mesurer un débit. */
export const MIN_RATE_SAMPLE_MS = 5 * 60_000;
/** Écart toléré entre deux `resetsAt` d'une même fenêtre. */
const SAME_WINDOW_MS = 60_000;

type EnabledGuard = Extract<SubscriptionQuotaGuard, { enabled: true }>;

interface Row {
  window_key: string;
  rate_bp_per_hour: number | null;
  samples: number;
  margin_ratio: number;
  window_resets_at: string | null;
  last_used_bp: number | null;
  reached_at: string | null;
}

function utc(ms: number): UtcTimestamp {
  return new Date(ms).toISOString() as UtcTimestamp;
}

export class QuotaPacingStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly uow: UnitOfWork,
    private readonly profileId: ProfileId,
    private readonly adapterId: AdapterId,
  ) {}

  #rows(): Row[] {
    return this.db
      .prepare<[string, string], Row>(
        `SELECT window_key, rate_bp_per_hour, samples, margin_ratio, window_resets_at, last_used_bp, reached_at
         FROM quota_pacing WHERE profile_id = ? AND adapter_id = ?`,
      )
      .all(this.profileId, this.adapterId);
  }

  #row(guard: EnabledGuard, windowKey: string, nowMs: number): Row {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO quota_pacing
           (profile_id, adapter_id, window_key, rate_bp_per_hour, samples, margin_ratio, updated_at)
         VALUES (?, ?, ?, NULL, 0, ?, ?)`,
      )
      .run(this.profileId, this.adapterId, windowKey, guard.pacingMarginRatio, utc(nowMs));
    const row = this.#rows().find((r) => r.window_key === windowKey);
    if (row === undefined) throw new Error(`pilotage : fenêtre ${windowKey} introuvable`);
    return row;
  }

  estimates(): readonly PacingEstimate[] {
    return this.#rows().map((r) => ({
      windowKey: r.window_key,
      rateBasisPointsPerHour: r.rate_bp_per_hour,
      marginRatio: r.margin_ratio,
      samples: r.samples,
    }));
  }

  /**
   * Observe une lecture : suit l'usage de la fenêtre en cours et, quand une fenêtre se
   * remet à zéro, ajuste la marge d'après l'usage final de la fenêtre close.
   */
  observe(guard: EnabledGuard, snapshots: readonly ProviderQuotaSnapshot[], nowMs: number): void {
    const target = Math.min(guard.targetUsageBasisPoints, guard.stopAtBasisPoints);
    for (const s of snapshots) {
      if (s.provenance !== "measured") continue;
      const resetsAt = Date.parse(s.resetsAt);
      const observedAt = Date.parse(s.observedAt);
      if (!Number.isFinite(resetsAt) || !Number.isFinite(observedAt)) continue;
      const row = this.#row(guard, s.windowKey, nowMs);
      let margin = row.margin_ratio;
      let reachedAt = row.reached_at;
      const previous = row.window_resets_at === null ? null : Date.parse(row.window_resets_at);
      if (previous !== null && resetsAt > previous + SAME_WINDOW_MS && row.last_used_bp !== null) {
        const adjusted = adjustMargin(
          margin,
          row.last_used_bp,
          target,
          reachedAt === null ? null : Date.parse(reachedAt),
          previous,
        );
        if (adjusted.change !== "kept") {
          this.#journal(nowMs, "quota.pacing_margin_adjusted", {
            window: s.windowKey,
            change: adjusted.change,
            fromMargin: Number(margin.toFixed(4)),
            toMargin: Number(adjusted.margin.toFixed(4)),
            finalUsedBp: row.last_used_bp,
            targetBp: target,
            reachedAt,
            closedResetsAt: row.window_resets_at,
          });
        }
        margin = adjusted.margin;
        reachedAt = null;
      }
      if (reachedAt === null && s.usedBasisPoints >= target) reachedAt = utc(observedAt);
      this.db
        .prepare(
          `UPDATE quota_pacing SET margin_ratio = ?, window_resets_at = ?, last_used_bp = ?,
             reached_at = ?, updated_at = ?
           WHERE profile_id = ? AND adapter_id = ? AND window_key = ?`,
        )
        .run(
          margin,
          utc(resetsAt),
          s.usedBasisPoints,
          reachedAt,
          utc(nowMs),
          this.profileId,
          this.adapterId,
          s.windowKey,
        );
    }
  }

  /**
   * Débit mesuré sur une session : fenêtres identiques au début et à la fin, durée
   * suffisante, usage non décroissant. Journalise la mesure et la nouvelle projection.
   */
  recordSession(
    guard: EnabledGuard,
    start: readonly ProviderQuotaSnapshot[],
    end: readonly ProviderQuotaSnapshot[],
    startedAtMs: number,
    endedAtMs: number,
  ): void {
    const durationMs = endedAtMs - startedAtMs;
    if (durationMs < MIN_RATE_SAMPLE_MS) return;
    for (const before of start) {
      const after = end.find((e) => e.windowKey === before.windowKey);
      if (before.provenance !== "measured" || after?.provenance !== "measured") continue;
      if (Math.abs(Date.parse(after.resetsAt) - Date.parse(before.resetsAt)) > SAME_WINDOW_MS) {
        continue;
      }
      const delta = after.usedBasisPoints - before.usedBasisPoints;
      if (delta < 0) continue;
      const measured = delta / (durationMs / HOUR_MS);
      if (measured <= 0) continue;
      const row = this.#row(guard, before.windowKey, endedAtMs);
      const rate = smoothRate(row.rate_bp_per_hour, measured);
      this.db
        .prepare(
          `UPDATE quota_pacing SET rate_bp_per_hour = ?, samples = samples + 1, updated_at = ?
           WHERE profile_id = ? AND adapter_id = ? AND window_key = ?`,
        )
        .run(rate, utc(endedAtMs), this.profileId, this.adapterId, before.windowKey);
    }
    const plan = planPacing(guard, end, endedAtMs, this.estimates());
    if (plan === null) return;
    this.#journal(endedAtMs, "quota.pacing_rate_measured", {
      window: plan.windowKey,
      rateBpPerHour: Number(plan.rateBasisPointsPerHour.toFixed(2)),
      rateSource: plan.rateSource,
      projectedAtResetBp: plan.projectedAtResetBasisPoints,
      targetBp: plan.targetBasisPoints,
      behind: plan.projectedAtResetBasisPoints < plan.targetBasisPoints,
      plan: pacingDetail(plan),
    });
  }

  #journal(
    nowMs: number,
    reason: string,
    metadata: Record<string, string | number | boolean | null>,
  ): void {
    this.uow.journal.append(
      prepareJournalEvent({
        type: "action_allowed",
        at: utc(nowMs),
        profileId: this.profileId,
        reason,
        metadata: { action: "quota_pacing", adapterId: this.adapterId, ...metadata },
      }),
    );
  }
}
