import {expect,it} from 'vitest';
import {successfulRuntimeExit} from './runtime-exit.js';
it('accepts Claude cleanup only after an explicit successful result',()=>{
  expect(successfulRuntimeExit('claude','result:completed',49374)).toBe(true);
  expect(successfulRuntimeExit('claude','result:success',49374)).toBe(true);
  expect(successfulRuntimeExit('claude',null,49374)).toBe(false);
  expect(successfulRuntimeExit('claude','result:error_during_execution',49374)).toBe(false);
  expect(successfulRuntimeExit('codex','result:completed',49374)).toBe(false);
  expect(successfulRuntimeExit('claude','result:completed',70)).toBe(false);
  expect(successfulRuntimeExit('claude','result:completed',0)).toBe(true);
});
it('accepts Codex app-server cleanup only after turn/completed confirmed completion',()=>{
  expect(successfulRuntimeExit('codex','completed',0xC0DE)).toBe(true);
  expect(successfulRuntimeExit('codex',null,0xC0DE)).toBe(false);
  expect(successfulRuntimeExit('codex','failed',0xC0DE)).toBe(false);
  expect(successfulRuntimeExit('codex','interrupted',0xC0DE)).toBe(false);
  expect(successfulRuntimeExit('codex','stream_cut',0xC0DE)).toBe(false);
  expect(successfulRuntimeExit('codex','completed',70)).toBe(false);
  expect(successfulRuntimeExit('other','completed',0xC0DE)).toBe(false);
});
