import {expect,it} from "vitest";
import {roleTurnStopReason} from "./codex-role-turn.js";
it("does not impose a local session cap when none was requested",()=>{
  expect(roleTurnStopReason(true,null,0)).toBeNull();
  expect(roleTurnStopReason(true,null,Date.now()+365*86400000)).toBeNull();
});
it("still cancels an unlimited child when host authorization stops",()=>{
  expect(roleTurnStopReason(false,null,Date.now()+365*86400000)).toBe("interrupted");
});
it("preserves explicit bounded voice/tool deadlines and stop precedence",()=>{
  expect(roleTurnStopReason(true,100,100)).toBeNull();
  expect(roleTurnStopReason(true,100,101)).toBe("timed_out");
  expect(roleTurnStopReason(false,100,101)).toBe("interrupted");
});
