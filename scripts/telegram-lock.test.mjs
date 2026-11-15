import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireTelegramLock, ownsTelegramLock, releaseTelegramLock } from "./telegram-lock.mjs";

const lockFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tg-lock-")), "telegram.pid");

test("a live owner keeps the lock and a second bridge stays out", () => {
  const lock = lockFile();
  assert.equal(acquireTelegramLock(lock, 100, () => true), true);
  assert.equal(acquireTelegramLock(lock, 200, () => true), false);
  assert.equal(ownsTelegramLock(lock, 100), true);
});

test("a dead owner is replaced, and the replaced bridge sees it lost the lock", () => {
  const lock = lockFile();
  acquireTelegramLock(lock, 100, () => true);
  assert.equal(acquireTelegramLock(lock, 200, () => false), true);
  assert.equal(ownsTelegramLock(lock, 100), false);
  assert.equal(ownsTelegramLock(lock, 200), true);
});

test("release never removes another bridge's lock", () => {
  const lock = lockFile();
  acquireTelegramLock(lock, 200, () => true);
  releaseTelegramLock(lock, 100);
  assert.equal(fs.readFileSync(lock, "utf8"), "200");
  releaseTelegramLock(lock, 200);
  assert.equal(fs.existsSync(lock), false);
});

test("a fresh empty lock (owner mid-write) is not stolen; a stale one is", () => {
  const lock = lockFile();
  fs.writeFileSync(lock, "");
  const mtime = fs.statSync(lock).mtimeMs;
  assert.equal(acquireTelegramLock(lock, 200, () => false, mtime + 1_000), false);
  assert.equal(acquireTelegramLock(lock, 200, () => false, mtime + 60_000), true);
});
