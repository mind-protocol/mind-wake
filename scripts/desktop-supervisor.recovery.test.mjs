import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { waitForDesktopExit, supervise } from "./desktop-supervisor.mjs";

test("an already-exited desktop restarts instead of stranding its supervisor", { timeout: 5000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wake-desktop-early-exit-"));
  const manifest = path.join(dir, "manifest.json");
  writeFileSync(manifest, "{}");
  let attempts = 0;
  try {
    await supervise(manifest, false, async () => {
      const child = new EventEmitter();
      child.pid = 100 + ++attempts;
      child.exitCode = attempts === 1 ? 1 : 0;
      child.signalCode = null;
      return child;
    });
    assert.equal(attempts, 2);
    assert.match(readFileSync(path.join(dir, "desktop-supervisor.log"), "utf8"), /desktop exited \(1\); restarting/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a running desktop is observed until its actual exit", async () => {
  const child = new EventEmitter();
  child.exitCode = child.signalCode = null;
  const pending = waitForDesktopExit(child);
  child.emit("exit", 75, null);
  assert.deepEqual(await pending, { code: 75, signal: null });
});
