import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { autoPush, gitContext } from "./auto-push.mjs";
import { setupAutoPush } from "./setup-auto-push.mjs";

// Every Git mutation is confined to fresh temporary repositories; no network access.
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Auto push test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Auto push test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
for (const key of Object.keys(env))
  if (
    /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(
      key,
    )
  )
    delete env[key];
function git(repo, ...args) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    env,
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
function fixture(t, upstream = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mind-auto-push-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "checkout space 'quote"),
    remote = path.join(root, "remote.git");
  fs.mkdirSync(repo);
  fs.mkdirSync(remote);
  git(remote, "init", "--bare");
  git(repo, "init", "-b", "local-topic");
  git(repo, "config", "core.hooksPath", path.join(repo, ".git", "hooks"));
  git(repo, "config", "--unset", "core.hooksPath");
  git(repo, "commit", "--allow-empty", "-m", "initial");
  git(repo, "remote", "add", "origin", remote);
  if (upstream) git(repo, "push", "-u", "origin", "HEAD:refs/heads/destination");
  return { root, repo, remote, hook: path.join(repo, ".git", "hooks", "post-commit") };
}
function enable(repo) {
  return setupAutoPush({ repo, env });
}
function disable(repo) {
  return setupAutoPush({ repo, disable: true, env });
}
function commit(repo, message = "new local commit") {
  git(repo, "commit", "--allow-empty", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}
function invoke(repo) {
  return autoPush({ repo, gitDir: gitContext(repo, env).gitDir, cwd: repo, env });
}

test("real post-commit pushes exact captured commit to upstream branch, idempotent enable and reversible disable", (t) => {
  const { repo, remote, hook } = fixture(t);
  git(repo, "config", "push.default", "matching");
  assert.equal(enable(repo).state, "enabled");
  assert.equal(enable(repo).state, "already-enabled");
  const head = commit(repo);
  assert.equal(git(remote, "rev-parse", "refs/heads/destination"), head);
  assert.equal(git(remote, "for-each-ref", "--format=%(refname)"), "refs/heads/destination");
  assert.equal(disable(repo).state, "disabled");
  assert.equal(fs.existsSync(hook), false);
  assert.equal(disable(repo).state, "disabled");
  commit(repo);
  assert.equal(git(remote, "rev-parse", "refs/heads/destination"), head);
});

test("non-fast-forward rejection preserves successful local commit and remote head", async (t) => {
  const { repo, remote, root } = fixture(t);
  const other = path.join(root, "other");
  git(root, "clone", "-b", "destination", remote, other);
  const remoteHead = commit(other, "competing remote commit");
  git(other, "push");
  enable(repo);
  const head = commit(repo);
  assert.notEqual(head, remoteHead);
  assert.equal(git(remote, "rev-parse", "refs/heads/destination"), remoteHead);
  const result = await invoke(repo);
  assert.equal(result.state, "failed");
  assert.match(result.reason, /fast-forward/);
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.equal(fs.existsSync(path.join(repo, ".git", "mind-auto-push.lock")), false);
});

test("existing post-commit is preserved for enable and disable", (t) => {
  const { repo, hook } = fixture(t);
  const original = "#!/bin/sh\necho existing\n";
  fs.writeFileSync(hook, original);
  assert.throws(() => enable(repo), /not ours/);
  assert.throws(() => disable(repo), /not ours/);
  assert.equal(fs.readFileSync(hook, "utf8"), original);
});

test("configured core.hooksPath is refused without changes", (t) => {
  const { repo, root, hook } = fixture(t);
  const custom = path.join(root, "custom-hooks");
  fs.mkdirSync(custom);
  const original = "#!/bin/sh\necho custom\n";
  fs.writeFileSync(path.join(custom, "post-commit"), original);
  git(repo, "config", "core.hooksPath", custom);
  assert.throws(() => enable(repo), /core.hooksPath/);
  assert.equal(git(repo, "config", "core.hooksPath"), custom);
  assert.equal(fs.existsSync(hook), false);
  assert.equal(fs.readFileSync(path.join(custom, "post-commit"), "utf8"), original);
});

test("no upstream and detached HEAD never invent a destination, commits remain successful", async (t) => {
  const { repo, remote } = fixture(t, false);
  enable(repo);
  const head = commit(repo);
  assert.equal((await invoke(repo)).state, "skipped");
  assert.match((await invoke(repo)).reason, /upstream/);
  git(repo, "checkout", "--detach");
  const detached = commit(repo);
  assert.match((await invoke(repo)).reason, /detached HEAD/);
  assert.equal(git(repo, "rev-parse", "HEAD"), detached);
  assert.notEqual(head, detached);
  assert.equal(git(remote, "for-each-ref", "--format=%(refname)"), "");
});

test("disable refuses modified marked hook, leaving bytes intact", (t) => {
  const { repo, hook } = fixture(t);
  enable(repo);
  fs.appendFileSync(hook, "# human addition\n");
  const modified = fs.readFileSync(hook, "utf8");
  assert.throws(() => disable(repo), /not ours/);
  assert.equal(fs.readFileSync(hook, "utf8"), modified);
});

test("existing pre-push hook runs and can reject, local commit remains", (t) => {
  const { repo, remote } = fixture(t);
  const before = git(remote, "rev-parse", "refs/heads/destination");
  const prepush = path.join(repo, ".git", "hooks", "pre-push");
  fs.writeFileSync(prepush, "#!/bin/sh\necho called > pre-push-evidence\nexit 1\n", {
    mode: 0o755,
  });
  enable(repo);
  const head = commit(repo);
  assert.notEqual(head, before);
  assert.equal(fs.readFileSync(path.join(repo, "pre-push-evidence"), "utf8").trim(), "called");
  assert.equal(git(remote, "rev-parse", "refs/heads/destination"), before);
});

test("linked worktree never pushes through another checkout binding", async (t) => {
  const { repo, root, remote } = fixture(t);
  enable(repo);
  const worktree = path.join(root, "linked");
  git(repo, "worktree", "add", "-b", "linked", worktree);
  const before = git(remote, "rev-parse", "refs/heads/destination");
  commit(worktree);
  const result = await autoPush({ repo, gitDir: gitContext(repo, env).gitDir, cwd: worktree, env });
  assert.match(result.reason, /another checkout/);
  assert.throws(() => enable(worktree), /another linked checkout/);
  assert.throws(() => disable(worktree), /another linked checkout/);
  assert.equal(git(remote, "rev-parse", "refs/heads/destination"), before);
});

test("mirror and followTags settings cannot expand the explicit upstream push", (t) => {
  const { repo, remote } = fixture(t);
  git(repo, "branch", "extra-local");
  git(repo, "tag", "-a", "extra-tag", "-m", "keep local");
  git(repo, "config", "remote.origin.mirror", "true");
  git(repo, "config", "push.followTags", "true");
  enable(repo);
  const head = commit(repo);
  assert.equal(git(remote, "rev-parse", "refs/heads/destination"), head);
  assert.equal(git(remote, "for-each-ref", "--format=%(refname)"), "refs/heads/destination");
});

test("multiple push URLs are refused without partial push", async (t) => {
  const { repo, remote, root } = fixture(t);
  git(repo, "config", "--add", "remote.origin.pushurl", remote);
  git(repo, "config", "--add", "remote.origin.pushurl", path.join(root, "second.git"));
  const before = git(remote, "rev-parse", "refs/heads/destination");
  enable(repo);
  commit(repo);
  assert.match((await invoke(repo)).reason, /unique push destination/);
  assert.equal(git(remote, "rev-parse", "refs/heads/destination"), before);
});

test("stale lock skips without deleting it or losing local commit", async (t) => {
  const { repo, remote } = fixture(t);
  const before = git(remote, "rev-parse", "refs/heads/destination");
  const lock = path.join(repo, ".git", "mind-auto-push.lock");
  fs.writeFileSync(lock, "operator-owned lock");
  enable(repo);
  const head = commit(repo);
  const result = await invoke(repo);
  assert.match(result.reason, /lock/);
  assert.equal(fs.readFileSync(lock, "utf8"), "operator-owned lock");
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.equal(git(remote, "rev-parse", "refs/heads/destination"), before);
});

test("push receives noninteractive authentication environment", (t) => {
  const { repo } = fixture(t);
  fs.writeFileSync(
    path.join(repo, ".git", "hooks", "pre-push"),
    '#!/bin/sh\nprintf "%s\\n" "$GIT_TERMINAL_PROMPT" "$GCM_INTERACTIVE" "$SSH_ASKPASS_REQUIRE" "$GIT_SSH_COMMAND" > auth-evidence\n',
    { mode: 0o755 },
  );
  enable(repo);
  commit(repo);
  assert.equal(
    fs.readFileSync(path.join(repo, "auth-evidence"), "utf8"),
    "0\nNever\nnever\nssh -o BatchMode=yes -o ConnectTimeout=15\n",
  );
});

test("push timeout kills child tree and preserves commit and remote ref", async (t) => {
  const { repo, remote } = fixture(t);
  const before = git(remote, "rev-parse", "refs/heads/destination");
  const head = commit(repo);
  fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-push"), "#!/bin/sh\nsleep 10\n", {
    mode: 0o755,
  });
  const started = Date.now();
  const result = await autoPush({
    repo,
    gitDir: gitContext(repo, env).gitDir,
    cwd: repo,
    env,
    timeoutMs: 500,
  });
  assert.equal(result.state, "failed");
  assert.match(result.reason, /timed out/);
  assert.ok(Date.now() - started < 10000);
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.equal(git(remote, "rev-parse", "refs/heads/destination"), before);
  assert.equal(fs.existsSync(path.join(repo, ".git", "mind-auto-push.lock")), false);
});
