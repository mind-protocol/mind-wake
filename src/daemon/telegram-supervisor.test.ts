import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessBridge,
  backoffMs,
  FAILED_RESTARTS_ALERT,
  SUPERVISOR_OFF_FILE,
  TelegramSupervisor,
  type BridgeObservation,
} from "./telegram-supervisor.js";

const T0 = Date.parse("2026-11-16T16:00:00Z");
const ok = (over: Partial<BridgeObservation> = {}): BridgeObservation => ({
  enabled: true,
  pid: 42,
  alive: true,
  pidSince: T0 - 600_000,
  heartbeatReadable: true,
  status: "active",
  lastPollAt: T0 - 3_000,
  pollStartedAt: T0 - 8_000,
  ...over,
});

describe("assessBridge", () => {
  it("healthy while getUpdates keeps returning, even with no human message for hours", () => {
    expect(assessBridge(ok(), T0).kind).toBe("healthy");
  });
  it("disabled and suspended bridges are never touched", () => {
    expect(assessBridge(ok({ enabled: false, alive: false }), T0).kind).toBe("disabled");
    expect(assessBridge(ok({ status: "suspended", lastPollAt: T0 - 3_600_000 }), T0).kind).toBe("suspended");
  });
  it("dead when the locked pid is gone", () => {
    expect(assessBridge(ok({ alive: false }), T0).kind).toBe("dead");
    expect(assessBridge(ok({ pid: null, alive: false }), T0).kind).toBe("dead");
  });
  it("frozen when a getUpdates call stays pending far beyond its 20 s deadline", () => {
    const v = assessBridge(ok({ lastPollAt: T0 - 300_000, pollStartedAt: T0 - 299_000 }), T0);
    expect(v.kind).toBe("frozen");
  });
  it("degraded then silent when polls keep failing but the loop is alive", () => {
    expect(assessBridge(ok({ lastPollAt: T0 - 300_000, pollStartedAt: T0 - 4_000 }), T0).kind).toBe("degraded");
    expect(assessBridge(ok({ pidSince: T0 - 3_600_000, lastPollAt: T0 - 700_000, pollStartedAt: T0 - 4_000 }), T0).kind).toBe("silent");
  });
  it("busy while processing a message, frozen after 15 min", () => {
    expect(assessBridge(ok({ lastPollAt: T0 - 200_000, pollStartedAt: T0 - 205_000 }), T0).kind).toBe("busy");
    expect(assessBridge(ok({ lastPollAt: T0 - 1_000_000, pollStartedAt: T0 - 1_005_000 }), T0).kind).toBe("frozen");
  });
  it("starting grace after a restart, then frozen if no poll ever began", () => {
    const fresh = ok({ pidSince: T0 - 20_000, lastPollAt: T0 - 900_000, pollStartedAt: T0 - 900_000 });
    expect(assessBridge(fresh, T0).kind).toBe("starting");
    expect(assessBridge({ ...fresh, pidSince: T0 - 200_000 }, T0).kind).toBe("frozen");
  });
  it("no kill decision when the heartbeat cannot be read", () => {
    expect(assessBridge(ok({ heartbeatReadable: false, lastPollAt: null }), T0).kind).toBe("unknown");
  });
});

describe("backoffMs", () => {
  it("grows then caps", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(backoffMs)).toEqual([0, 10_000, 30_000, 60_000, 120_000, 300_000, 300_000]);
  });
});

function harness(initial: BridgeObservation) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-sup-"));
  let now = T0;
  let obs = initial;
  const spawned: number[] = [];
  const killed: number[] = [];
  const alerts: string[] = [];
  let nextPid = 100;
  const sup = new TelegramSupervisor({
    dataDir,
    now: () => now,
    observe: () => obs,
    spawnBridge: () => {
      spawned.push(nextPid);
      return nextPid++;
    },
    isBridgeProcess: () => true,
    kill: (pid) => killed.push(pid),
    alert: (text) => alerts.push(text),
  });
  return {
    dataDir,
    sup,
    spawned,
    killed,
    alerts,
    set: (o: Partial<BridgeObservation>) => (obs = { ...obs, ...o }),
    advance: (ms: number) => (now += ms),
    log: () => fs.readFileSync(path.join(dataDir, "telegram-supervisor.log"), "utf8"),
  };
}

describe("TelegramSupervisor", () => {
  it("restarts a dead bridge at once, logs it, and backs off on repeated deaths", () => {
    const h = harness(ok({ alive: false }));
    h.sup.tick();
    expect(h.spawned).toEqual([100]);
    expect(h.log()).toMatch(/relance n° 1 \(pid 42 mort\) → pid 100/);
    h.advance(5_000);
    h.sup.tick();
    expect(h.spawned).toHaveLength(1); // backoff 10 s
    h.advance(6_000);
    h.sup.tick();
    expect(h.spawned).toHaveLength(2);
  });

  it("does nothing for a healthy bridge or when switched off", () => {
    const h = harness(ok());
    h.sup.tick();
    expect(h.spawned).toEqual([]);
    h.set({ alive: false });
    fs.writeFileSync(path.join(h.dataDir, SUPERVISOR_OFF_FILE), "");
    h.sup.tick();
    expect(h.spawned).toEqual([]);
  });

  it("kills a frozen bridge, then restarts it once it is dead", () => {
    const h = harness(ok({ lastPollAt: T0 - 400_000, pollStartedAt: T0 - 390_000 }));
    h.sup.tick();
    expect(h.killed).toEqual([42]);
    expect(h.spawned).toEqual([]);
    h.set({ alive: false });
    h.advance(10_000);
    h.sup.tick();
    expect(h.spawned).toEqual([100]);
  });

  it("never kills a recycled pid that is not a bridge", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-sup-"));
    const killed: number[] = [];
    const spawned: number[] = [];
    new TelegramSupervisor({
      dataDir,
      now: () => T0,
      observe: () => ok({ lastPollAt: T0 - 400_000, pollStartedAt: T0 - 390_000 }),
      isBridgeProcess: () => false,
      kill: (pid) => killed.push(pid),
      spawnBridge: () => (spawned.push(1), 1),
      alert: () => {},
    }).tick();
    expect(killed).toEqual([]);
    expect(spawned).toEqual([1]);
  });

  it("alerts once when polling stops progressing, and reports recovery", () => {
    const h = harness(ok({ lastPollAt: T0 - 700_000, pollStartedAt: T0 - 3_000 }));
    h.sup.tick();
    h.advance(10_000);
    h.sup.tick();
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatch(/aucun relevé getUpdates réussi/);
    h.set({ lastPollAt: T0 + 9_000, pollStartedAt: T0 + 4_000 });
    h.sup.tick();
    expect(h.alerts).toHaveLength(2);
    expect(h.alerts[1]).toMatch(/rétabli/);
    expect(h.killed).toEqual([]);
  });

  it("no alert when the owner simply does not write", () => {
    const h = harness(ok());
    for (let i = 0; i < 400; i++) {
      h.advance(10_000);
      h.set({ pollStartedAt: T0 + i * 10_000 + 2_000, lastPollAt: T0 + i * 10_000 + 7_000 });
      h.sup.tick();
    }
    expect(h.alerts).toEqual([]);
  });

  it("alerts when restarts never bring the bridge back", () => {
    const h = harness(ok({ alive: false }));
    for (let i = 0; i < 40 && h.spawned.length < FAILED_RESTARTS_ALERT; i++) {
      h.sup.tick();
      h.advance(60_000);
    }
    h.sup.tick();
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatch(/relances sans retour/);
  });
});
