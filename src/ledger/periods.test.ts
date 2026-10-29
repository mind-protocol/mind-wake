import { describe, expect, it } from "vitest";
import type { BudgetPeriodDefinition, IanaTimeZone } from "../contracts/index.js";
import { periodBoundsAt, periodBoundsCovering } from "./periods.js";

const tz = (name: string): IanaTimeZone => name as IanaTimeZone;
const iso = (ms: number): string => new Date(ms).toISOString();
const at = (value: string): number => Date.parse(value);

function bounds(definition: BudgetPeriodDefinition, instant: string): [string, string] {
  const b = periodBoundsAt(definition, at(instant));
  return [iso(b.startsAtMs), iso(b.endsAtMs)];
}

describe("bornes de période", () => {
  const dayParis: BudgetPeriodDefinition = { kind: "day", timeZone: tz("Europe/Paris") };

  it("calcule un jour local ordinaire en UTC", () => {
    expect(bounds(dayParis, "2026-10-29T12:00:00Z")).toEqual([
      "2026-10-28T23:00:00.000Z",
      "2026-10-29T23:00:00.000Z",
    ]);
  });

  it("donne 25 h au jour de retour à l'heure d'hiver (25 octobre 2026, Paris)", () => {
    const [start, end] = bounds(dayParis, "2026-10-25T12:00:00Z");
    expect([start, end]).toEqual(["2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z"]);
    expect(Date.parse(end) - Date.parse(start)).toBe(25 * 3_600_000);
  });

  it("donne 23 h au jour de passage à l'heure d'été (29 mars 2026, Paris)", () => {
    const [start, end] = bounds(dayParis, "2026-03-29T12:00:00Z");
    expect(Date.parse(end) - Date.parse(start)).toBe(23 * 3_600_000);
  });

  it("garde la même période de part et d'autre de la bascule d'heure", () => {
    // 01:30 heure d'été puis 02:30 heure d'hiver, le même jour local.
    expect(bounds(dayParis, "2026-10-24T23:30:00Z")).toEqual(
      bounds(dayParis, "2026-10-25T01:30:00Z"),
    );
  });

  it("gère un minuit absent (Santiago, passage à l'heure d'été à 00:00)", () => {
    const santiago: BudgetPeriodDefinition = { kind: "day", timeZone: tz("America/Santiago") };
    // 6 septembre 2026 : 00:00 → 01:00 ; le jour commence à 01:00 locale (04:00 UTC).
    const [start, end] = bounds(santiago, "2026-09-06T15:00:00Z");
    expect(start).toBe("2026-09-06T04:00:00.000Z");
    expect(Date.parse(end) - Date.parse(start)).toBe(23 * 3_600_000);
  });

  it("calcule une semaine commençant le lundi par défaut, ou le dimanche", () => {
    const monday: BudgetPeriodDefinition = { kind: "week", timeZone: tz("UTC") };
    expect(bounds(monday, "2026-10-29T12:00:00Z")).toEqual([
      "2026-10-26T00:00:00.000Z",
      "2026-11-02T00:00:00.000Z",
    ]);
    const sunday: BudgetPeriodDefinition = { kind: "week", timeZone: tz("UTC"), weekStartsOn: 0 };
    expect(bounds(sunday, "2026-10-29T12:00:00Z")[0]).toBe("2026-10-25T00:00:00.000Z");
  });

  it("calcule un mois local, y compris décembre → janvier", () => {
    const month: BudgetPeriodDefinition = { kind: "month", timeZone: tz("America/New_York") };
    expect(bounds(month, "2026-12-15T12:00:00Z")).toEqual([
      "2026-12-01T05:00:00.000Z",
      "2027-01-01T05:00:00.000Z",
    ]);
  });

  it("refuse un fuseau inconnu au lieu de supposer UTC", () => {
    expect(() => periodBoundsAt({ kind: "day", timeZone: tz("Mars/Olympus") }, Date.now())).toThrow(
      /fuseau IANA inconnu/,
    );
  });

  it("couvre chaque période qu'une session peut traverser", () => {
    const covering = periodBoundsCovering(dayParis, at("2026-10-29T22:30:00Z"), 2 * 3_600_000);
    expect(covering.map((b) => iso(b.startsAtMs))).toEqual([
      "2026-10-28T23:00:00.000Z",
      "2026-10-29T23:00:00.000Z",
    ]);
    expect(periodBoundsCovering(dayParis, at("2026-10-29T12:00:00Z"), 3_600_000)).toHaveLength(1);
  });
});
