import { describe, expect, it } from "vitest";
import { FakeClock } from "./clock.js";
import { IdlePrioritySignal, ManualPrioritySignal, windowsIdleSource } from "./priority.js";

const NOW = Date.parse("2026-10-29T09:00:00Z");

describe("signal de priorité humaine", () => {
  it("implémentation de test : favorable, défavorable, absente ou en erreur", async () => {
    const signal = new ManualPrioritySignal();
    expect(await signal.read()).toBeUndefined();
    signal.set(false, NOW);
    expect(await signal.read()).toEqual({
      favorable: false,
      observedAt: "2026-10-29T09:00:00.000Z",
    });
    signal.fail(new Error("capteur"));
    await expect(signal.read()).rejects.toThrow("capteur");
  });

  it("inactivité : favorable au-delà du seuil, datée à la lecture, absente si incohérente", async () => {
    const clock = new FakeClock(NOW);
    let idle = 30_000;
    const signal = new IdlePrioritySignal({ idleMs: () => Promise.resolve(idle) }, clock, 60_000);
    expect(await signal.read()).toEqual({
      favorable: false,
      observedAt: "2026-10-29T09:00:00.000Z",
    });
    idle = 60_000;
    expect((await signal.read())?.favorable).toBe(true);
    idle = -1;
    expect(await signal.read()).toBeUndefined();
  });

  it.runIf(process.platform === "win32")(
    "Windows : GetLastInputInfo donne une durée d'inactivité, sans droits admin",
    async () => {
      const idle = await windowsIdleSource(30_000).idleMs();
      expect(Number.isSafeInteger(idle)).toBe(true);
      expect(idle).toBeGreaterThanOrEqual(0);
    },
    40_000,
  );
});
