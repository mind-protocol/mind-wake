/** Active-workspace Git update only. Never activates a runtime or rewrites local identity. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const digest = (b) => createHash("sha256").update(b).digest("hex");
const fail = (code) => {
  throw Error(code);
};
function syncLock(root, action) {
  // Same exclusive lock and strict {pid} schema as the existing 60s sync owner.
  const file = path.join(root, ".git", "mind-wake-workspace-sync.lock");
  const contents = JSON.stringify({ pid: process.pid });
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch {
    fail("workspace_sync_lock_busy");
  }
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    return action();
  } finally {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === contents) fs.unlinkSync(file);
  }
}
function git(root, args, encoding = "utf8") {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^GIT_|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE/i.test(k),
    ),
  );
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GCM_INTERACTIVE: "Never",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
  });
  try {
    return execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "submodule.recurse=false",
        "-c",
        "core.askPass=",
        "-c",
        "credential.interactive=false",
        ...args,
      ],
      {
        cwd: root,
        env,
        windowsHide: true,
        encoding,
        timeout: 45000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    fail("workspace_git_command_refused");
  }
}
const readHead = (root) => git(root, ["rev-parse", "HEAD"]).trim();
const status = (root) => git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
function fileState(root, name) {
  const f = path.join(root, name);
  try {
    const s = fs.lstatSync(f);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) fail("workspace_special_file_refused");
    if (fs.realpathSync.native(f).toLowerCase() !== path.resolve(f).toLowerCase())
      fail("workspace_redirected_file");
    return digest(fs.readFileSync(f));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
function fingerprint(root) {
  const s = status(root);
  // All tracked changes are refused conservatively; untracked memories remain permitted.
  const lines = s.split("\0").filter(Boolean);
  if (lines.some((v) => !v.startsWith("?? "))) fail("workspace_tracked_local_changes");
  const untracked = lines.map((v) => [v.slice(3), fileState(root, v.slice(3))]);
  const index = git(root, ["rev-parse", "--git-path", "index"]).trim();
  return digest(
    JSON.stringify({
      head: readHead(root),
      s,
      untracked,
      index: digest(fs.readFileSync(path.resolve(root, index))),
    }),
  );
}
function targetExists(root, revision) {
  try {
    return git(root, ["rev-parse", "--verify", revision + "^{commit}"]).trim() === revision;
  } catch {
    return false;
  }
}
function changes(root, before, after) {
  // -z avoids Git quoted filenames. No rename inference: preserve explicit old/new paths.
  return git(root, ["diff", "--no-renames", "--name-only", "-z", before, after, "--"])
    .split("\0")
    .filter(Boolean);
}
const protectedPath = (name) =>
  /^(?:artifacts\/(?:PERSONALITY\.md|relations(?:\/|$)|memory(?:\/|$))|memory(?:\/|$)|memories(?:\/|$)|relations(?:\/|$)|AUTORISATIONS\.json$)/i.test(
    name,
  );
const instructionPath = "artifacts/PERSONALITY.md";
function validateInstructionApproval(plan) {
  const a = plan.ownerInstructions;
  if (a === undefined) return;
  const fields = [
    "approvedAfterLocalReview",
    "path",
    "beforeRevision",
    "afterRevision",
    "beforeBlob",
    "afterBlob",
    "beforeSha256",
    "afterSha256",
  ];
  if (
    !a ||
    typeof a !== "object" ||
    Array.isArray(a) ||
    Object.keys(a).length !== fields.length ||
    Object.keys(a).some((k) => !fields.includes(k)) ||
    a.approvedAfterLocalReview !== true ||
    a.path !== instructionPath ||
    a.beforeRevision !== plan.expectedHead ||
    a.afterRevision !== plan.expectedRevision ||
    ![a.beforeBlob, a.afterBlob].every((v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v)) ||
    ![a.beforeSha256, a.afterSha256].every((v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))
  )
    fail("workspace_owner_instructions_approval_invalid");
}
function verifyInstructionVersion(root, revision, blob, sha) {
  const entry = git(root, ["ls-tree", "-z", revision, "--", instructionPath]);
  if (
    entry !== `100644 blob ${blob}	${instructionPath}\0` ||
    digest(git(root, ["cat-file", "blob", blob], null)) !== sha
  )
    fail("workspace_owner_instructions_version_mismatch");
}
function verifyInstructionApproval(w, targetAvailable) {
  const a = w.ownerInstructions;
  if (!a) return;
  verifyInstructionVersion(w.root, a.beforeRevision, a.beforeBlob, a.beforeSha256);
  if (targetAvailable)
    verifyInstructionVersion(w.root, a.afterRevision, a.afterBlob, a.afterSha256);
  const expectedLocal = w.before === a.afterRevision ? a.afterSha256 : a.beforeSha256;
  if (fileState(w.root, instructionPath) !== expectedLocal)
    fail("workspace_owner_instructions_local_content_mismatch");
}
function verifyTarget(w) {
  const { root, before, expectedRevision } = w;
  if (!targetExists(root, expectedRevision)) fail("workspace_revision_unavailable_after_fetch");
  if (git(root, ["merge-base", before, expectedRevision]).trim() !== before)
    fail("workspace_fast_forward_required");
  const names = changes(root, before, expectedRevision);
  verifyInstructionApproval(w, true);
  if (
    names.some((name) => protectedPath(name) && !(name === instructionPath && w.ownerInstructions))
  )
    fail("workspace_personal_memory_change_refused");
  for (const name of names) {
    const attribute = git(root, ["check-attr", "-z", "filter", "--", name]).split("\0")[2];
    if (!["unspecified", "unset"].includes(attribute)) fail("workspace_checkout_filter_refused");
  }
  for (const name of names) {
    if (/[\x00-\x1f]/.test(name)) fail("workspace_unsupported_filename");
    // Any local untracked collision, including ignored files, is refused before merge.
    const tracked = git(root, ["ls-files", "-z", "--", name]).split("\0").includes(name);
    if (!tracked && fs.existsSync(path.join(root, name))) fail("workspace_untracked_collision");
    fileState(root, name);
  }
  // Refuse filters, symlinks, submodules: no implicit commands or cross-repo mutation on checkout.
  for (const entry of git(root, ["ls-tree", "-r", expectedRevision]).split("\n"))
    if (/^(120000|160000) /.test(entry)) fail("workspace_symlink_or_submodule_refused");
  for (const attr of ["HEAD", expectedRevision]) {
    const attrs = git(root, ["ls-tree", "-r", "--name-only", attr])
      .split("\n")
      .filter((n) => /(^|\/)\.gitattributes$/.test(n));
    for (const f of attrs)
      if (/\bfilter\s*=/.test(git(root, ["show", attr + ":" + f])))
        fail("workspace_checkout_filter_refused");
  }
  return names;
}
export function preflightWorkspace(plan) {
  if (
    !plan ||
    typeof plan !== "object" ||
    Array.isArray(plan) ||
    Object.keys(plan).some(
      (k) =>
        ![
          "approved",
          "root",
          "origin",
          "expectedRevision",
          "expectedHead",
          "ownerInstructions",
        ].includes(k),
    )
  )
    fail("invalid_fields:workspace");
  if (
    plan.approved !== true ||
    !/^[a-f0-9]{40}$/.test(plan.expectedRevision) ||
    !/^[a-f0-9]{40}$/.test(plan.expectedHead)
  )
    fail("workspace_approved_full_revisions_required");
  validateInstructionApproval(plan);
  if (typeof plan.root !== "string" || !path.isAbsolute(plan.root))
    fail("workspace_absolute_root_required");
  const root = path.resolve(plan.root);
  if (
    fs.realpathSync.native(root).toLowerCase() !== root.toLowerCase() ||
    git(root, ["rev-parse", "--show-toplevel"]).trim().toLowerCase().replaceAll("\\", "/") !==
      root.toLowerCase().replaceAll("\\", "/")
  )
    fail("workspace_active_git_root_required");
  if (!fs.lstatSync(path.join(root, ".git")).isDirectory())
    fail("workspace_linked_worktree_refused");
  if (typeof plan.origin !== "string") fail("workspace_origin_required");
  if (!path.isAbsolute(plan.origin)) {
    let u;
    try {
      u = new URL(plan.origin);
    } catch {
      fail("workspace_exact_https_origin_required");
    }
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || !u.hostname)
      fail("workspace_exact_https_origin_required");
  }
  if (git(root, ["remote", "get-url", "--all", "origin"]).trim() !== plan.origin)
    fail("workspace_origin_mismatch");
  // Reject URL rewrites and custom external protocol helpers, even in local configuration.
  const config = git(root, ["config", "--list"]);
  if (/^url\..*\.insteadof=|^remote\.origin\.(?:vcs|uploadpack)=/im.test(config))
    fail("workspace_git_transport_override_refused");
  if (
    git(root, ["ls-files", "-v"])
      .split("\n")
      .some((line) => /^[a-zS] /.test(line))
  )
    fail("workspace_hidden_index_flags_refused");
  const before = readHead(root);
  if (before !== plan.expectedHead && before !== plan.expectedRevision)
    fail("workspace_head_changed");
  const branch = git(root, ["symbolic-ref", "-q", "HEAD"]).trim();
  for (const marker of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "index.lock",
    "mind-wake-workspace-sync.lock",
  ])
    if (fs.existsSync(path.join(root, ".git", marker))) fail("workspace_git_operation_in_progress");
  const w = { ...plan, root, before, branch, fingerprint: fingerprint(root) };
  const available = targetExists(root, plan.expectedRevision);
  verifyInstructionApproval(w, available);
  if (available) verifyTarget(w);
  w.report = {
    ownerInstructions: plan.ownerInstructions ? "explicit_exact_versions_approved" : "protected",
    workspaceRevision: before,
    expectedRevision: plan.expectedRevision,
    state: before === plan.expectedRevision ? "already_current" : "ready_for_approved_fetch_ff",
    nextWake: {
      state: "needs_next_wake_proof",
      personalityLoaded: "unknown",
      personalityPath: path.join(root, "artifacts/PERSONALITY.md"),
      expectedWorkspaceRevision: plan.expectedRevision,
    },
  };
  return w;
}
export function guardWorkspace(w) {
  if (
    readHead(w.root) !== w.before ||
    git(w.root, ["symbolic-ref", "-q", "HEAD"]).trim() !== w.branch ||
    git(w.root, ["remote", "get-url", "--all", "origin"]).trim() !== w.origin ||
    fingerprint(w.root) !== w.fingerprint
  )
    fail("workspace_concurrent_change");
}
export function applyWorkspace(w, tx, guard = () => {}) {
  return syncLock(w.root, () => applyLocked(w, tx, guard));
}
function applyLocked(w, tx, guard) {
  guard();
  guardWorkspace(w);
  if (w.before === w.expectedRevision) return w.report;
  // Fetch exact locally-approved object; no branch supplied by a peer, no FETCH_HEAD overwrite.
  git(w.root, [
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "--no-write-fetch-head",
    "--",
    w.origin,
    w.expectedRevision,
  ]);
  guard();
  guardWorkspace(w);
  const names = verifyTarget(w);
  const backupDir = path.join(tx.dir, "workspace-backups");
  fs.mkdirSync(backupDir, { mode: 0o700 });
  const files = names.map((name, i) => {
    const f = path.join(w.root, name),
      beforeHash = fileState(w.root, name);
    const backup = beforeHash === null ? null : path.join("workspace-backups", String(i));
    if (backup) {
      const fd = fs.openSync(path.join(tx.dir, backup), "wx", 0o600);
      try {
        fs.writeFileSync(fd, fs.readFileSync(f));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    return { name, beforeHash, backup };
  });
  tx.workspaceUpdate = {
    root: w.root,
    branch: w.branch,
    before: w.before,
    after: w.expectedRevision,
    files,
    state: "intent",
  };
  tx.save();
  guard();
  guardWorkspace(w);
  git(w.root, [
    "-c",
    "merge.autoStash=false",
    "merge",
    "--ff-only",
    "--no-autostash",
    "--no-edit",
    "--no-stat",
    w.expectedRevision,
  ]);
  if (readHead(w.root) !== w.expectedRevision) fail("workspace_revision_mismatch");
  for (const f of files) f.afterHash = fileState(w.root, f.name);
  tx.workspaceUpdate.state = "applied";
  tx.workspaceUpdate.afterFingerprint = fingerprint(w.root);
  tx.save();
  verifyInstructionApproval({ ...w, before: w.expectedRevision }, true);
  return { ...w.report, workspaceRevision: readHead(w.root), state: "fast_forwarded" };
}
export function rollbackWorkspace(record, transactionDir) {
  if (!record) return { state: "not_modified" };
  return syncLock(record.root, () => rollbackLocked(record, transactionDir));
}
function rollbackLocked(record, transactionDir) {
  const { root, before, after, branch, files } = record;
  if (readHead(root) === before && record.state === "intent") return { state: "not_modified" };
  if (readHead(root) === before && record.state === "applied") return { state: "already_restored" };
  if (record.state !== "applied") return { state: "workspace_needs_local_review" };
  try {
    if (
      readHead(root) !== after ||
      git(root, ["symbolic-ref", "-q", "HEAD"]).trim() !== branch ||
      fingerprint(root) !== record.afterFingerprint ||
      files.some((f) => fileState(root, f.name) !== f.afterHash)
    )
      return { state: "concurrent_change_preserved" };
  } catch {
    return { state: "concurrent_change_preserved" };
  }
  for (const f of files) {
    if (
      f.backup &&
      (!/^workspace-backups[\\/]\d+$/.test(f.backup) ||
        digest(fs.readFileSync(path.join(transactionDir, f.backup))) !== f.beforeHash)
    )
      fail("workspace_backup_hash_mismatch");
  }
  // Two-tree checkout protects local changes; update-ref compares the exact owned commit.
  // No reset, clean, stash, force branch switch or global Git configuration.
  git(root, ["read-tree", "-m", "-u", after, before]);
  for (const f of files)
    if (f.backup && fileState(root, f.name) !== f.beforeHash) {
      // Preserve the exact pre-update bytes even when checkout would apply CRLF conversion.
      const target = path.join(root, f.name),
        temporary = target + ".wake-rollback-" + process.pid;
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, fs.readFileSync(path.join(transactionDir, f.backup)));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, target);
    }
  git(root, ["update-ref", "-m", "Wake bootstrap rollback", branch, before, after]);
  return { state: "restored", workspaceRevision: readHead(root) };
}
