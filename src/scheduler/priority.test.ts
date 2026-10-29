import { describe, expect, it } from "vitest";
import { FakeClock } from "./clock.js";
import {
  IdlePrioritySignal,
  ManualPrioritySignal,
  WatchedPrioritySignal,
  pollingIdleWatcher,
  windowsIdleSource,
  windowsIdleWatcher,
} from "./priority.js";

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

describe("signal d'activité observé en continu (daemon en mode réel)", () => {
  const THRESHOLD = 60_000;

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it("actif, inactif, illisible : défavorable, favorable, absent", async () => {
    let idle: number | Error = 5_000;
    let now = NOW;
    const watcher = pollingIdleWatcher(
      {
        idleMs: () => (idle instanceof Error ? Promise.reject(idle) : Promise.resolve(idle)),
      },
      10,
      () => now,
    );
    const signal = new WatchedPrioritySignal(watcher, () => THRESHOLD);
    try {
      await settle();
      // Humain actif (dernière entrée il y a 5 s) : défavorable.
      expect(signal.current()).toEqual({ favorable: false, observedAt: iso(NOW) });
      idle = 120_000;
      now = NOW + 1_000;
      await settle();
      expect(signal.current()).toEqual({ favorable: true, observedAt: iso(NOW + 1_000) });
      // Source illisible : l'observation n'avance plus et vieillit.
      idle = new Error("GetLastInputInfo en échec");
      now = NOW + 120_000;
      await settle();
      expect(signal.current()?.observedAt).toBe(iso(NOW + 1_000));
    } finally {
      watcher.close();
    }
    const never = pollingIdleWatcher({ idleMs: () => Promise.reject(new Error("x")) }, 10);
    try {
      await settle();
      expect(new WatchedPrioritySignal(never, () => THRESHOLD).current()).toBeUndefined();
    } finally {
      never.close();
    }
  });

  it("périmé ou sans seuil connu : la policy ne l'accepte pas comme favorable", async () => {
    const watcher = pollingIdleWatcher({ idleMs: () => Promise.resolve(600_000) }, 10, () => NOW);
    try {
      await settle();
      expect(new WatchedPrioritySignal(watcher, () => null).current()).toBeUndefined();
      const signal = new WatchedPrioritySignal(watcher, () => THRESHOLD).current();
      // Observé à NOW ; lu 2 min plus tard avec maxSignalAgeMs = 60 s : périmé.
      expect(signal).toEqual({ favorable: true, observedAt: iso(NOW) });
      expect(Date.parse(iso(NOW + 120_000)) - Date.parse(signal?.observedAt ?? "")).toBeGreaterThan(
        60_000,
      );
    } finally {
      watcher.close();
    }
  });

  it.runIf(process.platform === "win32" && process.env["MIND_WAKE_TEST_REAL_IDLE"] === "1")(
    "opt-in : flux GetLastInputInfo réel, une lecture toutes les ~250 ms",
    async () => {
      const watcher = windowsIdleWatcher(250);
      try {
        const begin = performance.now();
        while (watcher.latest() === null && performance.now() - begin < 10_000) await settle();
        const first = watcher.latest();
        expect(first).not.toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const later = watcher.latest();
        expect((later?.observedAtMs ?? 0) - (first?.observedAtMs ?? 0)).toBeGreaterThan(500);
        console.info(`première lecture après ${(performance.now() - begin).toFixed(0)} ms`);
      } finally {
        watcher.close();
      }
    },
    20_000,
  );
});

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
