import { workspaceDirFor } from "./paths.js";
/** Local Node jobs owned by the daemon, independently of individual model turns. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { ProcessTreeSupervisor, type SessionProcess } from "../runner/process-tree.js";
import type { ProfileId, SessionId } from "../contracts/index.js";
import { runtimeDirFor } from "../runner/paths.js";
import { OwnerMessages } from "../communication/owner-messages.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface BackgroundJob {
  workspaceDir?: string;
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
  /**
   * Opt-in: une boucle longue (simulation, présence) relancée telle quelle quand elle a été
   * interrompue (Pause, Force-off, fin du moteur), dès que Wake l'autorise de nouveau, et
   * après un échec sans annulation (attente croissante, au plus 3 essais par heure). Jamais
   * après une annulation ou une fin normale.
   */
  relaunch?: boolean;
  /** Job qui a pris la suite de celui-ci après une interruption ou un échec. */
  relaunchedAs?: string;
  /** Relances automatiques après échec de cette boucle (ISO), transmises d'un job au suivant. */
  autoRetries?: string[];
  /** Échec d'une boucle `relaunch` : relance prévue à cette date (ISO). */
  retryAt?: string;
  /** Échec d'une boucle `relaunch` alors que les essais de l'heure sont épuisés. */
  retriesExhausted?: boolean;
  /** Clé de la dernière alerte « boucle arrêtée » déposée dans le fil principal. */
  alertKey?: string;
}

/** Attentes entre relances d'une boucle en échec : 30 s, 2 min, 10 min. */
export const RELAUNCH_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];
/** Fenêtre glissante du plafond d'essais (autant d'essais que d'attentes ci-dessus). */
export const RELAUNCH_RETRY_WINDOW_MS = 3_600_000;
/** Une boucle `relaunch` absente depuis plus longtemps est signalée. */
export const RELAUNCH_ABSENT_ALERT_MS = 600_000;
/** Au-delà, un arrêt ancien (antérieur à cette supervision) n'est plus signalé. */
const RELAUNCH_ALERT_HORIZON_MS = 86_400_000;
/** Même identité que les autres avis du runtime dans le fil principal (cf. elevenlabs-circuit). */
const RUNTIME_NOTICE_AGENT_ID = "claude-wake";

