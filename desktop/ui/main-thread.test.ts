import { expect, it } from "vitest";
import { mainThreadChatNotice, mainThreadModel, mainThreadStatus } from "./main-thread.js";

it("reads the main-thread switch from wake status and states it in the panel and chat", () => {
  expect(mainThreadModel({ executionMode: "always-on" })).toBeNull();
  expect(mainThreadModel(null)).toBeNull();
  const on = mainThreadModel({ mainThread: { enabled: true, updatedAt: null }, profile: { state: "hibernating" } });
  expect(on).toEqual({ enabled: true, sessionActive: false });
  expect(mainThreadChatNotice(on)).toBeNull();
  expect(mainThreadChatNotice(null)).toBeNull();
  expect(mainThreadStatus(on!)).toContain("actif");

  const off = mainThreadModel({ mainThread: { enabled: false, updatedAt: "2026-11-13T16:00:00Z" }, profile: { state: "ready" } })!;
  expect(off).toEqual({ enabled: false, sessionActive: false });
  expect(mainThreadStatus(off)).toContain("Off");
  expect(mainThreadChatNotice(off)).toContain("désactivé");
  expect(mainThreadChatNotice(off)).toContain("conservés");

  const finishing = mainThreadModel({ mainThread: { enabled: false }, profile: { state: "running" } })!;
  expect(finishing.sessionActive).toBe(true);
  expect(mainThreadChatNotice(finishing)).toContain("session en cours");
});
