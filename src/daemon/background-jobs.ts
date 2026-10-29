/** Local Node jobs owned by the daemon, independently of individual model turns. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { ProcessTreeSupervisor, type SessionProcess } from "../runner/process-tree.js";
import type { ProfileId, SessionId } from "../contracts/index.js";
import { runtimeDirFor } from "../runner/paths.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface BackgroundJob {
  id: string;
  title: string;
  script: string;
  args: string[];
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  detail: string | null;
  cancel: boolean;
}
interface Row {
  id: string;
  request_key: string;
  payload: string;
  notified: number;
}
export function jobOutputDir(dataDir: string, id: string): string {
  if (!/^job_[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid job ID");
  return path.join(dataDir, "workspace", "jobs", "runs", id);
}
export function resolveJobScript(dataDir: string, script: string): string {
  const root = fs.realpathSync(path.join(dataDir, "workspace"));
  const normalized = script.replaceAll("\\", "/");
  if (!normalized.startsWith("jobs/") || !normalized.endsWith(".mjs"))
    throw new Error("Create a Node .mjs script under workspace/jobs/ first");
  const file = fs.realpathSync(path.resolve(root, script));
  const rel = path.relative(root, file);
  if (
    !rel.replaceAll("\\", "/").startsWith("jobs/") ||
    path.isAbsolute(rel) ||
    !fs.statSync(file).isFile()
  )
    throw new Error("Job script must stay in the Wake workspace");
  return file;
}
export class BackgroundJobStore {
  readonly db: Database.Database;
  constructor(readonly dataDir: string) {
    const file = path.join(dataDir, "background-jobs.sqlite");
    if (fs.existsSync(file)) {
      const s = fs.lstatSync(file);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new Error("Invalid job store");
    }
    this.db = new Database(file);
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0)",
    );
  }
  close(): void {
    this.db.close();
  }
  list(): BackgroundJob[] {
    return (this.db.prepare("SELECT * FROM jobs ORDER BY rowid").all() as Row[]).map(
      (r) => JSON.parse(r.payload) as BackgroundJob,
    );
  }
  get(id: string): BackgroundJob {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error("Unknown background job");
    return JSON.parse(row.payload) as BackgroundJob;
  }
  submit(title: string, script: string, args: string[], key: string): BackgroundJob {
    return this.db
      .transaction(() => {
        const prior = this.db.prepare("SELECT * FROM jobs WHERE request_key=?").get(key) as
          Row | undefined;
        if (prior) {
          const job = JSON.parse(prior.payload) as BackgroundJob;
          if (
            JSON.stringify([job.title, job.script, job.args]) !==
            JSON.stringify([title, script, args])
          )
            throw new Error("Idempotency key already used for another job");
          return job;
        }
        resolveJobScript(this.dataDir, script);
        const job: BackgroundJob = {
          id: `job_${randomUUID()}`,
          title,
          script,
          args,
          status: "queued",
          createdAt: new Date().toISOString(),
          startedAt: null,
          endedAt: null,
          exitCode: null,
          detail: null,
          cancel: false,
        };
        this.db
          .prepare("INSERT INTO jobs(id,request_key,payload) VALUES(?,?,?)")
          .run(job.id, key, JSON.stringify(job));
        return job;
      })
      .immediate();
  }
  update(id: string, patch: Partial<BackgroundJob>): BackgroundJob {
    return this.db
      .transaction(() => {
        const job = { ...this.get(id), ...patch, id };
        this.db.prepare("UPDATE jobs SET payload=? WHERE id=?").run(JSON.stringify(job), id);
        return job;
      })
      .immediate();
  }
  cancel(id: string): BackgroundJob {
    const job = this.get(id);
    return this.update(
      id,
      job.status === "queued"
        ? { cancel: true, status: "cancelled", endedAt: new Date().toISOString() }
        : { cancel: true },
    );
  }
  events(take = false): string[] {
    return this.db
      .transaction(() => {
        const rows = this.db.prepare("SELECT * FROM jobs WHERE notified=0").all() as Row[];
        const terminal = rows.filter(
          (r) => !["queued", "running"].includes((JSON.parse(r.payload) as BackgroundJob).status),
        );
        if (take)
          for (const row of terminal)
            this.db.prepare("UPDATE jobs SET notified=1 WHERE id=?").run(row.id);
        return terminal.map((r) => {
          const j = JSON.parse(r.payload) as BackgroundJob;
          return `Background job ${j.id} (${j.title}): ${j.status}. Exit: ${j.exitCode ?? "unknown"}. Results and logs: jobs/runs/${j.id}/. ${j.detail ?? ""}`;
        });
      })
      .immediate();
  }
}

export class BackgroundJobs {
  readonly store: BackgroundJobStore;
  readonly supervisor: ProcessTreeSupervisor;
  readonly running = new Map<string, { process: SessionProcess; finished: Promise<void> }>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #busy = false;
  #closed = false;
  readonly #profile = "background-jobs" as ProfileId;
  constructor(
    readonly dataDir: string,
    readonly allowed: () => boolean,
  ) {
    this.store = new BackgroundJobStore(dataDir);
    this.supervisor = new ProcessTreeSupervisor(runtimeDirFor(dataDir));
  }
  start(): void {
    // A daemon crash kills its jobs. Never replay a potentially side-effectful task.
    for (const job of this.store.list().filter((j) => j.status === "running")) {
      const result = this.supervisor.terminate(this.#profile, job.id as SessionId);
      if (!result.confirmed) throw new Error(`Cannot reconcile background job ${job.id}`);
      this.store.update(job.id, {
        status: "interrupted",
        endedAt: new Date().toISOString(),
        detail: "Previous daemon ended; not automatically replayed",
      });
    }
    this.#timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, 500);
    this.#timer.unref();
  }
  async tick(): Promise<void> {
    if (this.#closed || this.#busy) return;
    this.#busy = true;
    try {
      let allowed = false;
      try { allowed = this.allowed(); } catch { /* Unreadable controls must stop work too. */ }
      if (!allowed) {
        for (const [id, active] of this.running)
          await this.#stop(id, active.process, "Wake paused, stopped or no longer authorized");
        return;
      }
      for (const job of this.store.list()) {
        const active = this.running.get(job.id);
        if (job.cancel && (job.status === "queued" || job.status === "running")) {
          if (active) await this.#stop(job.id, active.process, "Cancelled by agent", "cancelled");
          else
            this.store.update(job.id, { status: "cancelled", endedAt: new Date().toISOString() });
        } else if (job.status === "queued" && !active) await this.#launch(job);
      }
    } finally {
      this.#busy = false;
    }
  }
  async #launch(job: BackgroundJob): Promise<void> {
    try {
      const script = resolveJobScript(this.dataDir, job.script);
      const out = jobOutputDir(this.dataDir, job.id);
      fs.mkdirSync(out, { recursive: true });
      // No shell or implicit credentials. This is the existing authorized host mode.
      const child = this.supervisor.spawn(this.#profile, job.id as SessionId, {
        executable: process.execPath,
        args: [
          fileURLToPath(new URL("../../scripts/background-job-worker.mjs", import.meta.url)),
          script,
          out,
          ...job.args,
        ],
        cwd: path.join(this.dataDir, "workspace"),
        env: {
          PATH: process.env["PATH"] ?? process.env["Path"] ?? "",
          MIND_WAKE_JOB_ID: job.id,
          MIND_WAKE_JOB_OUTPUT: out,
        },
      });
      const finished = (async () => {
        try {
          await child.started();
          if (this.store.get(job.id).status === "queued")
            this.store.update(job.id, { status: "running", startedAt: new Date().toISOString() });
          const exit = await child.exited;
          if (this.store.get(job.id).status === "running")
            this.store.update(job.id, {
              status: exit.mainExitCode === 0 ? "succeeded" : "failed",
              exitCode: exit.mainExitCode,
              endedAt: new Date().toISOString(),
              detail: exit.killReason,
            });
        } catch (error) {
          await child.terminateTree();
          this.store.update(job.id, {
            status: "failed",
            endedAt: new Date().toISOString(),
            detail: String(error),
          });
        } finally {
          this.running.delete(job.id);
        }
      })();
      this.running.set(job.id, { process: child, finished });
    } catch (error) {
      this.store.update(job.id, {
        status: "failed",
        endedAt: new Date().toISOString(),
        detail: String(error),
      });
    }
  }
  async #stop(
    id: string,
    child: SessionProcess,
    detail: string,
    status: JobStatus = "interrupted",
  ): Promise<void> {
    const result = await child.terminateTree();
    if (result.confirmed)
      this.store.update(id, { status, endedAt: new Date().toISOString(), detail });
  }
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    while (this.#busy) await new Promise((resolve) => setTimeout(resolve, 10));
    for (const [id, active] of this.running) await this.#stop(id, active.process, "Daemon stopped");
    await Promise.all([...this.running.values()].map((r) => r.finished));
    this.store.close();
  }
}

/** Emergency stop also works from a separate CLI when the daemon cannot respond. */
export function terminateBackgroundJobs(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): {
  sessionId: string;
  processFound: boolean | null;
  confirmed: boolean;
  elapsedMs: number;
  detail: string | null;
}[] {
  if (!fs.existsSync(path.join(dataDir, "background-jobs.sqlite"))) return [];
  const store = new BackgroundJobStore(dataDir);
  try {
    const supervisor = new ProcessTreeSupervisor(runtimeDirFor(dataDir), platform);
    return store
      .list()
      .filter((j) => j.status === "queued" || j.status === "running")
      .map((job) => {
        const result = supervisor.terminate("background-jobs" as ProfileId, job.id as SessionId);
        if (result.confirmed)
          store.update(job.id, {
            status: "interrupted",
            endedAt: new Date().toISOString(),
            detail: "Emergency stop",
          });
        return {
          sessionId: job.id,
          processFound: result.found,
          confirmed: result.confirmed,
          elapsedMs: result.elapsedMs,
          detail: result.detail ?? null,
        };
      });
  } finally {
    store.close();
  }
}
