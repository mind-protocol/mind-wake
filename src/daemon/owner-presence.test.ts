import { expect, it } from "vitest";
import { parseWindowsActivity, type IdleObservation } from "../scheduler/priority.js";
import { ownerPresenceEvent } from "./owner-presence.js";

const now = Date.parse("2026-11-03T12:00:00Z");
const observation = (changes: Partial<IdleObservation> = {}): IdleObservation => ({
  idleMs: 0, observedAtMs: now, mindForeground: false, ...changes,
});

it("remembers foreground transitions from the native stream, excluding unknown observations", () => {
  const first = parseWindowsActivity("100|1", now - 30_000, null);
  const next = parseWindowsActivity("200|0", now, first);
  expect(next).toMatchObject({ mindForeground: false, mindLastForegroundAtMs: now - 30_000 });
  expect(ownerPresenceEvent(next, now)).toContain("human potentially watching=true");
  expect(ownerPresenceEvent(parseWindowsActivity("200|-1", now, first), now))
    .toContain("human potentially watching=true");
  expect(parseWindowsActivity("garbage", now, first)).toBeNull();
  expect(parseWindowsActivity("-1|1", now, first)).toBeNull();
});

it.each([
  [true, undefined, 0, true],
  [false, 30_000, 0, true],
  [false, 30_001, 0, false],
  [false, undefined, 0, false],
  [true, 0, 120_000, true],
  [true, 0, 120_001, false],
  [false, 10_000, 120_001, false],
] as const)("foreground=%s, last seen=%s ms, idle=%s ms → watching=%s", (mindForeground, ago, idleMs, watching) => {
  const event = ownerPresenceEvent(observation({ mindForeground, idleMs,
    ...(ago === undefined ? {} : { mindLastForegroundAtMs: now - ago }),
  }), now);
  expect(event).toContain(`human potentially watching=${watching}`);
});

it("omits missing, stale, future or unavailable foreground metadata", () => {
  expect(ownerPresenceEvent(null, now)).toBeNull();
  expect(ownerPresenceEvent({ idleMs: 0, observedAtMs: now }, now)).toBeNull();
  expect(ownerPresenceEvent(observation({ observedAtMs: now - 2001 }), now)).toBeNull();
  expect(ownerPresenceEvent(observation({ observedAtMs: now + 1 }), now)).toBeNull();
  expect(ownerPresenceEvent(observation({ idleMs: 120_000, mindForeground: true, observedAtMs: now - 1 }), now))
    .toContain("human potentially watching=false");
});
