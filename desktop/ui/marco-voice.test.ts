import { expect, it, vi } from "vitest";
import { marcoVoice } from "./marco-voice.js";
it("reads only fresh Marco replies, in order, and mutes the mic while reading", async () => {
  const reads: string[] = [],
    speaking: boolean[] = [];
  let finish: () => void = () => {};
  const reader = marcoVoice({
    read: async (text) => {
      reads.push(text);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    cancel: vi.fn(),
    speaking: (value) => {
      speaking.push(value);
    },
    error: vi.fn(),
  });
  const item = (id: string, from = "agent") => ({ id, from, at: "now", text: id });
  reader.observe([item("old")]);
  reader.setEnabled(true);
  reader.observe([
    item("old"),
    item("new"),
    item("activity", "activity"),
    item("human", "human"),
    item("next"),
  ]);
  expect(reads).toEqual(["new"]);
  expect(speaking).toEqual([true]);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reads).toEqual(["new", "next"]);
  reader.setEnabled(false);
  expect(speaking.at(-1)).toBe(false);
  finish();
});
it("disabling cancels pending speech, and enabling does not replay old responses", async () => {
  const read = vi.fn(async () => {}),
    cancel = vi.fn();
  const reader = marcoVoice({ read, cancel, speaking: vi.fn(), error: vi.fn() });
  const item = { from: "agent", id: "a", at: "now", text: "Bonjour" };
  reader.setEnabled(true);
  reader.observe([item]);
  expect(read).not.toHaveBeenCalled();
  reader.setEnabled(false);
  expect(cancel).toHaveBeenCalledTimes(1);
  reader.observe([{ ...item, id: "b" }]);
  reader.setEnabled(true);
  reader.observe([item, { ...item, id: "b" }]);
  expect(read).not.toHaveBeenCalled();
});
