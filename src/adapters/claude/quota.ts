/**
 * Jauge de quota d'abonnement Claude par le mécanisme documenté : la commande `/usage`
 * envoyée comme prompt à `claude -p` renvoie un message assistant portant `usage_report`
 * (`SDKUsageReport`, type déclaré expérimental), dont `rate_limits.limits` donne pour
 * chaque compteur la part utilisée (`percent`, 0-100) et `resets_at` (ISO 8601). Le champ
 * n'est présent qu'avec une connexion claude.ai portant un type de forfait connu ou la
 * portée `user:profile`, hors facturation à l'usage. Aucun endpoint privé n'est lu.
 */

import type { DurationMs, ProviderQuotaSnapshot, UtcTimestamp } from "../../contracts/index.js";
import type { ClaudeUsageLimitRow } from "./stream.js";

const HOUR_MS = 3_600_000;

/**
 * Durée des fenêtres : la documentation de la status line décrit une fenêtre glissante de
 * 5 heures (`five_hour`) et une fenêtre hebdomadaire (`seven_day`). `usage_report` nomme
 * ses compteurs `session`, `weekly_all`, `weekly_scoped` (« such as ») : seules ces formes
 * sont reconnues ; tout autre compteur est rapporté comme non interprété.
 */
export function windowDurationFor(kind: string): DurationMs | null {
  if (/^(session|five_hour)$/i.test(kind)) return 5 * HOUR_MS;
  if (/^(weekly|seven_day)/i.test(kind)) return 7 * 24 * HOUR_MS;
  return null;
}

export interface ClaudeQuotaReading {
  readonly snapshots: readonly ProviderQuotaSnapshot[];
  /** Compteurs reçus mais non interprétés (durée de fenêtre inconnue, date absente). */
  readonly unmapped: readonly string[];
  /** Raison d'une lecture impossible ; `snapshots` est alors vide. */
  readonly unavailable?: string;
}

/** Convertit les lignes de `usage_report` en relevés `measured` (lecture officielle). */
export function quotaSnapshots(
  rows: readonly ClaudeUsageLimitRow[],
  observedAt: UtcTimestamp,
): ClaudeQuotaReading {
  const snapshots: ProviderQuotaSnapshot[] = [];
  const unmapped: string[] = [];
  for (const row of rows) {
    const duration = windowDurationFor(row.kind);
    const resets = row.resetsAt === null ? Number.NaN : Date.parse(row.resetsAt);
    const windowKey = row.scope === null ? row.kind : `${row.kind}:${row.scope}`;
    if (duration === null || !Number.isFinite(resets)) {
      unmapped.push(windowKey);
      continue;
    }
    snapshots.push({
      windowKey: `claude:${windowKey}`,
      windowDurationMs: duration,
      // Arrondi vers le haut (contrat), sans compter le bruit flottant (0.1 × 100).
      usedBasisPoints: Math.min(10_000, Math.max(0, Math.ceil(row.percent * 100 - 1e-6))),
      resetsAt: new Date(resets).toISOString() as UtcTimestamp,
      observedAt,
      provenance: "measured",
    });
  }
  return { snapshots, unmapped };
}
