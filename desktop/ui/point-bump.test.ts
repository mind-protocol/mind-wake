import { expect, it } from "vitest";
import { BUMP_TEXT, resolveBumpText } from "./chat-presence.js";
import { BUMPE_CONTEXT_RESERVE, PointSendIntent, pointBumpText } from "./point-bump.js";

it("keeps the shared invitation, final relaunch and scope on the real circled point", async () => {
  const text = pointBumpText(await resolveBumpText(() => Promise.resolve(null)));
  expect(text.startsWith("BUMP:")).toBe(true);
  expect(text).toContain(BUMP_TEXT);
  for (const clause of ["point précis de son clic droit", "cerclé en rouge", "contexte et sa valeur", "brouillon séparé"]) expect(text).toContain(clause);
});

it("retries the same failed Bumpe despite a newly edited prompt and changes key for a new click", () => {
  const state = new PointSendIntent();
  let sequence = 0;
  const key = () => `key-${++sequence}`;
  const first = state.prepare("bumpe", "original", 41, key);
  expect(state.prepare("bumpe", "prompt edited", 41, key)).toBe(first);
  expect(state.current("bumpe", 41)?.text).toBe("original");
  expect(state.prepare("bumpe", "prompt edited", 42, key).key).not.toBe(first.key);
  state.complete();
  expect(state.current("bumpe", 42)).toBeNull();
});

it("preserves normal message retries but separates edited drafts and Bumpe", () => {
  const state = new PointSendIntent();
  let sequence = 0;
  const key = () => `key-${++sequence}`;
  const message = state.prepare("message", "draft", 10, key);
  expect(state.prepare("message", "draft", 10, key)).toBe(message);
  expect(state.prepare("message", "draft edited", 10, key).key).not.toBe(message.key);
  expect(state.current("bumpe", 10)).toBeNull();
});

it("retains an unconfirmed send across a new click until acknowledgement is reconciled", () => {
  const state = new PointSendIntent();
  const original = state.prepare("bumpe", "original", 41, () => "ui-bumpe-fixed");
  state.unconfirmed();
  expect(state.current("bumpe",99)).toBe(original);
  expect(state.prepare("bumpe","new prompt",99,()=>"new-key")).toBe(original);
  expect(state.isUnconfirmed()).toBe(true);
  state.complete();
  expect(state.prepare("bumpe","new prompt",99,()=>"new-key").key).toBe("new-key");
});

it("reserves the entire point protocol and falls back to complete current instructions for a long file", () => {
  const text = pointBumpText(`BUMP: ${"x".repeat(3994)}`);
  expect(text).toContain(BUMP_TEXT);
  expect(text).toContain("N’inclus pas le préfixe BUMP:");
  expect(text.length + BUMPE_CONTEXT_RESERVE).toBeLessThanOrEqual(4000);
});