export interface DeadLoop {
  job: BackgroundJob;
  reason: "exhausted" | "absent";
  /** Depuis quand la boucle ne tourne plus (ISO). */
  since: string;
  key: string;
}
interface Row {
  id: string;
  request_key: string;
  payload: string;
  notified: number;
}
export function jobOutputDir(dataDir: string, id: string): string {
  if (!/^job_[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid job ID");
  let workspace = workspaceDirFor(dataDir);
  const file = path.join(dataDir, "background-jobs.sqlite");
  if (fs.existsSync(file)) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT payload FROM jobs WHERE id=?").get(id) as
        { payload: string } | undefined;
      if (row)
        workspace =
          (JSON.parse(row.payload) as BackgroundJob).workspaceDir ??
          path.join(dataDir, "workspace");
    } finally {
      db.close();
    }
  }
  return path.join(workspace, "jobs", "runs", id);
}
export function resolveJobScript(
  dataDir: string,
  script: string,
  workspace = workspaceDirFor(dataDir),
): string {
  const root = fs.realpathSync(workspace);
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
  submit(
    title: string,
    script: string,
    args: string[],
    key: string,
    options: { relaunch?: boolean; autoRetries?: string[] } = {},
  ): BackgroundJob {
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
          workspaceDir: workspaceDirFor(this.dataDir),
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
          ...(options.relaunch === true ? { relaunch: true } : {}),
          ...(options.relaunch === true && options.autoRetries?.length
            ? { autoRetries: options.autoRetries }
            : {}),
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
  /**
   * Relance les jobs `relaunch` interrompus : un nouveau job, même script et mêmes arguments,
   * clé dérivée de l'ancien (idempotente). L'ancien garde la trace de son successeur.
   */
  relaunchInterrupted(): BackgroundJob[] {
    return this.db
      .transaction(() => {
        const out: BackgroundJob[] = [];
        for (const job of this.list()) {
          if (job.relaunch !== true || job.status !== "interrupted" || job.relaunchedAs !== undefined)
            continue;
          const next = this.submit(job.title, job.script, job.args, `relaunch:${job.id}`, {
            relaunch: true,
            ...(job.autoRetries ? { autoRetries: job.autoRetries } : {}),
          });
          this.update(job.id, { relaunchedAs: next.id });
          out.push(next);
        }
        return out;
      })
      .immediate();
  }
  /**
   * Une boucle `relaunch` vient d'échouer sans annulation : prévoit la relance suivante
   * (30 s, 2 min, 10 min) ou, si 3 relances ont déjà eu lieu dans l'heure, la laisse arrêtée.
   */
  scheduleRetry(
    id: string,
    now: number,
    delays: readonly number[] = RELAUNCH_RETRY_DELAYS_MS,
  ): BackgroundJob {
    const job = this.get(id);
    if (
      job.relaunch !== true ||
      job.cancel ||
      job.status !== "failed" ||
      job.relaunchedAs !== undefined ||
      job.retryAt !== undefined ||
      job.retriesExhausted === true
    )
      return job;
    const delay = delays[recentRetries(job, now).length];
    return delay === undefined
      ? this.update(id, { retriesExhausted: true })
      : this.update(id, { retryAt: new Date(now + delay).toISOString() });
  }
  /** Relance les boucles en échec dont l'attente est écoulée (clé idempotente `retry:<id>`). */
  relaunchFailed(now: number): BackgroundJob[] {
    return this.db
      .transaction(() => {
        const out: BackgroundJob[] = [];
        for (const job of this.list()) {
          if (
            job.relaunch !== true ||
            job.status !== "failed" ||
            job.cancel ||
            job.relaunchedAs !== undefined ||
            job.retryAt === undefined ||
            Date.parse(job.retryAt) > now
          )
            continue;
          const next = this.submit(job.title, job.script, job.args, `retry:${job.id}`, {
            relaunch: true,
            autoRetries: [...recentRetries(job, now), new Date(now).toISOString()],
          });
          this.update(job.id, { relaunchedAs: next.id });
          out.push(next);
        }
        return out;
      })
      .immediate();
  }
  /**
   * Boucles `relaunch` durablement arrêtées, pas encore signalées dans cet état : essais
   * épuisés, ou absentes depuis plus de 10 min sans relance prévue. Une boucle dont le même
   * script tourne de nouveau (relance manuelle, par exemple) n'est pas signalée.
   */
  deadLoops(now: number): DeadLoop[] {
    const jobs = this.list();
    const out: DeadLoop[] = [];
    for (const job of jobs) {
      if (job.relaunch !== true || job.cancel || job.relaunchedAs !== undefined) continue;
      const replaced = jobs.some(
        (o) =>
          o.id !== job.id &&
          o.script === job.script &&
          (o.status === "running" || (o.status === "queued" && job.status !== "queued")),
      );
      if (replaced) continue;
      let reason: DeadLoop["reason"];
      let since: string;
      if (job.status === "failed" && job.retriesExhausted === true) {
        reason = "exhausted";
        since = job.endedAt ?? job.createdAt;
      } else if (job.status === "failed" || job.status === "interrupted") {
        if (job.retryAt !== undefined && Date.parse(job.retryAt) > now) continue;
        reason = "absent";
        since = job.endedAt ?? job.createdAt;
      } else if (job.status === "queued") {
        reason = "absent";
        since = job.createdAt;
      } else continue;
      const age = now - Date.parse(since);
      if (reason === "absent" && (age <= RELAUNCH_ABSENT_ALERT_MS || age > RELAUNCH_ALERT_HORIZON_MS))
        continue;
      const key = `background-job-dead:${job.id}:${job.status}:${reason}`;
      if (job.alertKey === key) continue;
      out.push({ job, reason, since, key });
    }
    return out;
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
  readonly #now: () => number;
  readonly #retryDelays: readonly number[];
  readonly #notify: (text: string, key: string) => void;
  readonly #log: (line: string) => void;
  constructor(
    readonly dataDir: string,
    readonly allowed: () => boolean,
    readonly onRelaunch?: (job: BackgroundJob, after: "interruption" | "échec") => void,
    options: {
      now?: () => number;
      retryDelaysMs?: readonly number[];
      /** Dépose l'alerte dans le fil principal ; par défaut, l'avis runtime habituel. */
      notify?: (text: string, key: string) => void;
      log?: (line: string) => void;
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#retryDelays = options.retryDelaysMs ?? RELAUNCH_RETRY_DELAYS_MS;
    this.#notify = options.notify ?? publishRuntimeNotice(dataDir);
    this.#log = options.log ?? (() => undefined);
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
      try {
        allowed = this.allowed();
      } catch {
        /* Unreadable controls must stop work too. */
      }
      if (!allowed) {
        for (const [id, active] of this.running)
          await this.#stop(id, active.process, "Wake paused, stopped or no longer authorized");
        return;
      }
      // Wake autorise de nouveau : les boucles longues interrompues repartent d'elles-mêmes.
      for (const next of this.store.relaunchInterrupted())
        this.onRelaunch?.(next, "interruption");
      // Boucles en échec : relance après l'attente prévue, puis alerte si elles restent mortes.
      for (const next of this.store.relaunchFailed(this.#now())) this.onRelaunch?.(next, "échec");
      this.#alertDeadLoops();
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
  /** Une seule alerte par boucle et par état ; un envoi en échec sera retenté au tour suivant. */
  #alertDeadLoops(): void {
    for (const dead of this.store.deadLoops(this.#now())) {
      try {
        this.#notify(deadLoopNotice(dead, lastJobError(this.dataDir, dead.job)), dead.key);
        this.store.update(dead.job.id, { alertKey: dead.key });
      } catch (error) {
        this.#log(`alerte boucle arrêtée ${dead.job.id} non déposée : ${String(error)}`);
      }
    }
  }
  #failed(id: string): void {
    try {
      this.store.scheduleRetry(id, this.#now(), this.#retryDelays);
    } catch (error) {
      this.#log(`relance de ${id} non planifiée : ${String(error)}`);
    }
  }
  async #launch(job: BackgroundJob): Promise<void> {
    try {
      const workspace = job.workspaceDir ?? path.join(this.dataDir, "workspace");
      const script = resolveJobScript(this.dataDir, job.script, workspace);
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
        cwd: workspace,
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
          if (this.store.get(job.id).status === "running") {
            this.store.update(job.id, {
              status: exit.mainExitCode === 0 ? "succeeded" : "failed",
              exitCode: exit.mainExitCode,
              endedAt: new Date().toISOString(),
              detail: exit.killReason,
            });
            if (exit.mainExitCode !== 0) this.#failed(job.id);
          }
        } catch (error) {
          await child.terminateTree();
          this.store.update(job.id, {
            status: "failed",
            endedAt: new Date().toISOString(),
            detail: String(error),
          });
          this.#failed(job.id);
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
      this.#failed(job.id);
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

/** Relances automatiques de la boucle encore comptées dans la fenêtre d'une heure. */
function recentRetries(job: BackgroundJob, now: number): string[] {
  return (job.autoRetries ?? []).filter((at) => now - Date.parse(at) < RELAUNCH_RETRY_WINDOW_MS);
}

function publishRuntimeNotice(dataDir: string): (text: string, key: string) => void {
  return (text, key) => {
    const messages = new OwnerMessages(dataDir, RUNTIME_NOTICE_AGENT_ID);
    try {
      messages.publish(text, key);
    } finally {
      messages.close();
    }
  };
}

/** Dernière ligne non vide de stderr.log, sinon le détail ou le code de sortie du job. */
export function lastJobError(dataDir: string, job: BackgroundJob): string {
  let line = "";
  try {
    const file = path.join(jobOutputDir(dataDir, job.id), "stderr.log");
    const size = fs.statSync(file).size;
    const length = Math.min(size, 4096);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, length, size - length);
    } finally {
      fs.closeSync(fd);
    }
    line =
      buffer
        .toString("utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== "")
        .at(-1) ?? "";
  } catch {
    /* Pas de journal : le détail du job suffit. */
  }
  if (line === "") line = job.detail ?? "";
  if (line === "")
    line =
      job.exitCode === null ? "aucune erreur enregistrée" : `code de sortie ${String(job.exitCode)}`;
  return line.replace(/\s+/g, " ").slice(0, 200);
}

/** Une ligne : nom du job, depuis quand, dernière erreur. */
export function deadLoopNotice(dead: DeadLoop, lastError: string): string {
  const since = `${dead.since.slice(0, 16).replace("T", " ")}Z`;
  const why =
    dead.reason === "exhausted"
      ? `arrêtée, relances épuisées (${String(RELAUNCH_RETRY_DELAYS_MS.length)} par heure)`
      : "absente";
  return `⚠️ Boucle « ${dead.job.title} » (${dead.job.script}, ${dead.job.id}) ${why} depuis ${since} — dernière erreur : ${lastError}`;
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
