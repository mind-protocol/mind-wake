import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OwnerMessages } from "./owner-messages.js";
import { readOwnerInboxHistory } from "./owner-inbox.js";
import { ownerInboxHook } from "./owner-inbox-hook.js";
import { claimProgressReminder, finishProgressReminder, readProgressReminderStatus, OwnerProgressReminder, PROGRESS_REMINDER } from "./owner-progress-reminder.js";

let dir: string;
let messages: OwnerMessages;
let monitor: OwnerProgressReminder;
let now: number;
let watching: boolean;
const start = Date.parse("2026-11-03T14:00:00Z");
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-progress-"));
  now = start;
  watching = true;
  messages = new OwnerMessages(dir, "agent");
  messages.publish("Bonjour", "hello", new Date(now).toISOString());
  monitor = new OwnerProgressReminder(dir, () => watching, () => now);
});
afterEach(() => {
  vi.restoreAllMocks();
  monitor.close();
  messages.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const claim = (id = "claim") => claimProgressReminder(dir, "session", id, now);

it("waits 60 seconds, sends once and rearms only after a real publication", () => {
  now += 59_999; monitor.tick(); expect(claim()).toBeNull();
  now++; monitor.tick();
  expect(readProgressReminderStatus(dir, now)).toEqual({state: "pending"});
  expect(claim()).toBe(PROGRESS_REMINDER);
  finishProgressReminder(dir, "session", "claim", true);
  expect(readProgressReminderStatus(dir, now)).toEqual({state: "delivered"});
  now += 120_000; monitor.tick(); expect(claim()).toBeNull();
  messages.publish("Bonjour", "hello", new Date(start).toISOString()); // Idempotent retry is not news.
  monitor.tick(); expect(claim()).toBeNull();
  messages.publish("Une avancée", "news", new Date(now).toISOString());
  monitor.tick(); expect(claim()).toBeNull();
  now += 60_000; monitor.tick(); expect(claim("next")).toBe(PROGRESS_REMINDER);
  expect(readOwnerInboxHistory(dir)).toEqual([]);
  expect(messages.list()).toHaveLength(2);
});

it("withdraws pending notices on absence/pause and expires observations when the monitor stops updating", () => {
  now += 60_000; monitor.tick();
  watching = false; monitor.tick(); expect(claim()).toBeNull();
  watching = true; monitor.tick();
  now += 2001; expect(claim()).toBeNull();
  monitor.tick(); expect(claim()).toBe(PROGRESS_REMINDER);
});

it("does not deliver a stale reminder if a real message was published since the last tick", () => {
  now += 60_000; monitor.tick();
  messages.publish("Voici les nouvelles", "news", new Date(now).toISOString());
  expect(readProgressReminderStatus(dir, now)).toBeNull();
  expect(claim()).toBeNull();
  monitor.tick(); expect(claim()).toBeNull();
});

it("reads UI status without creating a store or showing expired attention", () => {
  const empty = path.join(dir, "missing");
  expect(readProgressReminderStatus(empty, now)).toBeNull();
  expect(fs.existsSync(empty)).toBe(false);
  now += 60_000; monitor.tick();
  expect(readProgressReminderStatus(dir, now + 2001)).toBeNull();
});

it("releases failed deliveries, prevents simultaneous claims and recovers after daemon restart", () => {
  now += 60_000; monitor.tick(); expect(claim()).toBe(PROGRESS_REMINDER);
  expect(claim("second")).toBeNull();
  finishProgressReminder(dir, "session", "claim", false);
  expect(claim("retry")).toBe(PROGRESS_REMINDER);
  monitor.close();
  monitor = new OwnerProgressReminder(dir, () => watching, () => now);
  expect(claim("restart")).toBeNull();
  monitor.tick(); expect(claim("restart")).toBe(PROGRESS_REMINDER);
});

it("delivers a queued notice at a Claude hook without fabricating a human message", () => {
  now = start + 60_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  monitor.tick();
  const input = { session_id: "claude-session", hook_event_name: "PostToolUse" };
  const result = ownerInboxHook(dir, "claude-session", input);
  expect(result).toEqual({hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: PROGRESS_REMINDER }});
  expect(ownerInboxHook(dir, "claude-session", input)).toBeNull();
  expect(readOwnerInboxHistory(dir)).toEqual([]);
});

it("never lets a failed observation keep a queued notice eligible", () => {
  now += 60_000; monitor.tick();
  monitor.close();
  monitor = new OwnerProgressReminder(dir, () => { throw Error("sensor"); }, () => now);
  monitor.tick(); expect(claim()).toBeNull();
});
