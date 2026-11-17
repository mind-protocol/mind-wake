import { expect, it } from "vitest";
import { reloadGuard } from "./reload-guard.js";

function setup(start = 1000) {
  let clock = start;
  const log: string[] = [];
  const guard = reloadGuard({reload: () => log.push("reload"), showPending: p => log.push(p ? "badge" : "no-badge"), now: () => clock});
  return {guard, log, tick: (ms: number) => { clock += ms; }};
}

it("reloads at once when no call is ringing or active", () => {
  const {guard, log} = setup();
  guard.requested();
  expect(log).toEqual(["reload"]);
  expect(guard.pending()).toBe(false);
});

it("defers the reload during an active call and applies it when the call ends", () => {
  const {guard, log} = setup();
  guard.callStage("active");
  guard.requested();
  guard.requested();
  guard.check();
  expect(log).toEqual(["badge"]);
  expect(guard.pending()).toBe(true);
  guard.callStage(null);
  expect(log).toEqual(["badge", "no-badge", "reload"]);
});

it("defers while ringing, then reloads once the ring expires without an end message", () => {
  const {guard, log, tick} = setup();
  guard.callStage("ringing", 31000);
  guard.requested();
  guard.check();
  expect(log).toEqual(["badge"]);
  tick(30000);
  guard.check();
  expect(log).toEqual(["badge", "no-badge", "reload"]);
});

it("keeps waiting when a ringing call is answered", () => {
  const {guard, log} = setup();
  guard.callStage("ringing", 5000);
  guard.requested();
  guard.callStage("active");
  expect(log).toEqual(["badge"]);
  guard.callStage(null);
  expect(log.at(-1)).toBe("reload");
});
