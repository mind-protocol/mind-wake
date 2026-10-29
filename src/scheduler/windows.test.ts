import { describe, expect, it } from "vitest";
import type { WeeklyWindow } from "../contracts/index.js";
import { isWindowOpen, nextWindowOpening } from "./windows.js";

const PARIS = "Europe/Paris";
const ms = (value: string): number => Date.parse(value);
const at = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const THURSDAY: WeeklyWindow[] = [{ day: 4, start: "09:00", end: "17:00" }];
const EVERY_DAY: WeeklyWindow[] = ([0, 1, 2, 3, 4, 5, 6] as const).map((day) => ({
  day,
  start: "09:00",
  end: "17:00",
}));

describe("fenêtres hebdomadaires dans le fuseau IANA", () => {
  it("évalue l'heure locale, pas l'heure UTC", () => {
    // Jeudi 29 octobre 2026 : Paris est en UTC+1.
    expect(isWindowOpen(THURSDAY, PARIS, ms("2026-10-29T08:00:00Z"))).toBe(true); // 09:00
    expect(isWindowOpen(THURSDAY, PARIS, ms("2026-10-29T07:59:59Z"))).toBe(false); // 08:59
    expect(isWindowOpen(THURSDAY, PARIS, ms("2026-10-29T16:00:00Z"))).toBe(false); // 17:00 exclu
    expect(isWindowOpen(THURSDAY, "America/New_York", ms("2026-10-29T13:00:00Z"))).toBe(true);
  });

  it("donne la prochaine ouverture en UTC", () => {
    expect(at(nextWindowOpening(EVERY_DAY, PARIS, ms("2026-10-29T17:00:00Z")))).toBe(
      "2026-10-30T08:00:00.000Z",
    );
    expect(at(nextWindowOpening(EVERY_DAY, PARIS, ms("2026-10-29T10:00:00Z")))).toBe(
      "2026-10-29T10:00:00.000Z",
    );
    expect(nextWindowOpening([], PARIS, ms("2026-10-29T10:00:00Z"))).toBeNull();
  });

  it("suit le changement de décalage d'un week-end de retour à l'heure d'hiver", () => {
    // Vendredi 23 octobre 18:00 CEST ; lundi 26 octobre 09:00 CET = 08:00Z, pas 07:00Z.
    const monday: WeeklyWindow[] = [{ day: 1, start: "09:00", end: "17:00" }];
    expect(at(nextWindowOpening(monday, PARIS, ms("2026-10-23T16:00:00Z")))).toBe(
      "2026-10-26T08:00:00.000Z",
    );
  });

  it("ouvre au premier instant existant une fenêtre qui commence dans l'heure absente", () => {
    // 29 mars 2026 : 02:00 CET → 03:00 CEST. Une fenêtre 02:30–04:00 s'ouvre à 01:00Z.
    const sunday: WeeklyWindow[] = [{ day: 0, start: "02:30", end: "04:00" }];
    expect(at(nextWindowOpening(sunday, PARIS, ms("2026-03-28T12:00:00Z")))).toBe(
      "2026-03-29T01:00:00.000Z",
    );
    expect(isWindowOpen(sunday, PARIS, ms("2026-03-29T00:59:59Z"))).toBe(false);
    expect(isWindowOpen(sunday, PARIS, ms("2026-03-29T01:00:00Z"))).toBe(true);
  });

  it("saute une fenêtre entièrement contenue dans l'heure absente", () => {
    const sunday: WeeklyWindow[] = [{ day: 0, start: "02:00", end: "03:00" }];
    // Le dimanche suivant, 02:00 CEST = 00:00Z.
    expect(at(nextWindowOpening(sunday, PARIS, ms("2026-03-28T12:00:00Z")))).toBe(
      "2026-04-05T00:00:00.000Z",
    );
  });

  it("couvre les deux occurrences d'une heure répétée au retour à l'heure d'hiver", () => {
    // 25 octobre 2026 : 03:00 CEST → 02:00 CET ; 02:00–03:00 locales existent deux fois.
    const sunday: WeeklyWindow[] = [{ day: 0, start: "02:00", end: "02:30" }];
    expect(at(nextWindowOpening(sunday, PARIS, ms("2026-10-24T12:00:00Z")))).toBe(
      "2026-10-25T00:00:00.000Z",
    );
    expect(isWindowOpen(sunday, PARIS, ms("2026-10-25T00:15:00Z"))).toBe(true); // 02:15 CEST
    expect(isWindowOpen(sunday, PARIS, ms("2026-10-25T00:45:00Z"))).toBe(false); // 02:45 CEST
    expect(isWindowOpen(sunday, PARIS, ms("2026-10-25T01:15:00Z"))).toBe(true); // 02:15 CET
  });

  it("accepte 24:00 comme fin de journée", () => {
    const late: WeeklyWindow[] = [{ day: 4, start: "22:00", end: "24:00" }];
    expect(isWindowOpen(late, PARIS, ms("2026-10-29T22:59:59Z"))).toBe(true);
    expect(isWindowOpen(late, PARIS, ms("2026-10-29T23:00:00Z"))).toBe(false);
  });

  it("refuse un fuseau inconnu ou une fenêtre mal formée plutôt que de supposer", () => {
    expect(() => isWindowOpen(THURSDAY, "Mars/Olympus", 0)).toThrow(RangeError);
    expect(() => isWindowOpen([{ day: 4, start: "17:00", end: "09:00" }], PARIS, 0)).toThrow(
      RangeError,
    );
  });
});
