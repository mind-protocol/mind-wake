import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { bootstrap, rollback, FileTransaction } from "../../scripts/aurore-bootstrap.mjs";
import { preflightWorkspace, applyWorkspace } from "../../scripts/aurore-bootstrap-workspace.mjs";
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const hash = (b) => createHash("sha256").update(b).digest("hex");
const write = (root, name, text) => {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), text);
};
function tree(root) {
  const result = {};
  const visit = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) visit(f);
      else result[path.relative(root, f)] = hash(fs.readFileSync(f));
    }
  };
  visit(root);
  return result;
}
function fixture(t, trackedPersonality = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wake-bootstrap-workspace-"));
  t.after(() => {
    assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(base).startsWith("wake-bootstrap-workspace-"));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const origin = path.join(base, "origin"),
    root = path.join(base, "active"),
    transactionRoot = path.join(base, "transactions");
  fs.mkdirSync(origin);
  fs.mkdirSync(transactionRoot);
  git(origin, "init", "-b", "main");
  git(origin, "config", "core.autocrlf", "false");
  git(origin, "config", "user.name", "Fixture");
  git(origin, "config", "user.email", "fixture@example.invalid");
  write(origin, "AGENTS.md", "previous instructions\n");
  write(origin, "sentinel", "keep identity\n");
  if (trackedPersonality)
    write(origin, "artifacts/PERSONALITY.md", "# Personal instructions\nold skeleton\n");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "before");
  const before = git(origin, "rev-parse", "HEAD");
  git(base, "clone", "-c", "core.autocrlf=false", origin, root);
  git(root, "remote", "set-url", "origin", origin);
  if (!trackedPersonality)
    write(root, "artifacts/PERSONALITY.md", "local personality never replaced\n");
  write(root, "memory/local.md", "local lived memory\n");
  write(root, ".git/info/exclude", "ignored-local\n");
  write(root, "ignored-local", "ignored memory preserved\n");
  write(origin, "AGENTS.md", "approved next instructions\n");
  write(origin, "instructions/new.md", "approved\n");
  if (trackedPersonality)
    write(
      origin,
      "artifacts/PERSONALITY.md",
      "# Personal instructions\napproved owner instructions\n",
    );
  git(origin, "add", ".");
  git(origin, "commit", "-m", "approved");
  const after = git(origin, "rev-parse", "HEAD");
  const plan = {
    version: 1,
    role: "workspace",
    operatorApproved: true,
    transactionRoot,
    workspace: { approved: true, root, origin, expectedHead: before, expectedRevision: after },
  };
  const planFile = path.join(base, "plan.json");
  const save = () => fs.writeFileSync(planFile, JSON.stringify(plan));
  save();
  return { base, origin, root, before, after, plan, planFile, save, transactionRoot };
}
test("workspace-only CLI/API dryrun preserves entire tree and fetches nothing", async (t) => {
  const f = fixture(t),
    beforeTree = tree(f.base);
  const r = await bootstrap(f.planFile);
  assert.equal(r.workspaceRevision, f.before);
  assert.equal(r.sourceRevision, "not_updated");
  assert.equal(r.workspace.nextWake.personalityLoaded, "unknown");
  const cli = JSON.parse(
    execFileSync(process.execPath, ["scripts/aurore-bootstrap.mjs", "--plan", f.planFile], {
      encoding: "utf8",
      windowsHide: true,
    }),
  );
  assert.equal(cli.mode, "dryrun");
  assert.deepEqual(tree(f.base), beforeTree);
});
test("real fetch and FF preserve local memory, ignored files and identity; idempotent; rollback restores exact files", async (t) => {
  const f = fixture(t),
    original = tree(f.root);
  const r = await bootstrap(f.planFile, { apply: true });
  assert.equal(r.workspace.state, "fast_forwarded");
  assert.equal(r.workspaceRevision, f.after);
  assert.equal(r.loadedVersion.app, "unknown");
  assert.equal(r.workspace.nextWake.personalityLoaded, "unknown");
  assert.equal(
    fs.readFileSync(path.join(f.root, "AGENTS.md"), "utf8"),
    "approved next instructions\n",
  );
  for (const name of ["artifacts/PERSONALITY.md", "memory/local.md", "ignored-local", "sentinel"])
    assert.equal(
      hash(fs.readFileSync(path.join(f.root, name))),
      original[name.replaceAll("/", path.sep)],
    );
  const current = await bootstrap(f.planFile, { apply: true });
  assert.equal(current.workspace.state, "already_current");
  assert.equal(rollback(current.transaction).workspace.state, "not_modified");
  const restored = rollback(r.transaction);
  assert.equal(restored.state, "rolled_back");
  assert.equal(restored.workspace.workspaceRevision, f.before);
  assert.equal(fs.existsSync(path.join(f.root, "instructions/new.md")), false);
  assert.equal(fs.readFileSync(path.join(f.root, "AGENTS.md"), "utf8"), "previous instructions\n");
  assert.equal(rollback(r.transaction).workspace.state, "already_restored");
});
test("malformed/unapproved origin or head and dirty tracked files refuse before mutation", async (t) => {
  const f = fixture(t);
  for (const change of [
    { expectedHead: "0".repeat(40) },
    { origin: "https://example.invalid/unapproved.git" },
    { origin: "https://user:secret@example.invalid/repo.git" },
    { approved: false },
    { expectedRevision: "352dd86" },
    { shell: "echo forbidden" },
  ]) {
    const old = { ...f.plan.workspace };
    Object.assign(f.plan.workspace, change);
    f.save();
    const beforeTree = tree(f.base);
    await assert.rejects(bootstrap(f.planFile, { apply: true }));
    assert.deepEqual(tree(f.base), beforeTree);
    f.plan.workspace = old;
  }
  f.save();
  write(f.root, "AGENTS.md", "human changes\n");
  const beforeTree = tree(f.base);
  await assert.rejects(bootstrap(f.planFile, { apply: true }), /workspace_tracked_local_changes/);
  assert.deepEqual(tree(f.base), beforeTree);
});
test("divergence refuses without rewriting local commits or memory", async (t) => {
  const f = fixture(t);
  git(f.root, "config", "user.name", "Fixture");
  git(f.root, "config", "user.email", "fixture@example.invalid");
  write(f.root, "local-commit", "local\n");
  git(f.root, "add", "local-commit");
  git(f.root, "commit", "-m", "diverged");
  const head = git(f.root, "rev-parse", "HEAD");
  f.plan.workspace.expectedHead = head;
  f.save();
  const r = await bootstrap(f.planFile, { apply: true });
  assert.equal(r.state, "apply_failed");
  assert.equal(r.reason, "workspace_fast_forward_required");
  assert.equal(git(f.root, "rev-parse", "HEAD"), head);
  assert.equal(fs.readFileSync(path.join(f.root, "local-commit"), "utf8"), "local\n");
});
test("upstream PERSONALITY replacement and ignored/untracked collision are rejected safely", async (t) => {
  for (const name of [
    "artifacts/PERSONALITY.md",
    "ignored-local",
    "memory/local.md",
    "instructions/new.md",
  ]) {
    const f = fixture(t);
    if (name === "instructions/new.md") write(f.root, name, "local draft\n");
    else {
      write(f.origin, name, "upstream replacement\n");
      git(f.origin, "add", ".");
      git(f.origin, "commit", "-m", "collision");
      f.plan.workspace.expectedRevision = git(f.origin, "rev-parse", "HEAD");
    }
    f.save();
    const before = fs.existsSync(path.join(f.root, name))
      ? fs.readFileSync(path.join(f.root, name))
      : null;
    const r = await bootstrap(f.planFile, { apply: true });
    assert.equal(r.state, "apply_failed");
    assert.match(r.reason, /workspace_(personal_memory_change_refused|untracked_collision)/);
    assert.equal(git(f.root, "rev-parse", "HEAD"), f.before);
    if (before) assert.deepEqual(fs.readFileSync(path.join(f.root, name)), before);
  }
});
test("rollback refuses concurrent working files, index, HEAD and new untracked memory", async (t) => {
  for (const mutation of ["worktree", "index", "head", "memory"]) {
    const f = fixture(t);
    const r = await bootstrap(f.planFile, { apply: true });
    assert.equal(r.workspaceRevision, f.after);
    if (mutation === "worktree") write(f.root, "AGENTS.md", "concurrent edit\n");
    if (mutation === "index") {
      write(f.root, "sentinel", "staged edit\n");
      git(f.root, "add", "sentinel");
    }
    if (mutation === "head") {
      git(f.root, "config", "user.name", "Fixture");
      git(f.root, "config", "user.email", "fixture@example.invalid");
      write(f.root, "sentinel", "commit\n");
      git(f.root, "add", "sentinel");
      git(f.root, "commit", "-m", "concurrent");
    }
    if (mutation === "memory") write(f.root, "memory/local.md", "new lived memory\n");
    const before = tree(f.root);
    const rr = rollback(r.transaction);
    assert.equal(rr.state, "rollback_conflict");
    assert.equal(rr.workspace.state, "concurrent_change_preserved");
    assert.deepEqual(tree(f.root), before);
  }
});
test("CAS guard between preflight/apply and backup tamper preserve workspace", async (t) => {
  const f = fixture(t),
    w = preflightWorkspace(f.plan.workspace);
  const tx = new FileTransaction(path.join(f.transactionRoot, "guard-test"));
  write(f.root, "memory/local.md", "concurrent memory\n");
  assert.throws(() => applyWorkspace(w, tx), /workspace_concurrent_change/);
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.before);
  const g = fixture(t),
    r = await bootstrap(g.planFile, { apply: true });
  const journal = JSON.parse(fs.readFileSync(path.join(r.transaction, "journal.json")));
  const backup = journal.workspaceUpdate.files.find((f) => f.backup).backup;
  fs.writeFileSync(path.join(r.transaction, backup), "corrupt");
  const before = tree(g.root);
  assert.throws(() => rollback(r.transaction), /workspace_backup_hash_mismatch/);
  assert.deepEqual(tree(g.root), before);
});
test("existing main sync lock blocks preflight and rollback without deleting another owner's lock", async (t) => {
  const f = fixture(t),
    lock = path.join(f.root, ".git/mind-wake-workspace-sync.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const before = tree(f.base);
  await assert.rejects(
    bootstrap(f.planFile, { apply: true }),
    /workspace_git_operation_in_progress/,
  );
  assert.deepEqual(tree(f.base), before);
  fs.unlinkSync(lock);
  const w = preflightWorkspace(f.plan.workspace),
    tx = new FileTransaction(path.join(f.transactionRoot, "busy"));
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  assert.throws(() => applyWorkspace(w, tx), /workspace_sync_lock_busy/);
  assert.ok(fs.existsSync(lock));
  const g = fixture(t),
    r = await bootstrap(g.planFile, { apply: true });
  const otherLock = path.join(g.root, ".git/mind-wake-workspace-sync.lock");
  fs.writeFileSync(otherLock, JSON.stringify({ pid: process.pid }));
  const current = tree(g.root);
  assert.throws(() => rollback(r.transaction), /workspace_sync_lock_busy/);
  assert.deepEqual(tree(g.root), current);
});

test("replacement refs cannot hide protected changes in the approved commit", async (t) => {
  const f = fixture(t);
  const safeRevision = f.after;
  write(f.origin, "memory/protected.md", "never replace memory\n");
  git(f.origin, "add", "memory/protected.md");
  git(f.origin, "commit", "-m", "protected update");
  const protectedRevision = git(f.origin, "rev-parse", "HEAD");
  git(f.root, "fetch", "--no-write-fetch-head", f.origin, protectedRevision);
  git(f.root, "replace", protectedRevision, safeRevision);
  f.plan.workspace.expectedRevision = protectedRevision;
  f.save();
  const before = tree(f.base);
  await assert.rejects(
    bootstrap(f.planFile, { apply: true }),
    /workspace_personal_memory_change_refused/,
  );
  assert.deepEqual(tree(f.base), before);
});

function approveInstructions(f) {
  const name = "artifacts/PERSONALITY.md";
  f.plan.workspace.ownerInstructions = {
    approvedAfterLocalReview: true,
    path: name,
    beforeRevision: f.before,
    afterRevision: f.after,
    beforeBlob: git(f.origin, "rev-parse", f.before + ":" + name),
    afterBlob: git(f.origin, "rev-parse", f.after + ":" + name),
    beforeSha256: hash(Buffer.from(git(f.origin, "show", f.before + ":" + name) + "\n")),
    afterSha256: hash(Buffer.from(git(f.origin, "show", f.after + ":" + name) + "\n")),
  };
  f.save();
}
test("explicit reviewed exact instructions permit tracked skeleton FF, idempotence and exact rollback", async (t) => {
  const f = fixture(t, true);
  approveInstructions(f);
  const original = fs.readFileSync(path.join(f.root, "artifacts/PERSONALITY.md"));
  const beforeTree = tree(f.base);
  await bootstrap(f.planFile);
  assert.deepEqual(tree(f.base), beforeTree);
  const r = await bootstrap(f.planFile, { apply: true });
  assert.equal(r.workspaceRevision, f.after);
  assert.equal(r.workspace.ownerInstructions, "explicit_exact_versions_approved");
  assert.equal(r.workspace.nextWake.personalityLoaded, "unknown");
  assert.equal(
    hash(fs.readFileSync(path.join(f.root, "artifacts/PERSONALITY.md"))),
    f.plan.workspace.ownerInstructions.afterSha256,
  );
  assert.equal((await bootstrap(f.planFile, { apply: true })).workspace.state, "already_current");
  assert.equal(rollback(r.transaction).workspace.state, "restored");
  assert.deepEqual(fs.readFileSync(path.join(f.root, "artifacts/PERSONALITY.md")), original);
});
test("tracked instruction change without local choice refuses before transaction or fetch mutation", async (t) => {
  const f = fixture(t, true);
  git(f.root, "fetch", "--no-write-fetch-head", f.origin, f.after);
  const beforeTree = tree(f.base);
  await assert.rejects(
    bootstrap(f.planFile, { apply: true }),
    /workspace_personal_memory_change_refused/,
  );
  assert.deepEqual(tree(f.base), beforeTree);
});
test("instruction approval wrong path, commits, blobs, hashes or local review flag refuse exactly", async (t) => {
  const f = fixture(t, true);
  approveInstructions(f);
  git(f.root, "fetch", "--no-write-fetch-head", f.origin, f.after);
  const original = { ...f.plan.workspace.ownerInstructions };
  for (const change of [
    { approvedAfterLocalReview: false },
    { path: "memory/local.md" },
    { beforeRevision: "0".repeat(40) },
    { afterRevision: "0".repeat(40) },
    { beforeBlob: "0".repeat(40) },
    { afterBlob: "0".repeat(40) },
    { beforeSha256: "0".repeat(64) },
    { afterSha256: "0".repeat(64) },
    { extra: true },
  ]) {
    f.plan.workspace.ownerInstructions = { ...original, ...change };
    f.save();
    const beforeTree = tree(f.base);
    await assert.rejects(bootstrap(f.planFile, { apply: true }), /workspace_owner_instructions_/);
    assert.deepEqual(tree(f.base), beforeTree);
  }
});
test("local personalization dirty or committed refuses; approval never overrides local history", async (t) => {
  for (const committed of [false, true]) {
    const f = fixture(t, true);
    approveInstructions(f);
    write(f.root, "artifacts/PERSONALITY.md", "my own voice\n");
    if (committed) {
      git(f.root, "config", "user.name", "Fixture");
      git(f.root, "config", "user.email", "fixture@example.invalid");
      git(f.root, "add", ".");
      git(f.root, "commit", "-m", "personalized");
      f.plan.workspace.expectedHead = git(f.root, "rev-parse", "HEAD");
      f.save();
    }
    const beforeTree = tree(f.base);
    await assert.rejects(
      bootstrap(f.planFile, { apply: true }),
      /workspace_(tracked_local_changes|owner_instructions_approval_invalid)/,
    );
    assert.deepEqual(tree(f.base), beforeTree);
  }
});
test("instruction exception keeps other personal paths protected and rollback preserves concurrent personality", async (t) => {
  for (const name of [
    "memory/new.md",
    "memories/new.md",
    "relations/new.md",
    "artifacts/relations/new.md",
    "artifacts/memory/new.md",
    "AUTORISATIONS.json",
  ]) {
    const f = fixture(t, true);
    write(f.origin, name, "never authorize\n");
    git(f.origin, "add", ".");
    git(f.origin, "commit", "-m", "protected");
    f.after = git(f.origin, "rev-parse", "HEAD");
    f.plan.workspace.expectedRevision = f.after;
    approveInstructions(f);
    git(f.root, "fetch", "--no-write-fetch-head", f.origin, f.after);
    const beforeTree = tree(f.base);
    await assert.rejects(
      bootstrap(f.planFile, { apply: true }),
      /workspace_personal_memory_change_refused/,
    );
    assert.deepEqual(tree(f.base), beforeTree);
  }
  const f = fixture(t, true);
  approveInstructions(f);
  const r = await bootstrap(f.planFile, { apply: true });
  assert.equal(r.workspaceRevision, f.after);
  write(f.root, "artifacts/PERSONALITY.md", "new lived preference\n");
  const beforeTree = tree(f.root);
  assert.equal(rollback(r.transaction).workspace.state, "concurrent_change_preserved");
  assert.deepEqual(tree(f.root), beforeTree);
});
