import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanupKilledGitIndexLock, FILE_CHANGED_WHILE_INDEXING, GitCommandError, gitOperation, gitTimeoutMs } from "./supervised-git.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function lockFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-git-lock-"));
  dirs.push(dir);
  const file = path.join(dir, "index.lock");
  fs.writeFileSync(file, "lock");
  return file;
}

it("removes a lock created by a killed git process after exit", () => {
  const file = lockFile();
  cleanupKilledGitIndexLock(file, false, true, true);
  expect(fs.existsSync(file)).toBe(false);
});

it.each([
  [true, true, true],
  [false, false, true],
  [false, true, false],
])("preserves a lock when prior-existence, kill, or exit condition is missing", (existed, killed, exited) => {
  const file = lockFile();
  cleanupKilledGitIndexLock(file, existed, killed, exited);
  expect(fs.existsSync(file)).toBe(true);
});

it("treats a file rewritten during git add as retryable, not as a broken repository", () => {
  expect(FILE_CHANGED_WHILE_INDEXING.test("error: short read while indexing artifacts/x/context.json")).toBe(true);
  expect(FILE_CHANGED_WHILE_INDEXING.test("fatal: not a git repository")).toBe(false);
  const error = new GitCommandError("add", true, "file-changed");
  expect(error.transient).toBe(true);
  expect(error.message).toBe("Git add failed (a file changed while Git was reading it; retry in one minute).");
  expect(new GitCommandError("push", true).message).toContain("temporary network failure");
});

it("names the Git subcommand after leading -c options and gives push a transfer-sized deadline", () => {
  const push = ["-c", "remote.origin.mirror=false", "push", "--no-mirror", "url", "HEAD:main"];
  expect(gitOperation(push)).toBe("push");
  expect(gitOperation(["fetch", "origin"])).toBe("fetch");
  expect(gitOperation(["-c", "a=b"])).toBe("operation");
  expect(new GitCommandError(gitOperation(push), false).message).toBe("Git push failed; inspect the repository locally.");
  expect(gitTimeoutMs("push")).toBe(5 * 60_000);
  expect(gitTimeoutMs("status")).toBe(30_000);
});
