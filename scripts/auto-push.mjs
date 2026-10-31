#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

export const samePath = (a, b) =>
  process.platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
export function gitEnvironment(env = process.env) {
  const clean = { ...env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_PREFIX",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ])
    delete clean[name];
  return clean;
}
export function git(repo, args, env = process.env) {
  return spawnSync("git", ["-C", repo, ...args], {
    env: gitEnvironment(env),
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1_048_576,
  });
}
function value(repo, args, env) {
  const result = git(repo, args, env);
  if (result.status !== 0) throw Error("Git metadata unavailable");
  return result.stdout.trim();
}
export function gitContext(repo, env = process.env) {
  const root = fs.realpathSync(value(path.resolve(repo), ["rev-parse", "--show-toplevel"], env));
  const gitDir = fs.realpathSync(value(root, ["rev-parse", "--absolute-git-dir"], env));
  const commonDir = fs.realpathSync(
    value(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], env),
  );
  return { root, gitDir, commonDir };
}
function oneConfig(repo, key, env) {
  const result = git(repo, ["config", "--null", "--get-all", key], env);
  if (result.status !== 0) return null;
  const values = result.stdout.split("\0").filter((value) => value !== "");
  return values.length === 1 ? values[0] : null;
}
function failureReason(result) {
  if (result.timedOut) return "push timed out";
  const output = result.output ?? "";
  if (/non-fast-forward|\[rejected\]|fetch first/i.test(output))
    return "remote branch diverged or requires a fast-forward";
  if (
    /authentication|permission denied|terminal prompts disabled|could not read Username|publickey/i.test(
      output,
    )
  )
    return "authentication refused or unavailable without interaction";
  return "push failed; inspect the remote/authentication with a manual git push";
}
function push(repo, args, env, timeoutMs) {
  return new Promise((resolve) => {
    let output = "",
      settled = false;
    const child = spawn("git", ["-C", repo, ...args], {
      cwd: repo,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(result);
    };
    const collect = (chunk) => {
      output = (output + chunk.toString()).slice(-8192);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      // Kill only this child tree. Never wait indefinitely on inherited SSH/helper pipes.
      if (Number.isSafeInteger(child.pid) && child.pid > 0) {
        if (process.platform === "win32")
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 5000,
          });
        else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        }
      }
      child.unref();
      finish({ status: null, timedOut: true, output });
    }, timeoutMs);
    child.on("error", () => finish({ status: null, output }));
    child.on("exit", (status) => finish({ status, output }));
  });
}

/** Push exactly the captured commit to the existing upstream; no local ref mutation. */
export async function autoPush({
  repo,
  gitDir,
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 45_000,
}) {
  const skipped = (reason) => ({ state: "skipped", reason });
  if (env.MIND_WAKE_AUTO_PUSH_RUNNING === "1")
    return skipped("reentrant invocation; commit kept, push manually");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000)
    throw Error("Invalid push timeout");
  const context = gitContext(cwd, env);
  if (
    !samePath(context.root, fs.realpathSync(repo)) ||
    !samePath(context.gitDir, fs.realpathSync(gitDir))
  )
    return skipped("hook belongs to another checkout; no push");
  const branchResult = git(context.root, ["symbolic-ref", "--quiet", "--short", "HEAD"], env);
  if (branchResult.status !== 0)
    return skipped("detached HEAD; commit kept, select an upstream branch and push manually");
  const branch = branchResult.stdout.trim(),
    commit = value(context.root, ["rev-parse", "--verify", "HEAD^{commit}"], env);
  const remote = oneConfig(context.root, `branch.${branch}.remote`, env),
    merge = oneConfig(context.root, `branch.${branch}.merge`, env);
  if (
    !remote ||
    remote === "." ||
    !merge?.startsWith("refs/heads/") ||
    git(context.root, ["check-ref-format", merge], env).status !== 0
  )
    return skipped(
      "no single explicit remote upstream; commit kept, configure upstream and push manually",
    );
  if (git(context.root, ["rev-parse", "--verify", "@{upstream}^{commit}"], env).status !== 0)
    return skipped(
      "upstream tracking ref unavailable; commit kept, fetch/check upstream and push manually",
    );
  const urls = git(context.root, ["remote", "get-url", "--push", "--all", remote], env);
  if (urls.status !== 0 || urls.stdout.trim().split(/\r?\n/).filter(Boolean).length !== 1)
    return skipped("remote has no unique push destination; commit kept, push manually");
  const lock = path.join(context.gitDir, "mind-auto-push.lock"),
    nonce = randomBytes(16).toString("hex");
  let fd;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, commit, nonce }) + "\n");
    fs.closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error.code === "EEXIST")
      return skipped(
        "another push or stale auto-push lock exists; commit kept, inspect the lock and push manually",
      );
    throw error;
  }
  try {
    if (
      value(context.root, ["symbolic-ref", "--quiet", "--short", "HEAD"], env) !== branch ||
      value(context.root, ["rev-parse", "--verify", "HEAD^{commit}"], env) !== commit
    )
      return skipped("branch/HEAD changed during preparation; commit kept, push manually");
    const nonInteractive = {
      ...gitEnvironment(env),
      MIND_WAKE_AUTO_PUSH_RUNNING: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      SSH_ASKPASS_REQUIRE: "never",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=15",
    };
    const result = await push(
      context.root,
      [
        "-c",
        "core.askPass=",
        "-c",
        `remote.${remote}.mirror=false`,
        "push",
        "--porcelain",
        "--no-mirror",
        "--no-follow-tags",
        "--recurse-submodules=no",
        "--",
        remote,
        `${commit}:${merge}`,
      ],
      nonInteractive,
      timeoutMs,
    );
    return result.status === 0
      ? { state: "pushed", commit, remote, ref: merge }
      : {
          state: "failed",
          commit,
          reason: failureReason(result) + "; local commit kept, push manually",
        };
  } finally {
    // Never remove somebody else's replacement lock or follow a symbolic link.
    try {
      const stat = fs.lstatSync(lock);
      if (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1 &&
        JSON.parse(fs.readFileSync(lock, "utf8")).nonce === nonce
      )
        fs.unlinkSync(lock);
    } catch {
      /* Keep an ambiguous lock for manual inspection. */
    }
  }
}
if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const { values } = parseArgs({
      options: { repo: { type: "string" }, "git-dir": { type: "string" } },
    });
    if (!values.repo || !values["git-dir"]) throw Error("--repo and --git-dir required");
    const result = await autoPush({ repo: values.repo, gitDir: values["git-dir"] });
    process.stderr.write(
      `[auto-push] ${result.state === "pushed" ? `pushed ${result.commit.slice(0, 12)} to its configured upstream` : result.reason}.\n`,
    );
    if (result.state === "failed") process.exitCode = 1;
  } catch {
    process.stderr.write(
      "[auto-push] unavailable; local commit kept. Inspect the hook and run git push manually.\n",
    );
    process.exitCode = 1;
  }
}
