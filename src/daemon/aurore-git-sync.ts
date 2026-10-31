/** Fixed read replica, owned by the existing daemon maintenance loop. Never pushes. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { git } from "./supervised-git.js";

export const AURORE_ORIGIN = "https://github.com/mind-protocol/scisense-aurore-workspace.git";
export const AURORE_SYNC_INTERVAL = 60_000;
type Run = (cwd: string, args: readonly string[], signal: AbortSignal) => Promise<string>;
type State = {
  status: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  error: string | null;
  version: string | null;
};
function confined(base: string, relative: string): string {
  let cursor = base;
  for (const part of relative.split("/")) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && stat.nlink !== 1))
      throw Error("Linked Aurore path refused");
  }
  const real = fs.realpathSync(cursor),
    rel = path.relative(base, real);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel))
    throw Error("Aurore path escaped");
  return real;
}
function localJson(base: string, relative: string): unknown {
  const file = confined(base, relative);
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > 4096)
    throw Error("Invalid Aurore control file");
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}
function enabled(base: string): boolean {
  if (!fs.existsSync(path.join(base, "atelier-aurore.json"))) return false;
  const c = localJson(base, "atelier-aurore.json") as Record<string, unknown>;
  if (c["enabled"] !== true) return false;
  if (
    Object.keys(c).some((k) => !["enabled", "origin"].includes(k)) ||
    c["origin"] !== AURORE_ORIGIN
  )
    throw Error("Invalid fixed Aurore origin");
  return true;
}
/** Refuse links anywhere in the replica, including Git metadata and untracked paths. */
function noLinks(base: string): void {
  const pending = [base];
  let count = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const item of fs.readdirSync(directory)) {
      if (++count > 100_000) throw Error("Aurore path validation limit reached");
      const file = path.join(directory, item),
        stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && stat.nlink !== 1))
        throw Error("Linked Aurore path refused");
      if (stat.isDirectory()) pending.push(file);
    }
  }
}
const isolatedEnvironment = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
};
export const runAuroreGit: Run = (cwd, args, signal) => git(cwd, args, signal, isolatedEnvironment);
export class AuroreGitSync {
  #flight: Promise<void> | null = null;
  #controller: AbortController | null = null;
  #closed = false;
  #state: State = {
    status: "waiting",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextRunAt: null,
    error: null,
    version: null,
  };
  constructor(
    readonly dir: string,
    private readonly allowed: () => boolean,
    private readonly now: () => number = Date.now,
    // Dependency injection is code-only, never installation config or a renderer argument.
    private readonly execute: Run = runAuroreGit,
  ) {
    try {
      const value = localJson(fs.realpathSync(dir), "aurore-sync-state.json") as State;
      if (
        [value.lastSuccessAt, value.nextRunAt].every(
          (v) => v === null || (typeof v === "string" && Number.isFinite(Date.parse(v))),
        )
      )
        this.#state = {
          ...this.#state,
          lastSuccessAt: value.lastSuccessAt,
          nextRunAt: value.nextRunAt,
        };
    } catch {
      /* First start, or invalid status; never a permission source. */
    }
  }
  tick(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#flight) return this.#flight;
    this.#flight = this.#cycle().finally(() => {
      this.#flight = null;
    });
    return this.#flight;
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#controller?.abort();
    await this.#flight;
  }
  #isAllowed(): boolean {
    try {
      return !this.#closed && this.allowed();
    } catch {
      return false;
    }
  }
  #save(base: string): void {
    if (fs.existsSync(path.join(base, "aurore-sync-state.json"))) {
      const previous = localJson(base, "aurore-sync-state.json");
      if (JSON.stringify(previous) === JSON.stringify(this.#state)) return;
    }
    const temp = path.join(base, `aurore-sync-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, JSON.stringify(this.#state), { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, path.join(base, "aurore-sync-state.json"));
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  async #cycle(): Promise<void> {
    const base = fs.realpathSync(this.dir),
      state = this.#state;
    const cycleStartedAt = this.now();
    const stamp = () => new Date(this.now()).toISOString();
    const controller = new AbortController();
    this.#controller = controller;
    const guard = () => {
      try {
        if (!controller.signal.aborted && this.#isAllowed() && enabled(base)) return;
      } catch {
        /* Unreadable or invalid controls also revoke the active operation. */
      }
      controller.abort();
      throw Error("Aurore synchronisation stopped by controls");
    };
    let attempted = false,
      lock: string | null = null,
      lockToken = "",
      monitor: ReturnType<typeof setInterval> | undefined;
    try {
      if (!enabled(base)) {
        state.status = "disabled";
        state.nextRunAt = null;
        this.#save(base);
        return;
      }
      if (!this.#isAllowed()) {
        state.status = "paused";
        state.nextRunAt = null;
        this.#save(base);
        return;
      }
      if (state.nextRunAt && Date.parse(state.nextRunAt) > this.now()) return;
      attempted = true;
      state.lastAttemptAt = stamp();
      state.status = "running";
      state.error = null;
      this.#save(base);
      const clone = confined(base, "linked-workspaces/aurore-mind-protocol");
      const dotgit = confined(clone, ".git");
      if (!fs.statSync(dotgit).isDirectory()) throw Error("Internal Aurore Git directory required");
      noLinks(clone);
      const run = async (args: readonly string[]) => {
        guard();
        const result = await this.execute(
          clone,
          [
            "--no-pager",
            "-c",
            "core.hooksPath=",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "submodule.recurse=false",
            "-c",
            "gc.auto=0",
            "-c",
            "maintenance.auto=false",
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.https.allow=always",
            ...args,
          ],
          controller.signal,
        );
        guard();
        return result;
      };
      monitor = setInterval(() => {
        try {
          guard();
        } catch {
          /* abort active supervised command */
        }
      }, 100);
      // Cooperating readers/writers must use this same scoped lock. Never remove another owner.
      const candidate = path.join(dotgit, "mind-wake-workspace-sync.lock");
      lockToken = JSON.stringify({ pid: process.pid, token: randomUUID() });
      try {
        fs.writeFileSync(candidate, lockToken, { flag: "wx", mode: 0o600 });
        lock = candidate;
      } catch {
        throw Error("Aurore sync lock held; inspect owner locally (never removed automatically)");
      }
      const config = await run(["config", "--local", "--no-includes", "--list", "-z"]);
      const allowedKeys =
        /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|symlinks|ignorecase|longpaths)|remote\.origin\.(url|fetch)|branch\.main\.(remote|merge)|user\.(name|email))$/;
      const records = config
        .split("\0")
        .filter(Boolean)
        .map((v) => {
          const separator = v.indexOf("\n");
          return [v.slice(0, separator), v.slice(separator + 1)];
        });
      if (records.some((v) => !allowedKeys.test(v[0] ?? "")))
        throw Error(
          "Unsupported Aurore local Git configuration (includes, filters and executable helpers refused)",
        );
      const origins = records.filter((v) => v[0] === "remote.origin.url").map((v) => v[1]);
      if (origins.length !== 1 || origins[0] !== AURORE_ORIGIN)
        throw Error("Invalid fixed Aurore origin");
      const validate = async () => {
        if ((await run(["symbolic-ref", "HEAD"])) !== "refs/heads/main")
          throw Error("Aurore requires branch main");
        if (await run(["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"]))
          throw Error("Aurore clone dirty; last committed documents retained");
        for (const marker of [
          "MERGE_HEAD",
          "CHERRY_PICK_HEAD",
          "REVERT_HEAD",
          "rebase-apply",
          "rebase-merge",
          "index.lock",
        ])
          if (fs.existsSync(path.join(dotgit, marker)))
            throw Error("Aurore Git operation unfinished; resolve locally");
      };
      await validate();
      const before = await run(["rev-parse", "HEAD"]);
      // Explicit fixed URL/ref, no remote helper, no push, no recursion or opportunistic maintenance.
      await run([
        "-c",
        "credential.helper=",
        ...(process.platform === "win32" ? ["-c", "credential.helper=manager"] : []),
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        AURORE_ORIGIN,
        "refs/heads/main",
      ]);
      const target = await run(["rev-parse", "FETCH_HEAD^{commit}"]);
      const counts = (await run(["rev-list", "--left-right", "--count", `${before}...${target}`]))
        .split(/\s+/)
        .map(Number);
      if (counts.length !== 2 || counts[0] !== 0 || !Number.isSafeInteger(counts[1]))
        throw Error("Aurore history diverged or local main ahead; last documents retained");
      const tree = await run(["ls-tree", "-r", target]);
      if (tree.split("\n").some((line) => line && !/^(100644|100755) blob /.test(line)))
        throw Error("Aurore incoming symlink/submodule refused");
      noLinks(clone);
      await validate();
      if ((await run(["rev-parse", "HEAD"])) !== before)
        throw Error("Aurore revision changed concurrently");
      if (before !== target) await run(["merge", "--ff-only", "--no-edit", "--no-stat", target]);
      state.version = await run(["rev-parse", "HEAD"]);
      state.status = "ok";
      state.lastSuccessAt = stamp();
      state.error = null;
    } catch (error) {
      state.status = !this.#isAllowed() || controller.signal.aborted ? "paused" : "error";
      state.error = error instanceof Error ? error.message : "Aurore sync failed";
    } finally {
      if (monitor) clearInterval(monitor);
      if (lock && fs.existsSync(lock)) {
        const stat = fs.lstatSync(lock);
        if (
          stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.nlink === 1 &&
          fs.readFileSync(lock, "utf8") === lockToken
        )
          fs.unlinkSync(lock);
      }
      if (attempted || state.status === "error")
        state.nextRunAt =
          state.status === "disabled" || state.status === "paused"
            ? null
            : new Date(cycleStartedAt + AURORE_SYNC_INTERVAL).toISOString();
      this.#controller = null;
      this.#save(base);
    }
  }
}
