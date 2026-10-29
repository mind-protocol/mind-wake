/**
 * Règles de rétention et de purge du journal (logique seulement ; l'exécution de la
 * purge et l'export relèvent de S9).
 *
 * Règles :
 * - la purge retire uniquement un préfixe de séquence : jamais de trou au milieu du
 *   journal, la séquence restante reste continue ;
 * - un événement est expiré si `at < now − retentionDays` ;
 * - le préfixe s'arrête au premier événement non expiré, à horodatage illisible ou lié
 *   à une session protégée (session encore ouverte, réservation incertaine…) ;
 * - une durée de rétention invalide n'autorise aucune purge ;
 * - en mode `manual`, la purge n'est jamais appliquée automatiquement.
 */

import type { DataGroup, JournalEvent, SessionId, UtcTimestamp } from "../contracts/index.js";

const DAY_MS = 86_400_000;

export interface RetentionRule {
  readonly retentionDays: number;
  /** `true` si la policy autorise l'application automatique (`retention_only`). */
  readonly automatic: boolean;
}

export type RetentionRuleResult =
  | { readonly valid: true; readonly rule: RetentionRule }
  | { readonly valid: false; readonly detail: string };

export function retentionRuleFromPolicy(data: DataGroup): RetentionRuleResult {
  const days = data.eventRetentionDays;
  if (!Number.isSafeInteger(days) || days < 1) {
    return {
      valid: false,
      detail: `durée de rétention invalide (${String(days)}) : entier ≥ 1 jour attendu, aucune purge`,
    };
  }
  return { valid: true, rule: { retentionDays: days, automatic: data.purge === "retention_only" } };
}

export interface PurgePlanOptions {
  readonly now: Date;
  readonly protectedSessionIds?: ReadonlySet<SessionId>;
}

export type PurgeStop =
  | { readonly kind: "not_expired"; readonly sequence: number }
  | { readonly kind: "unreadable_timestamp"; readonly sequence: number }
  | { readonly kind: "protected_session"; readonly sequence: number; readonly sessionId: SessionId }
  | { readonly kind: "end_of_journal" };

export interface PurgePlan {
  readonly cutoff: UtcTimestamp;
  /** Dernière séquence à purger (incluse), ou `null` si rien n'est purgeable. */
  readonly throughSequence: number | null;
  readonly purgeCount: number;
  readonly keptCount: number;
  readonly automatic: boolean;
  readonly stoppedBy: PurgeStop;
}

/**
 * Calcule le préfixe purgeable d'un journal. `events` peut être dans n'importe quel
 * ordre : il est trié par séquence. Aucun effet de bord.
 */
export function planJournalPurge(
  events: readonly JournalEvent[],
  rule: RetentionRule,
  options: PurgePlanOptions,
): PurgePlan {
  const nowMs = options.now.getTime();
  if (Number.isNaN(nowMs)) throw new RangeError("horloge invalide : aucune purge possible");
  const cutoffMs = nowMs - rule.retentionDays * DAY_MS;
  const cutoff = new Date(cutoffMs).toISOString() as UtcTimestamp;
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);

  let throughSequence: number | null = null;
  let purgeCount = 0;
  let stoppedBy: PurgeStop = { kind: "end_of_journal" };
  for (const event of sorted) {
    const atMs = Date.parse(event.at);
    if (Number.isNaN(atMs)) {
      stoppedBy = { kind: "unreadable_timestamp", sequence: event.sequence };
      break;
    }
    if (atMs >= cutoffMs) {
      stoppedBy = { kind: "not_expired", sequence: event.sequence };
      break;
    }
    if (event.sessionId !== undefined && options.protectedSessionIds?.has(event.sessionId)) {
      stoppedBy = {
        kind: "protected_session",
        sequence: event.sequence,
        sessionId: event.sessionId,
      };
      break;
    }
    throughSequence = event.sequence;
    purgeCount += 1;
  }
  return {
    cutoff,
    throughSequence,
    purgeCount,
    keptCount: sorted.length - purgeCount,
    automatic: rule.automatic,
    stoppedBy,
  };
}
