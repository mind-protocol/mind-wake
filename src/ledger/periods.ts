/**
 * Calcul des bornes de période dans le fuseau configuré (SPEC §6). Les bornes sont
 * ensuite persistées en UTC : un changement d'heure ne modifie pas une période déjà
 * créée, il ne fait que déterminer la durée locale (23 h ou 25 h un jour de bascule).
 */

import type { BudgetPeriodDefinition } from "../contracts/index.js";

export const DEFAULT_WEEK_STARTS_ON = 1;

export interface PeriodBounds {
  readonly startsAtMs: number;
  readonly endsAtMs: number;
}

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const HOUR_MS = 3_600_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Refuse un fuseau que l'environnement ne connaît pas plutôt que de supposer UTC. */
export function assertTimeZone(timeZone: string): void {
  try {
    formatterFor(timeZone);
  } catch {
    throw new RangeError(`fuseau IANA inconnu : ${timeZone}`);
  }
}

function localDateAt(ms: number, timeZone: string): LocalDate {
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
  }
  return { year, month, day };
}

function dateKey(date: LocalDate): number {
  return date.year * 10_000 + date.month * 100 + date.day;
}

/** Ajoute des jours à une date civile, sans fuseau. */
function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Premier instant UTC dont la date locale atteint `date`. Gère les minuits absents
 * (bascule à 00:00) en retenant le premier instant existant de la journée.
 */
function startOfLocalDate(date: LocalDate, timeZone: string): number {
  const target = dateKey(date);
  const naive = Date.UTC(date.year, date.month - 1, date.day);
  // Les décalages existants sont compris entre −12 h et +14 h.
  let lo = naive - 15 * HOUR_MS;
  let hi = naive + 13 * HOUR_MS;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dateKey(localDateAt(mid, timeZone)) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

function firstDayOfPeriod(definition: BudgetPeriodDefinition, local: LocalDate): LocalDate {
  switch (definition.kind) {
    case "day":
      return local;
    case "week": {
      const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
      const startsOn = definition.weekStartsOn ?? DEFAULT_WEEK_STARTS_ON;
      return addDays(local, -((weekday - startsOn + 7) % 7));
    }
    case "month":
      return { year: local.year, month: local.month, day: 1 };
  }
}

function firstDayOfNextPeriod(definition: BudgetPeriodDefinition, first: LocalDate): LocalDate {
  switch (definition.kind) {
    case "day":
      return addDays(first, 1);
    case "week":
      return addDays(first, 7);
    case "month": {
      const d = new Date(Date.UTC(first.year, first.month, 1));
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: 1 };
    }
  }
}

/** Bornes [début, fin) de la période qui contient l'instant `atMs`. */
export function periodBoundsAt(definition: BudgetPeriodDefinition, atMs: number): PeriodBounds {
  assertTimeZone(definition.timeZone);
  const first = firstDayOfPeriod(definition, localDateAt(atMs, definition.timeZone));
  const next = firstDayOfNextPeriod(definition, first);
  return {
    startsAtMs: startOfLocalDate(first, definition.timeZone),
    endsAtMs: startOfLocalDate(next, definition.timeZone),
  };
}

/**
 * Toutes les périodes qu'une session commencée à `startMs` et bornée à `maxDurationMs`
 * peut toucher : sa réservation doit être couverte dans chacune (SPEC §6).
 */
export function periodBoundsCovering(
  definition: BudgetPeriodDefinition,
  startMs: number,
  maxDurationMs: number,
): readonly PeriodBounds[] {
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 0) {
    throw new RangeError(`durée maximale invalide : ${String(maxDurationMs)}`);
  }
  const endMs = startMs + maxDurationMs;
  const bounds: PeriodBounds[] = [];
  let current = periodBoundsAt(definition, startMs);
  bounds.push(current);
  while (current.endsAtMs <= endMs) {
    current = periodBoundsAt(definition, current.endsAtMs);
    bounds.push(current);
  }
  return bounds;
}
