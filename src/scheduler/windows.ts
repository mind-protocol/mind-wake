/**
 * Fenêtres hebdomadaires évaluées dans le fuseau IANA de la policy (SPEC §5.2).
 * Une fenêtre `[start, end)` s'applique à l'heure locale murale :
 * - au passage à l'heure d'été, les minutes locales absentes n'existent pas : une
 *   fenêtre qui commence dans le trou s'ouvre au premier instant existant après lui,
 *   une fenêtre entièrement dans le trou n'existe pas ce jour-là ;
 * - au retour à l'heure d'hiver, les minutes répétées le sont aussi : une fenêtre qui
 *   les couvre dure une heure réelle de plus, et s'ouvre à leur première occurrence.
 * Les échéances calculées ici sont des instants UTC, persistables tels quels.
 */

import type { WeeklyWindow } from "../contracts/index.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly minuteOfDay: number;
  /** Heure locale lue comme si elle était UTC, en millisecondes (à la seconde près). */
  readonly naiveMs: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      throw new RangeError(`fuseau IANA inconnu : ${timeZone}`);
    }
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function localParts(ms: number, timeZone: string): LocalParts {
  const values: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const year = values["year"] ?? 0;
  const month = values["month"] ?? 0;
  const day = values["day"] ?? 0;
  const hour = values["hour"] ?? 0;
  const minute = values["minute"] ?? 0;
  const second = values["second"] ?? 0;
  return {
    year,
    month,
    day,
    minuteOfDay: hour * 60 + minute,
    naiveMs: Date.UTC(year, month - 1, day, hour, minute, second),
  };
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Minutes depuis minuit ; `24:00` n'est accepté qu'en fin de fenêtre. */
export function parseWindowTime(value: string, endOfWindow: boolean): number | null {
  if (endOfWindow && value === "24:00") return 1440;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match === null) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

interface ParsedWindow {
  readonly day: number;
  readonly start: number;
  readonly end: number;
}

function parseWindows(windows: readonly WeeklyWindow[]): readonly ParsedWindow[] {
  return windows.map((w) => {
    const start = parseWindowTime(w.start, false);
    const end = parseWindowTime(w.end, true);
    if (start === null || end === null || start >= end || !Number.isInteger(w.day)) {
      throw new RangeError(`fenêtre invalide : ${JSON.stringify(w)}`);
    }
    return { day: w.day, start, end };
  });
}

/** Vrai si l'heure locale de `atMs` tombe dans l'une des fenêtres. */
export function isWindowOpen(
  windows: readonly WeeklyWindow[],
  timeZone: string,
  atMs: number,
): boolean {
  const parsed = parseWindows(windows);
  const local = localParts(atMs, timeZone);
  const weekday = weekdayOf(local.year, local.month, local.day);
  return parsed.some(
    (w) => w.day === weekday && w.start <= local.minuteOfDay && local.minuteOfDay < w.end,
  );
}

/**
 * Premier instant UTC dont l'heure locale atteint `naiveTarget` (heure locale lue comme
 * UTC). Pour une heure répétée, la première occurrence ; pour une heure absente, le
 * premier instant existant après le trou.
 */
function firstInstantAtLocal(naiveTarget: number, timeZone: string): number {
  const offsetAt = (ms: number): number => localParts(ms, timeZone).naiveMs - ms;
  const offsets = [...new Set([offsetAt(naiveTarget - DAY_MS), offsetAt(naiveTarget + DAY_MS)])];
  const exact = offsets
    .map((offset) => naiveTarget - offset)
    .filter((ms) => localParts(ms, timeZone).naiveMs === naiveTarget)
    .sort((a, b) => a - b);
  if (exact[0] !== undefined) return exact[0];
  // Heure absente : recherche du premier instant dont l'heure locale dépasse la cible,
  // entre les deux interprétations possibles (l'heure locale y est croissante).
  let lo = naiveTarget - Math.max(...offsets) - MINUTE_MS;
  let hi = naiveTarget - Math.min(...offsets) + MINUTE_MS;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localParts(mid, timeZone).naiveMs >= naiveTarget) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Prochain instant UTC, à partir de `fromMs` inclus, où une fenêtre est ouverte.
 * `fromMs` lui-même s'il est déjà dans une fenêtre ; `null` sans aucune fenêtre
 * utilisable dans les huit jours locaux suivants.
 */
export function nextWindowOpening(
  windows: readonly WeeklyWindow[],
  timeZone: string,
  fromMs: number,
): number | null {
  const parsed = parseWindows(windows);
  if (parsed.length === 0) return null;
  if (isWindowOpen(windows, timeZone, fromMs)) return fromMs;
  const today = localParts(fromMs, timeZone);
  let best: number | null = null;
  for (let offset = 0; offset <= 8; offset++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const weekday = date.getUTCDay();
    for (const w of parsed) {
      if (w.day !== weekday) continue;
      const candidate = firstInstantAtLocal(date.getTime() + w.start * MINUTE_MS, timeZone);
      if (candidate <= fromMs || (best !== null && candidate >= best)) continue;
      // Une fenêtre entièrement dans une heure absente ne s'ouvre pas ce jour-là.
      if (isWindowOpen(windows, timeZone, candidate)) best = candidate;
    }
    if (best !== null) return best;
  }
  return best;
}
