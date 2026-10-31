/** Fixture lifecycle tests only: no Git network operation, daemon or model. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_ID, DEFAULT_PROFILE_ID } from "../cli/context.js";
import { openStore } from "../cli/store/index.js";
import type { UtcTimestamp } from "../contracts/index.js";
import { AURORE_SYNC_INTERVAL } from "../daemon/aurore-git-sync.js";
import { WORKSPACE_SYNC_INTERVAL } from "../daemon/workspace-git-sync.js";
import { startConversationMaintenance, type ConversationMaintenance } from "./maintenance.js";

const fixtures = path.resolve(".local/conversation-maintenance-tests");
let dir: string;
const running: ConversationMaintenance[] = [];
beforeEach(() => {
  fs.mkdirSync(fixtures, { recursive: true });
  dir = fs.mkdtempSync(path.join(fixtures, "case-"));
  vi.useFakeTimers();
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((maintenance) => maintenance.stop()));
  vi.useRealTimers();
  if (!dir.startsWith(fixtures + path.sep)) throw Error("Unexpected maintenance fixture path");
  fs.rmSync(dir, { recursive: true, force: true });
});
function start(options: Parameters<typeof startConversationMaintenance>[1] = {}) {
  const value = startConversationMaintenance(dir, options);
  running.push(value);
  return value;
}
function service() {
  return { tick: vi.fn(() => Promise.resolve()), close: vi.fn(() => Promise.resolve()) };
}
function json(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid fixture JSON");
  return value as Record<string, unknown>;
}

it("never constructs a sync service or modifies a real fixture Force-off profile", async () => {
  const control = openStore(dir, "write");
  const profile = {
    id: DEFAULT_PROFILE_ID,
    agentId: DEFAULT_AGENT_ID,
    state: "stopped" as const,
    activePolicyRevisionId: null,
    nextWakeAt: null,
    emergencyStopLocked: true,
    stateReason: "Synthetic human Force-off",
    updatedAt: new Date().toISOString() as UtcTimestamp,
  };
  try {
    control.uow.profiles.create(profile);
  } finally {
    control.close();
  }
  const createServices = vi.fn(() => []);
  const maintenance = start({ createServices });
  await vi.advanceTimersByTimeAsync(120_000);
  await maintenance.stop();
  expect(createServices).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(dir, "conversation-maintenance.lock"))).toBe(false);
  const after = openStore(dir, "read");
  try {
    expect(after.uow.profiles.get(DEFAULT_PROFILE_ID)).toEqual(profile);
    expect(after.uow.sessions.listOpen(DEFAULT_PROFILE_ID)).toEqual([]);
  } finally {
    after.close();
  }
});

it("reuses both real backends without enabling either opt-in or changing their minute deadlines", async () => {
  expect(AURORE_SYNC_INTERVAL).toBe(60_000);
  expect(WORKSPACE_SYNC_INTERVAL).toBe(60_000);
  start({ allowed: () => true });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(json("aurore-sync-state.json")["status"]).toBe("disabled");
  expect(json("workspace-sync-state.json")["status"]).toBe("disabled");
  expect(fs.existsSync(path.join(dir, "atelier-aurore.json"))).toBe(false);
  expect(fs.existsSync(path.join(dir, "workspace-settings.json"))).toBe(false);
  expect(fs.existsSync(path.join(dir, "conversation-runtime"))).toBe(false);
});

it("closes both backends when controls revoke access and never resumes itself", async () => {
  let allowed = true;
  const aurore = service();
  const workspace = service();
  const createServices = vi.fn((_dir: string, guard: () => boolean) => {
    expect(guard()).toBe(true);
    return [
      { name: "aurore", service: aurore },
      { name: "workspace", service: workspace },
    ];
  });
  start({ allowed: () => allowed, createServices });
  await vi.advanceTimersByTimeAsync(1000);
  expect(aurore.tick).toHaveBeenCalledTimes(2);
  expect(workspace.tick).toHaveBeenCalledTimes(2);
  allowed = false;
  await vi.advanceTimersByTimeAsync(1000);
  expect(aurore.close).toHaveBeenCalledOnce();
  expect(workspace.close).toHaveBeenCalledOnce();
  allowed = true;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(aurore.tick).toHaveBeenCalledTimes(2);
  expect(workspace.tick).toHaveBeenCalledTimes(2);
  expect(createServices).toHaveBeenCalledOnce();
});

it("cancels in-flight maintenance and awaits backend cleanup before releasing ownership", async () => {
  const controller = new AbortController();
  let finish: () => void = () => {
    throw Error("Fixture not started");
  };
  const flight = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const active = { tick: vi.fn(() => flight), close: vi.fn(() => flight) };
  const maintenance = start({
    signal: controller.signal,
    allowed: () => true,
    createServices: () => [{ name: "aurore", service: active }],
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(active.tick).toHaveBeenCalledOnce();
  controller.abort();
  expect(active.close).toHaveBeenCalledOnce();
  let closed = false;
  const stopped = maintenance.stop().then(() => {
    closed = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(closed).toBe(false);
  finish();
  await stopped;
  expect(closed).toBe(true);
  await maintenance.stop();
  expect(active.close).toHaveBeenCalledOnce();
});

it("reports a failing backend while keeping the other service and future polls usable", async () => {
  const aurore = service();
  const workspace = service();
  const failure = new Error("Synthetic unreadable settings");
  aurore.tick = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(failure)
    .mockResolvedValue(undefined);
  const onError = vi.fn();
  start({
    allowed: () => true,
    onError,
    createServices: () => [
      { name: "aurore", service: aurore },
      { name: "workspace", service: workspace },
    ],
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(onError).toHaveBeenCalledExactlyOnceWith("aurore", failure);
  expect(workspace.tick).toHaveBeenCalledTimes(2);
  expect(aurore.tick).toHaveBeenCalledTimes(2);
});

it("gives one worker per profile ownership and transfers only after the first cleanup completes", async () => {
  const firstService = service();
  const secondService = service();
  const createFirst = vi.fn(() => [{ name: "workspace", service: firstService }]);
  const createSecond = vi.fn(() => [{ name: "workspace", service: secondService }]);
  const first = start({ allowed: () => true, createServices: createFirst });
  start({ allowed: () => true, createServices: createSecond });
  await vi.advanceTimersByTimeAsync(1000);
  expect(createFirst).toHaveBeenCalledOnce();
  expect(createSecond).not.toHaveBeenCalled();
  await first.stop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(createSecond).toHaveBeenCalledOnce();
  expect(firstService.close).toHaveBeenCalledOnce();
  expect(secondService.tick).toHaveBeenCalledOnce();
});
