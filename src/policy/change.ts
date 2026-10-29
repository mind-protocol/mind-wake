/**
 * Classement d'une révision par rapport à une autre : chaque champ est soit élargi, soit
 * restreint, soit inchangé. En cas de doute (changement non ordonnable), le champ compte
 * comme un élargissement : il exige alors un consentement humain avant de s'appliquer.
 */

import type { PolicyChangeKind, PolicyGroups, WeeklyWindow } from "../contracts/policy.js";
import { parseHhMm } from "./validate.js";

export interface ChangeSummary {
  readonly kind: PolicyChangeKind | "unchanged";
  /** Champs `groupe.champ` élargis ou modifiés sans ordre (consentement requis). */
  readonly widened: readonly string[];
  /** Champs restreints : appliqués immédiatement, y compris aux sessions actives. */
  readonly restricted: readonly string[];
}

/** Plus grand = plus permissif. */
const HIGHER_IS_WIDER = [
  ["schedule", "maxSessionDurationMs"],
  ["humanPriority", "maxSignalAgeMs"],
  ["humanPriority", "maxInterruptLatencyMs"],
  ["humanPriority", "maxTerminationLatencyMs"],
  ["budget", "tokensPerSession"],
  ["budget", "tokensPerPeriod"],
  ["budget", "sessionsPerPeriod"],
  ["filesAndTools", "maxProcesses"],
  ["filesAndTools", "maxStorageBytes"],
  ["data", "eventRetentionDays"],
  ["data", "localStorageCapBytes"],
] as const;

/** Plus grand = plus protecteur pour l'humain. */
const HIGHER_IS_NARROWER = [
  ["schedule", "minIntervalBetweenSessionsMs"],
  ["humanPriority", "idleThresholdMs"],
  ["budget", "userReserveTokens"],
  ["budget", "checkpointTokens"],
] as const;

/** Tout changement de ces champs est un élargissement (substitution, changement de règle). */
const ANY_CHANGE_IS_WIDENING = [
  ["identity", "profileId"],
  ["identity", "agentId"],
  ["runtime", "adapterId"],
  ["runtime", "provider"],
  ["runtime", "model"],
  ["runtime", "authMode"],
  ["schedule", "timeZone"],
  ["humanPriority", "activitySignal"],
  ["budget", "period"],
  ["data", "purge"],
] as const;

/** Ensembles : un ajout élargit, un retrait restreint. */
const SETS = [
  ["filesAndTools", "readRoots"],
  ["filesAndTools", "writeRoots"],
  ["filesAndTools", "allowedExecutables"],
  ["data", "exportPaths"],
] as const;

function get(groups: PolicyGroups, group: string, name: string): unknown {
  return (groups as unknown as Record<string, Record<string, unknown>>)[group]?.[name];
}

/** JSON à clés triées : base des empreintes et des comparaisons. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function compareSets(
  path: string,
  before: readonly string[],
  after: readonly string[],
  widened: string[],
  restricted: string[],
): void {
  const b = new Set(before);
  const a = new Set(after);
  if ([...a].some((x) => !b.has(x))) widened.push(path);
  if ([...b].some((x) => !a.has(x))) restricted.push(path);
}

function destinationKeys(groups: PolicyGroups, name: keyof PolicyGroups["network"]): string[] {
  return groups.network[name].flatMap((d) =>
    d.ports.map((port) => `${d.host}:${String(port)}:${d.purpose}`),
  );
}

/** Minutes de la semaine couvertes par les fenêtres. */
function coverage(windows: readonly WeeklyWindow[]): Set<number> {
  const minutes = new Set<number>();
  for (const w of windows) {
    const start = parseHhMm(w.start, false) ?? 0;
    const end = parseHhMm(w.end, true) ?? 0;
    for (let m = start; m < end; m++) minutes.add(w.day * 1440 + m);
  }
  return minutes;
}

