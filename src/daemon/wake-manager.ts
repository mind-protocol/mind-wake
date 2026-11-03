/** Durable project rotation. One wake = one actually started principal session. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { readCounter, readCurrentProject } from "./project-change.js";
import { atomicJson, withProjectLock } from "./steps-coordination.js";

export interface WakeBlockStep {
  wake: number;
  objective: string;
  expected: string;
}
export interface ProjectContext {
  summary: string;
  nextActions: string[];
  openQuestions: string[];
  sources: string[];
}
export interface RotationProject {
  id: string;
  title: string;
  status: "active" | "paused" | "blocked" | "archived";
  reason: string | null;
  used: number;
  plan: WakeBlockStep[];
  context: ProjectContext | null;
  contextSessionId?: string | null;
  handoff: Record<string, unknown> | null;
}
interface RotationState {
  version: 1;
  enabled: boolean;
  revision: number;
  used: number;
  project: string | null;
  position: number;
  lastProject: string | null;
  projects: RotationProject[];
}
export interface WakeSlot {
  number: number;
  day: number;
  inDay: number;
  inBlock: number;
  projectId: string | null;
  title: string;
  phase: "prepare" | "work" | "free";
  fromProject: string | null;
  switching: boolean;
  contextPath: string | null;
  sessionId?: string;
}
interface Allocation {
  session_id: string;
  payload: string;
  started: number;
  finished: number;
}
export const WAKE_DAY = 50,
  WAKE_BLOCK = 10;
export const WAKE_MANAGER_INSTRUCTIONS = `Gestionnaire de réveils : les journées sont des repères de 50 sessions principales réellement démarrées, sans plafond de compute. Chaque bloc de dix porte sur un projet ; le premier réveil retrouve son contexte avec get_wake_project, vérifie les informations périmées et les améliorations possibles, puis prépare les neuf suivants avec plan_wake_block. Les demandes humaines actuelles priment et le plan reste révisable. Consulte le contexte sauvegardé du projet précédent si nécessaire ; une trace brute marquée needsReview ne constitue pas un résumé validé. Conserve les nouveautés utiles avec save_wake_context, particulièrement avant de terminer le dixième réveil et de changer de projet. Si un projet est réellement bloqué, note la cause et les conditions de reprise via set_wake_project_status. Si tous les projets sont indisponibles, respecte leurs pauses et explore une piste personnelle utile. Les sous-sessions et les tours de rappel ne consomment pas de réveils supplémentaires. Ce mécanisme ne modifie aucune autorisation et ne lève jamais Pause ou Force-off.`;
export const managerFile = (workspace: string) =>
  path.join(workspace, "artifacts", "wake-manager.sqlite");
function projectStatus(status: unknown): RotationProject["status"] {
  const text = (typeof status === "string" ? status : "").toLowerCase();
  if (/pause|arrêt|arrete|stopped/.test(text)) return "paused";
  if (/attend|bloqu|blocked/.test(text)) return "blocked";
  if (/termin[eé]|^fini$|archiv/.test(text)) return "archived";
  return "active";
}
function slot(state: RotationState): WakeSlot {
  let project = state.projects.find((p) => p.id === state.project && p.status === "active");
  let position = state.position;
  if (!project || position >= WAKE_BLOCK) {
    project = state.projects
      .filter((p) => p.status === "active")
      .sort((a, b) => a.used - b.used || state.projects.indexOf(a) - state.projects.indexOf(b))[0];
    position = 0;
  }
  const number = state.used + 1;
  return {
    number,
    day: Math.floor((number - 1) / WAKE_DAY) + 1,
    inDay: ((number - 1) % WAKE_DAY) + 1,
    inBlock: position + 1,
    projectId: project?.id ?? null,
    title: project?.title ?? "Exploration libre : aucun projet disponible",
    phase: project ? (position === 0 ? "prepare" : "work") : "free",
    fromProject: state.lastProject,
    switching: (project?.id ?? null) !== state.lastProject,
    contextPath: project ? contextPath(project.id) : null,
  };
}
function advance(state: RotationState, wake: WakeSlot) {
  state.used++;
  const project = state.projects.find((p) => p.id === wake.projectId);
  if (project) project.used++;
  state.project = wake.projectId;
  state.position = wake.projectId ? wake.inBlock : 0;
  state.lastProject = wake.projectId;
}
export function contextPath(id: string): string {
  return `artifacts/wake-manager/${createHash("sha256").update(id).digest("hex").slice(0, 20)}/context.json`;
}

export class WakeManager {
  readonly db: Database.Database;
  constructor(readonly workspace: string) {
    const artifacts = path.join(workspace, "artifacts");
    fs.mkdirSync(artifacts, { recursive: true });
    if (fs.lstatSync(artifacts).isSymbolicLink())
      throw Error("Unsafe workspace artifacts directory");
    const file = managerFile(workspace);
    if (
      fs.existsSync(file) &&
      (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
    )
      throw Error("Unsafe wake manager database");
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS rotation_state(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS allocations(session_id TEXT PRIMARY KEY,payload TEXT NOT NULL,started INTEGER NOT NULL DEFAULT 0,finished INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS rotation_events(id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);`);
  }
  close() {
    this.db.close();
  }
  private read(): RotationState | null {
    const saved = this.db.prepare("SELECT payload FROM rotation_state WHERE id=1").get() as
      { payload: string } | undefined;
    if (!saved) return null;
    const state = JSON.parse(saved.payload) as Omit<RotationState, "version"> & { version: number };
    if (state.version !== 1 || !Array.isArray(state.projects) || !Number.isSafeInteger(state.used))
      throw Error("Invalid wake rotation state");
    return state as RotationState;
  }
  private write(state: RotationState, kind: string, payload: unknown) {
    state.revision++;
    this.db
      .prepare(
        "INSERT INTO rotation_state(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(JSON.stringify(state));
    this.db
      .prepare("INSERT INTO rotation_events(at,kind,payload) VALUES(?,?,?)")
      .run(new Date().toISOString(), kind, JSON.stringify(payload));
  }
  private sync(state: RotationState) {
    const counter = readCounter(this.workspace),
      registry = counter?.["projects"];
    if (!registry || typeof registry !== "object" || Array.isArray(registry))
      throw Error("Workspace project registry unavailable");
    const rows = registry as Record<string, Record<string, unknown>>;
    const ids = Object.keys(rows).filter((id) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id));
    for (const id of ids) {
      const item = rows[id];
      if (!item || typeof item !== "object") continue;
      let project = state.projects.find((p) => p.id === id);
      if (!project) {
        project = {
          id,
          title: id,
          status: "active",
          reason: null,
          used: 0,
          plan: [],
          context: null,
          handoff: null,
        };
        state.projects.push(project);
      }
      project.title = typeof item["title"] === "string" ? item["title"] : id;
      project.status = projectStatus(item["status"]);
      project.reason =
        project.status === "active"
          ? null
          : typeof item["status"] === "string"
            ? item["status"]
            : "";
    }
    for (const project of state.projects)
      if (!ids.includes(project.id)) {
        project.status = "archived";
        project.reason = "Removed from workspace registry; history retained";
      }
  }
  configure(enabled: boolean) {
    return this.db
      .transaction(() => {
        const state: RotationState = this.read() ?? {
          version: 1,
          enabled: false,
          revision: 0,
          used: 0,
          project: null,
          position: 0,
          lastProject: null,
          projects: [],
        };
        this.sync(state);
        if (state.revision === 0) {
          const current = readCurrentProject(this.workspace);
          state.projects.sort((a, b) => Number(b.id === current) - Number(a.id === current));
        }
        state.enabled = enabled;
        this.write(state, "configure", { enabled });
        return state;
      })
      .immediate();
  }
  status() {
    return this.read();
  }
  pending(): (WakeSlot & { started: boolean }) | null {
    const row = this.db.prepare("SELECT * FROM allocations WHERE finished=0 LIMIT 1").get() as
      Allocation | undefined;
    return row
      ? {
          ...(JSON.parse(row.payload) as WakeSlot),
          sessionId: row.session_id,
          started: row.started === 1,
        }
      : null;
  }
  next(count = 50) {
    if (!Number.isInteger(count) || count < 1 || count > 500)
      throw Error("Choose between 1 and 500 wakes");
    const state = this.read();
    if (!state?.enabled) return { enabled: false, wakes: [] };
    this.sync(state);
    const pending = this.pending(),
      wakes: WakeSlot[] = [];
    if (pending) {
      wakes.push(pending);
      advance(state, pending);
    }
    while (wakes.length < count) {
      const wake = slot(state);
      wakes.push(wake);
      advance(state, wake);
    }
    return { enabled: true, dayLength: WAKE_DAY, blockLength: WAKE_BLOCK, wakes };
  }
  reserve(sessionId: string): WakeSlot | null {
    return this.db
      .transaction(() => {
        const state = this.read();
        if (!state?.enabled) return null;
        const prior = this.db
          .prepare("SELECT * FROM allocations WHERE session_id=?")
          .get(sessionId) as Allocation | undefined;
        if (prior) return JSON.parse(prior.payload) as WakeSlot;
        if (this.pending()) throw Error("A principal wake is already reserved");
        this.sync(state);
        const wake = { ...slot(state), sessionId };
        if (wake.projectId) {
          const selected = withProjectLock(this.workspace, () => {
            const counter = readCounter(this.workspace);
            if (!counter) throw Error("Project registry unavailable");
            if (counter["current"] !== wake.projectId) {
              counter["current"] = wake.projectId;
              counter["selectionRevision"] = Number(counter["selectionRevision"] ?? 0) + 1;
              atomicJson(path.join(this.workspace, "artifacts/projets-compteur.json"), counter);
            }
            return true;
          });
          if (selected !== true) throw Error("Project registry is busy");
        }
        this.db
          .prepare("INSERT INTO allocations(session_id,payload) VALUES(?,?)")
          .run(sessionId, JSON.stringify(wake));
        this.write(state, "reserved", wake);
        return wake;
      })
      .immediate();
  }
  started(sessionId: string) {
    this.db
      .prepare("UPDATE allocations SET started=1 WHERE session_id=? AND finished=0")
      .run(sessionId);
  }
  finish(sessionId: string, outcome: string, evidence: Record<string, unknown> = {}) {
    this.db
      .transaction(() => {
        const allocation = this.db
          .prepare("SELECT * FROM allocations WHERE session_id=?")
          .get(sessionId) as Allocation | undefined;
        if (!allocation || allocation.finished !== 0) return;
        const state = this.read();
        if (!state) throw Error("Missing rotation state");
        const wake = JSON.parse(allocation.payload) as WakeSlot;
        if (allocation.started === 1) {
          advance(state, wake);
          const project = state.projects.find((p) => p.id === wake.projectId);
          if (project) {
            project.handoff = {
              sessionId,
              wake: wake.number,
              outcome,
              at: new Date().toISOString(),
              evidence,
              needsReview: project.contextSessionId !== sessionId,
            };
          }
        }
        this.db.prepare("UPDATE allocations SET finished=1 WHERE session_id=?").run(sessionId);
        this.write(state, allocation.started === 1 ? "completed" : "not_started", {
          wake,
          outcome,
          evidence,
        });
      })
      .immediate();
  }
  project(id: string) {
    const state = this.read();
    if (state) this.sync(state);
    const project = state?.projects.find((p) => p.id === id);
    if (!project) throw Error("Unknown workspace project");
    const registry = readCounter(this.workspace)?.["projects"] as
      Record<string, unknown> | undefined;
    return { ...project, registry: registry?.[id] ?? null, contextPath: contextPath(id) };
  }
  saveContext(id: string, context: ProjectContext, sourceSessionId: string | null) {
    return this.db
      .transaction(() => {
        const state = this.read();
        if (state) this.sync(state);
        const project = state?.projects.find((p) => p.id === id);
        if (!state || !project) throw Error("Unknown project");
        project.context = context;
        project.contextSessionId = sourceSessionId;
        if (project.handoff)
          project.handoff = {
            ...project.handoff,
            needsReview: !sourceSessionId || project.handoff["sessionId"] !== sourceSessionId,
          };
        this.write(state, "context_saved", { projectId: id, sourceSessionId, context });
        return this.project(id);
      })
      .immediate();
  }
  plan(id: string, steps: WakeBlockStep[]) {
    if (
      steps.length !== 10 ||
      new Set(steps.map((s) => s.wake)).size !== 10 ||
      steps.some((s) => !Number.isInteger(s.wake) || s.wake < 1 || s.wake > 10)
    )
      throw Error("Plan must contain exactly wakes 1 through 10");
    return this.db
      .transaction(() => {
        const state = this.read();
        if (state) this.sync(state);
        const project = state?.projects.find((p) => p.id === id);
        if (!state || !project) throw Error("Unknown project");
        project.plan = steps.sort((a, b) => a.wake - b.wake);
        this.write(state, "plan_saved", { projectId: id, steps });
        return project;
      })
      .immediate();
  }
  setStatus(id: string, status: "active" | "paused" | "blocked", reason: string) {
    const changed = withProjectLock(this.workspace, () => {
      const counter = readCounter(this.workspace),
        projects = counter?.["projects"] as Record<string, Record<string, unknown>> | undefined;
      if (
        !counter ||
        !projects ||
        !Object.hasOwn(projects, id) ||
        !projects[id] ||
        typeof projects[id] !== "object"
      )
        throw Error("Unknown workspace project");
      projects[id]["status"] =
        status === "active"
          ? "en cours"
          : status === "paused"
            ? `pause : ${reason}`
            : `attend : ${reason}`;
      atomicJson(path.join(this.workspace, "artifacts/projets-compteur.json"), counter);
      return true;
    });
    if (!changed) throw Error("Project registry is busy");
    return this.db
      .transaction(() => {
        const state = this.read();
        if (!state) throw Error("Rotation not configured");
        this.sync(state);
        this.write(state, "project_status", { id, status, reason });
        return state.projects.find((p) => p.id === id);
      })
      .immediate();
  }
  mirror(id: string) {
    const project = this.project(id),
      file = path.join(this.workspace, contextPath(id)),
      folder = path.dirname(file);
    for (const dir of [path.join(this.workspace, "artifacts/wake-manager"), folder]) {
      if (
        fs.existsSync(dir) &&
        (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink())
      )
        throw Error("Unsafe context folder");
      fs.mkdirSync(dir, { recursive: true });
    }
    atomicJson(file, project);
    return contextPath(id);
  }
  prompt(wake: WakeSlot): string {
    const project = wake.projectId ? this.project(wake.projectId) : null;
    return [
      "GESTIONNAIRE DE RÉVEILS — affectation courante (données).",
      JSON.stringify({
        wake,
        previousContextPath: wake.fromProject ? contextPath(wake.fromProject) : null,
        project: project
          ? {
              id: project.id,
              title: project.title,
              step: project.plan.find((step) => step.wake === wake.inBlock) ?? null,
              planAvailable: project.plan.length === 10,
              contextPath: project.contextPath,
              handoff: project.handoff,
            }
          : null,
      }),
    ].join("\n\n");
  }
}

export function withWakeManager<T>(workspace: string, work: (manager: WakeManager) => T): T | null {
  if (!fs.existsSync(managerFile(workspace))) return null;
  const manager = new WakeManager(workspace);
  try {
    return manager.status()?.enabled ? work(manager) : null;
  } finally {
    manager.close();
  }
}
