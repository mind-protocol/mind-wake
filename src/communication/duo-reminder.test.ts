import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DuoMonitor,
  configureDuo,
  duoEnabled,
  claimDuoReminder,
  finishDuoReminder,
} from "./duo-reminder.js";
import { ownerInboxHook } from "./owner-inbox-hook.js";
import { CodexOwnerSteering } from "../adapters/codex/owner-steering.js";
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duo-"));
  const content = path.join(dir, "content.json");
  let now = 100_000;
  let allowed = true;
  const monitor = new DuoMonitor(
    dir,
    content,
    () => allowed,
    () => now,
  );
  return {
    dir,
    content,
    monitor,
    clock() {
      return now;
    },
    advance(ms: number) {
      now += ms;
      monitor.tick();
    },
    pause() {
      allowed = false;
      monitor.tick();
    },
    claim(id: string) {
      return claimDuoReminder(dir, id, now);
    },
    ack(id: string) {
      finishDuoReminder(dir, id, true, now);
    },
    cleanup() {
      monitor.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
describe("Mode Duo", () => {
  it("defaults off, retries failed delivery and sends once per visual stall", () => {
    const h = fixture();
    try {
      expect(duoEnabled(h.dir)).toBe(false);
      h.advance(30_000);
      expect(h.claim("a")).toBeNull();
      configureDuo(h.dir, true);
      expect(duoEnabled(h.dir)).toBe(true);
      h.advance(0);
      h.advance(29_999);
      expect(h.claim("a")).toBeNull();
      h.advance(1);
      expect(h.claim("a")).toContain("not a human");
      expect(h.claim("b")).toBeNull();
      finishDuoReminder(h.dir, "a", false, h.clock());
      expect(h.claim("failed-retry")).toBeNull();
      h.advance(29_999);
      expect(h.claim("b")).toBeNull();
      h.advance(1);
      expect(h.claim("b")).not.toBeNull();
      h.ack("b");
      h.advance(300_000);
      expect(h.claim("no-flood")).toBeNull();
      fs.writeFileSync(h.content, JSON.stringify({ fingerprint: "a".repeat(64) }));
      h.advance(20_000);
      h.advance(29_999);
      expect(h.claim("c")).toBeNull();
      h.advance(1);
      expect(h.claim("c")).not.toBeNull();
      h.ack("c");
      // Rewriting the same content must not rearm an acknowledged reminder.
      fs.writeFileSync(h.content, JSON.stringify({ fingerprint: "a".repeat(64) }));
      h.advance(30_000);
      expect(h.claim("d")).toBeNull();
      configureDuo(h.dir, false);
      expect(h.claim("e")).toBeNull();
      h.advance(0);
      configureDuo(h.dir, true);
      h.advance(0);
      h.advance(30_000);
      h.pause();
      expect(h.claim("f")).toBeNull();
    } finally {
      h.cleanup();
    }
  });
  it("delivers through the real Claude hook and Codex steering with runtime attribution", async () => {
    const h = fixture();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => h.clock());
    try {
      configureDuo(h.dir, true);
      h.advance(0);
      h.advance(30_000);
      const hook = ownerInboxHook(h.dir, "s", { session_id: "s", hook_event_name: "PostToolUse" });
      expect(JSON.stringify(hook)).toContain("Mode Duo");
      expect(
        ownerInboxHook(h.dir, "s", { session_id: "s", hook_event_name: "PostToolUse" }),
      ).toBeNull();
      h.advance(30_000);
      // A changed visual rearms delivery, with acknowledged turn ID.
      fs.writeFileSync(h.content, JSON.stringify({ fingerprint: "b".repeat(64) }));
      h.advance(0);
      h.advance(30_000);
      const calls: unknown[] = [];
      const steering = new CodexOwnerSteering(
        h.dir,
        "s",
        "t",
        "turn",
        {
          request: async (_method, params) => {
            calls.push(params);
            return { turnId: "turn" };
          },
        },
        () => true,
      );
      try {
        await steering.flush();
        expect(calls).toHaveLength(1);
        expect(JSON.stringify(calls)).toContain("Mode Duo");
        await steering.flush();
        expect(calls).toHaveLength(1);
      } finally {
        steering.stop();
      }
    } finally {
      clock.mockRestore();
      h.cleanup();
    }
  });
});