export function classifyChange(before: PolicyGroups | null, after: PolicyGroups): ChangeSummary {
  if (before === null) return { kind: "initial", widened: [], restricted: [] };
  const widened: string[] = [];
  const restricted: string[] = [];

  const UNLIMITED_FIELDS = new Set([
    "schedule.maxSessionDurationMs",
    "budget.tokensPerSession",
    "budget.tokensPerPeriod",
    "budget.sessionsPerPeriod",
  ]);
  for (const [g, f] of HIGHER_IS_WIDER) {
    const b = get(before, g, f) as number;
    const a = get(after, g, f) as number;
    // 0 = sans limite locale : passer à 0 élargit, quitter 0 restreint.
    const unlimitedField = UNLIMITED_FIELDS.has(`${g}.${f}`);
    if (unlimitedField && a !== b && (a === 0 || b === 0)) {
      (a === 0 ? widened : restricted).push(`${g}.${f}`);
      continue;
    }
    if (a > b) widened.push(`${g}.${f}`);
    if (a < b) restricted.push(`${g}.${f}`);
  }
  for (const [g, f] of HIGHER_IS_NARROWER) {
    const b = get(before, g, f) as number;
    const a = get(after, g, f) as number;
    if (a < b) widened.push(`${g}.${f}`);
    if (a > b) restricted.push(`${g}.${f}`);
  }
  for (const [g, f] of ANY_CHANGE_IS_WIDENING) {
    if (canonicalJson(get(before, g, f)) !== canonicalJson(get(after, g, f)))
      widened.push(`${g}.${f}`);
  }
  for (const [g, f] of SETS) {
    compareSets(
      `${g}.${f}`,
      get(before, g, f) as readonly string[],
      get(after, g, f) as readonly string[],
      widened,
      restricted,
    );
  }
  for (const name of ["explorationDestinations", "providerTransportDestinations"] as const) {
    compareSets(
      `network.${name}`,
      destinationKeys(before, name),
      destinationKeys(after, name),
      widened,
      restricted,
    );
  }

  const bw = coverage(before.schedule.weeklyWindows);
  const aw = coverage(after.schedule.weeklyWindows);
  if ([...aw].some((m) => !bw.has(m))) widened.push("schedule.weeklyWindows");
  if ([...bw].some((m) => !aw.has(m))) restricted.push("schedule.weeklyWindows");

  comparePaidApi(before, after, widened, restricted);
  compareSubscriptionQuota(before, after, widened, restricted);
  // Mode non isolé (ADR-006) : l'accorder élargit, le retirer restreint.
  const hostBefore = before.runtime.hostUnsandboxedAcknowledged === true;
  const hostAfter = after.runtime.hostUnsandboxedAcknowledged === true;
  if (!hostBefore && hostAfter) widened.push("runtime.hostUnsandboxedAcknowledged");
  if (hostBefore && !hostAfter) restricted.push("runtime.hostUnsandboxedAcknowledged");

  if (before.runtime.nativeCapabilities !== after.runtime.nativeCapabilities) {
    (after.runtime.nativeCapabilities === true ? widened : restricted).push("runtime.nativeCapabilities");
  }
  const kind: ChangeSummary["kind"] =
    widened.length > 0 && restricted.length > 0
      ? "mixed"
      : widened.length > 0
        ? "widening"
        : restricted.length > 0
          ? "restriction"
          : "unchanged";
  return { kind, widened, restricted };
}

function comparePaidApi(
  before: PolicyGroups,
  after: PolicyGroups,
  widened: string[],
  restricted: string[],
): void {
  const b = before.budget.paidApi;
  const a = after.budget.paidApi;
  if (!b.authorized && !a.authorized) return;
  if (!b.authorized) {
    widened.push("budget.paidApi");
    return;
  }
  if (!a.authorized) {
    restricted.push("budget.paidApi");
    return;
  }
  if (a.provider !== b.provider || a.currency !== b.currency) {
    widened.push("budget.paidApi");
    return;
  }
  if (a.perSessionCapMinor > b.perSessionCapMinor || a.perPeriodCapMinor > b.perPeriodCapMinor) {
    widened.push("budget.paidApi");
  }
  if (a.perSessionCapMinor < b.perSessionCapMinor || a.perPeriodCapMinor < b.perPeriodCapMinor) {
    restricted.push("budget.paidApi");
  }
}

/** Voie abonnement : absente ou désactivée = fermée ; un seuil plus permissif élargit. */
function compareSubscriptionQuota(
  before: PolicyGroups,
  after: PolicyGroups,
  widened: string[],
  restricted: string[],
): void {
  const path = "budget.subscriptionQuota";
  const b = before.budget.subscriptionQuota;
  const a = after.budget.subscriptionQuota;
  const bOn = b?.enabled === true ? b : null;
  const aOn = a?.enabled === true ? a : null;
  if (bOn === null && aOn === null) return;
  if (bOn === null) {
    widened.push(path);
    return;
  }
  if (aOn === null) {
    restricted.push(path);
    return;
  }
  // Dépassement : null (non mesuré) bloque le lancement, donc null → valeur élargit.
  const overshoot = (v: number | null): number => v ?? Number.NEGATIVE_INFINITY;
  const wider =
    (aOn.providerLimitsOnly === true && bOn.providerLimitsOnly !== true) ||
    aOn.startBelowBasisPoints > bOn.startBelowBasisPoints ||
    aOn.stopAtBasisPoints > bOn.stopAtBasisPoints ||
    aOn.userReserveBasisPoints < bOn.userReserveBasisPoints ||
    overshoot(aOn.overshootBoundBasisPoints) > overshoot(bOn.overshootBoundBasisPoints) ||
    aOn.maxSnapshotAgeMs > bOn.maxSnapshotAgeMs ||
    aOn.targetUsageBasisPoints > bOn.targetUsageBasisPoints ||
    // Débit supposé plus lent ou marge plus grande : réveil plus tôt, plus de sessions.
    aOn.initialRateBasisPointsPerHour < bOn.initialRateBasisPointsPerHour ||
    aOn.pacingMarginRatio > bOn.pacingMarginRatio;
  const narrower =
    (bOn.providerLimitsOnly === true && aOn.providerLimitsOnly !== true) ||
    aOn.startBelowBasisPoints < bOn.startBelowBasisPoints ||
    aOn.stopAtBasisPoints < bOn.stopAtBasisPoints ||
    aOn.userReserveBasisPoints > bOn.userReserveBasisPoints ||
    overshoot(aOn.overshootBoundBasisPoints) < overshoot(bOn.overshootBoundBasisPoints) ||
    aOn.maxSnapshotAgeMs < bOn.maxSnapshotAgeMs ||
    aOn.targetUsageBasisPoints < bOn.targetUsageBasisPoints ||
    aOn.initialRateBasisPointsPerHour > bOn.initialRateBasisPointsPerHour ||
    aOn.pacingMarginRatio < bOn.pacingMarginRatio;
  if (wider) widened.push(path);
  if (narrower) restricted.push(path);
}
