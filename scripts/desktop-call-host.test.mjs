import { test } from "node:test";
import assert from "node:assert/strict";
import { watchCallGateway } from "./desktop-call-host.mjs";

test("preloads the gateway once and closes only its own service with the desktop", async () => {
  let ticks = 0, starts = 0, closes = 0;
  await watchCallGateway({ alive: () => ticks < 3, occupied: async () => false,
    start: async () => { starts++; return { close: async () => { closes++; } }; },
    wait: async () => { ticks++; } });
  assert.equal(starts, 1); assert.equal(closes, 1);
});
test("reuses a running gateway and replaces it only after it disappears", async () => {
  let ticks = 0, starts = 0;
  await watchCallGateway({ alive: () => ticks < 4, occupied: async () => ticks < 2,
    start: async () => { assert.equal(ticks, 2); starts++; return { close: async () => {} }; },
    wait: async () => { ticks++; } });
  assert.equal(starts, 1);
});
test("a failed start does not block the app and can recover", async () => {
  let ticks = 0, starts = 0;
  await watchCallGateway({ alive: () => ticks < 3, occupied: async () => false,
    start: async () => { if (++starts === 1) throw Error("busy"); return { close: async () => {} }; },
    wait: async () => { ticks++; } });
  assert.equal(starts, 2);
});
