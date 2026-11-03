/** Durable project rotation. One wake = one actually started principal session. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { readCounter, readCurrentProject } from "./project-change.js";
import { atomicJson, withProjectLock } from "./steps-coordination.js";
import { assertProjectActivation, projectStatus } from "./project-capacity.js";
export { projectStatus } from "./project-capacity.js";

export interface WakeBlockStep {
  wake: number;
  objective: string;
  expected: string;
}
export interface WakePassage {
  id: string;
  projectId: string;
  question: string;
  expected: string;
  sources: string[];
  steps?: WakeBlockStep[];
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
  blockOrder?: {id: string; projectId: string}[];
  passages?: Record<string, WakePassage>;
  currentPassageId?: string | undefined;
  version: 1;
  enabled: boolean;
  revision: number;
  used: number;
  project: string | null;
  position: number;
  lastProject: string | null;
  projects: RotationProject[];
  promptImprovementProject?: string | null;
}
export interface WakeSlot {
  orderedBlockId?: string;
  passageId?: string;
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
export const WAKE_MANAGER_INSTRUCTIONS = "Le gestionnaire fournit l’affectation et l’intention du wake. Pour créer ou réviser la suite, utiliser le skill planifier-wakes ; sinon poursuivre l’étape et conserver le contexte utile avec save_wake_context. Les demandes humaines et les contrôles de Wake priment.";
export const WAKE_PLANNING_SKILL_FILE = fileURLToPath(new URL("../../prompts/wake/planning/SKILL.md", import.meta.url));
export const managerFile = (workspace: string) =>
  path.join(workspace, "artifacts", "wake-manager.sqlite");

export interface CurrentWakeObjective {
  passageId?: string;
  passage?: WakePassage | undefined;
  objectiveDefined: boolean;
  projectId: string | null;
  sessionId: string;
  at: string;
  number: number;
  inBlock: number;
  title: string;
  objective: string;
  expected: string | null;
}

/** Read-only projection for the human feed; never reserve or advance a wake here. */
export function readCurrentWakeObjective(workspace: string, sessionId: string | null): CurrentWakeObjective | null {
  if (!sessionId || !fs.existsSync(managerFile(workspace))) return null;
  let db: Database.Database | undefined;
  try {
    const file = managerFile(workspace), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    db = new Database(file, { readonly: true, fileMustExist: true });
    return db.transaction(() => {
      const row = db!.prepare("SELECT payload FROM allocations WHERE session_id=? AND started=1 AND finished=0").get(sessionId) as {payload: string} | undefined;
      const saved = db!.prepare("SELECT payload FROM rotation_state WHERE id=1").get() as {payload: string} | undefined;
      if (!row || !saved) return null;
      const wake = JSON.parse(row.payload) as WakeSlot;
      const state = JSON.parse(saved.payload) as RotationState;
      const project = state.projects.find(p => p.id === wake.projectId);
      const step = stepsForWake(state, wake, project).find(s => s.wake === wake.inBlock);
      const event = db!.prepare("SELECT at FROM rotation_events WHERE kind='reserved' AND json_extract(payload,'$.sessionId')=? ORDER BY id DESC LIMIT 1").get(sessionId) as {at: string} | undefined;
      if (!event) return null;
      return {...(wake.passageId ? {passageId: wake.passageId, passage: state.passages?.[wake.passageId]} : {}), sessionId, projectId: wake.projectId, objectiveDefined: Boolean(step?.objective.trim()), at: event.at, number: wake.number, inBlock: wake.inBlock, title: wake.title,
        objective: step?.objective.trim() || (wake.passageId ? PASSAGE_PREPARATION : wake.phase === "free" ? "Explorer librement." : wake.phase === "prepare" ? "Retrouver le contexte et préparer le plan du bloc." : "Objectif de cette étape pas encore planifié."),
        expected: step?.expected || null};
    })();
  } catch {
    return null; // Optional display must not prevent reading the conversation.
  } finally {
    db?.close();
  }
}
function slot(state: RotationState): WakeSlot {
  let orderedBlockId: string | undefined;
  let passageId = state.currentPassageId;
  let project = state.projects.find((p) => p.id === state.project && p.status === "active");
  let position = state.position;
  const maintenance = state.projects.find((p) => p.id === state.promptImprovementProject && p.status === "active");
  if (maintenance) {
    passageId = undefined;
    if (project?.id !== maintenance.id || position >= WAKE_BLOCK) position = 0;
    project = maintenance;
  } else if (!project || position >= WAKE_BLOCK) {
    const ordered = state.blockOrder?.find(item => state.projects.some(p => p.id === item.projectId && p.status === "active"));
    project = (ordered ? state.projects.find(p => p.id === ordered.projectId) : undefined) ?? state.projects
      .filter((p) => p.status === "active")
      .sort((a, b) => a.used - b.used || state.projects.indexOf(a) - state.projects.indexOf(b))[0];
    orderedBlockId = ordered?.id;
    passageId = ordered && state.passages?.[ordered.id] ? ordered.id : undefined;
    position = 0;
  }
  const number = state.used + 1;
  return {
    ...(orderedBlockId ? {orderedBlockId} : {}),
    ...(passageId ? {passageId} : {}),
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
  if (wake.orderedBlockId && state.blockOrder) state.blockOrder = state.blockOrder.filter(item => item.id !== wake.orderedBlockId);
  state.used++;
  const project = state.projects.find((p) => p.id === wake.projectId);
  if (project) project.used++;
  state.project = wake.projectId;
  state.position = wake.projectId ? wake.inBlock : 0;
  state.lastProject = wake.projectId;
  state.currentPassageId = wake.passageId;
}
export function stepsForWake(state: RotationState, wake: WakeSlot, project?: RotationProject | null) {
  // An undetailed passage must never inherit the previous passage's ten intentions.
  return wake.passageId ? state.passages?.[wake.passageId]?.steps ?? [] : project?.plan ?? [];
}
const PASSAGE_PREPARATION = "À définir : préparer les dix intentions de ce passage à partir de sa question et de ses sources.";
function validateSteps(steps: WakeBlockStep[]) {
  if (!Array.isArray(steps) || steps.length !== WAKE_BLOCK ||
      new Set(steps.map(s => s?.wake)).size !== WAKE_BLOCK || Array.from(steps).some(s =>
        !s || !Number.isInteger(s.wake) || s.wake < 1 || s.wake > WAKE_BLOCK ||
        typeof s.objective !== "string" || !s.objective.trim() ||
        typeof s.expected !== "string" || !s.expected.trim()))
    throw Error("Plan must contain exactly wakes 1 through 10 with objective and expected result");
}
export function contextPath(id: string): string {
  return `artifacts/wake-manager/${createHash("sha256").update(id).digest("hex").slice(0, 20)}/context.json`;
}

export class WakeManager {
  readonly db: Database.Database;
  constructor(readonly workspace: string, options: { readOnly?: boolean } = {}) {
    const artifacts = path.join(workspace, "artifacts");
    if (!options.readOnly) fs.mkdirSync(artifacts, { recursive: true });
    if (fs.lstatSync(artifacts).isSymbolicLink())
      throw Error("Unsafe workspace artifacts directory");
    const file = managerFile(workspace);
    if (
      fs.existsSync(file) &&
      (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
    )
      throw Error("Unsafe wake manager database");
    this.db = new Database(file, options.readOnly ? { readonly: true, fileMustExist: true } : {});
    if (options.readOnly) return;
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
    state.promptImprovementProject = typeof counter?.["promptImprovementProject"] === "string"
      ? counter["promptImprovementProject"] : null;
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
  /** Owner reorders complete future blocks; the reserved block keeps its place. */
  reorderBlocks(projectIds: string[], expectedRevision: number) {
    return this.db.transaction(() => {
      const state = this.read();
      if (!state?.enabled) throw Error("La rotation des projets est désactivée.");
      if (state.revision !== expectedRevision) throw Error("Le planning a changé. Actualise-le avant de déplacer une carte.");
      this.sync(state);
      if (!Array.isArray(projectIds) || projectIds.length < 1 || projectIds.length > 50 ||
          projectIds.some(id => typeof id !== "string" || !state.projects.some(p => p.id === id && p.status === "active")))
        throw Error("Ordre de projets invalide.");
      // Compare to the actual preview: a drag must preserve all complete future blocks.
      const pending = this.pending();
      const preview = this.next(500).wakes;
      const eligible = preview.filter(w => w.inBlock === 1 && w.projectId && (!pending || w.sessionId !== pending.sessionId) &&
        preview.some(end => end.number === w.number + WAKE_BLOCK - 1 && end.projectId === w.projectId && end.inBlock === WAKE_BLOCK));
      const canonical = (ids: string[]) => JSON.stringify([...ids].sort());
      if (canonical(projectIds) !== canonical(eligible.map(w => w.projectId!))) throw Error("Les blocs disponibles ont changé. Actualise le planning.");
      // Project-only drag preserves FIFO identities within each project.
      const protectedId = pending?.orderedBlockId;
      const queue = (state.blockOrder ?? []).filter(item => item.id !== protectedId);
      if (queue.some(item => !eligible.some(w => w.orderedBlockId === item.id)))
        throw Error("Réorganisation impossible sans perdre des passages hors aperçu ou indisponibles.");
      const reordered = projectIds.map(projectId => {
        const index = queue.findIndex(item => item.projectId === projectId);
        return index < 0 ? {id: randomUUID(), projectId} : queue.splice(index, 1)[0]!;
      });
      const protectedBlock = state.blockOrder?.filter(item => item.id === protectedId) ?? [];
      state.blockOrder = [...protectedBlock, ...reordered];
      this.write(state, "blocks_reordered", {projectIds});
      return {revision: state.revision};
    }).immediate();
  }
  /** Replace only future, unengaged blocks. Validation performs no writes. */
  importPassages(passages: WakePassage[], expectedRevision: number, mode: "validate" | "apply") {
    if (mode !== "validate" && mode !== "apply") throw Error("Choose explicit validate or apply mode");
    const run = () => this.db.transaction(() => {
      const state = this.read();
      if (!state?.enabled) throw Error("Rotation not enabled");
      if (!Number.isSafeInteger(expectedRevision) || state.revision !== expectedRevision)
        throw Error("Stale planning revision");
      this.sync(state); // Availability is rechecked, never repaired.
      if (!Array.isArray(passages) || passages.length < 1 || passages.length > 50)
        throw Error("Import requires between 1 and 50 passages of ten wakes");
      const seen = new Set<string>();
      for (const passage of passages) {
        if (!passage || typeof passage.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(passage.id) ||
            seen.has(passage.id) || Object.hasOwn(state.passages ?? {}, passage.id) ||
            state.blockOrder?.some(b => b.id === passage.id)) throw Error("Duplicate or invalid passage ID");
        seen.add(passage.id);
        if (!state.projects.some(p => p.id === passage.projectId && p.status === "active"))
          throw Error("Unknown or unavailable project");
        if (typeof passage.question !== "string" || !passage.question.trim() ||
            typeof passage.expected !== "string" || !passage.expected.trim() ||
            !Array.isArray(passage.sources) || passage.sources.length === 0 ||
            passage.sources.some(source => typeof source !== "string" || !source.trim()))
          throw Error("Passage requires question, expected result and sources");
        if (passage.steps !== undefined) validateSteps(passage.steps);
      }
      const pending = this.pending();
      const protectedBlocks = state.blockOrder?.filter(b => b.id === pending?.orderedBlockId) ?? [];
      // project/position/currentPassageId and the pending allocation are untouched.
      state.blockOrder = [...protectedBlocks, ...passages.map(p => ({id: p.id, projectId: p.projectId}))];
      state.passages ??= {};
      for (const passage of passages) state.passages[passage.id] = structuredClone(passage);
      const counts: Record<string, number> = Object.create(null) as Record<string, number>;
      for (const passage of passages) counts[passage.projectId] = (counts[passage.projectId] ?? 0) + WAKE_BLOCK;
      if (mode === "apply") this.write(state, "passages_imported", {passages});
      return {mode, revision: state.revision, passages: passages.length, positions: passages.length * WAKE_BLOCK, counts};
    })[mode === "apply" ? "immediate" : "deferred"]();
    if (mode === "validate") return run();
    const result = withProjectLock(this.workspace, run);
    if (!result) throw Error("Project registry is busy");
    return result;
  }
  /** Target one passage, never the global project plan or another return. */
  planPassage(passageId: string, steps: WakeBlockStep[], expectedRevision: number) {
    validateSteps(steps);
    return this.db.transaction(() => {
      const state = this.read();
      if (!state || !Number.isSafeInteger(expectedRevision) || state.revision !== expectedRevision)
        throw Error("Stale planning revision");
      const passage = Object.hasOwn(state.passages ?? {}, passageId) ? state.passages![passageId] : undefined;
      if (!passage) throw Error("Unknown passage");
      passage.steps = [...steps].sort((a, b) => a.wake - b.wake);
      this.write(state, "passage_plan_saved", {passageId, steps});
      return {revision: state.revision, passage};
    }).immediate();
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
    return { ...project, passages: Object.values(state?.passages ?? {}).filter(p => p.projectId === id), registry: registry?.[id] ?? null, contextPath: contextPath(id) };
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
    validateSteps(steps);
    return this.db
      .transaction(() => {
        const state = this.read();
        if (state) this.sync(state);
        const project = state?.projects.find((p) => p.id === id);
        if (!state || !project) throw Error("Unknown project");
        project.plan = [...steps].sort((a, b) => a.wake - b.wake);
        this.write(state, "plan_saved", { projectId: id, steps });
        return project;
      })
      .immediate();
  }
  /** Coach edits one intention in the canonical plan, including the running slot. */
  reviseObjective(input: {number: number; projectId: string; expectedRevision: number; objective: string; expected: string; reason: string}) {
    return this.db.transaction(() => {
      const state = this.read();
      if (!state || state.revision !== input.expectedRevision) throw Error("Stale planning revision");
      this.sync(state);
      const wake = this.next(500).wakes.find(w => w.number === input.number && w.projectId === input.projectId);
      if (!wake || !wake.projectId) throw Error("Wake is no longer current or upcoming for this project");
      const project = state.projects.find(p => p.id === wake.projectId);
      if (!project || project.status !== "active") throw Error("Project is inactive");
      for (const value of [input.objective, input.expected, input.reason])
        if (typeof value !== "string" || !value.trim() || value.length > 8000) throw Error("Invalid objective, expected result or reason");
      const passage = wake.passageId ? state.passages?.[wake.passageId] : undefined;
      if (wake.passageId && !passage) throw Error("Unknown passage");
      const steps = passage ? passage.steps ?? [] : project.plan;
      const before = steps.find(s => s.wake === wake.inBlock) ?? null;
      const step = {wake: wake.inBlock, objective: input.objective.trim(), expected: input.expected.trim()};
      const updated = [...steps.filter(s => s.wake !== wake.inBlock), step].sort((a,b) => a.wake-b.wake);
      if (passage) passage.steps = updated; else project.plan = updated;
      this.write(state, "coach_objective_updated", {number: wake.number, projectId: project.id, passageId: wake.passageId ?? null, before, after: step, reason: input.reason});
      return {revision: state.revision, number: wake.number, projectId: project.id, passageId: wake.passageId ?? null, before, step};
    }).immediate();
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
      if (status === "active") assertProjectActivation(counter, id);
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
    const state = this.read()!;
    const passage = wake.passageId ? state.passages?.[wake.passageId] : undefined;
    const steps = stepsForWake(state, wake, project);
    return [
      "GESTIONNAIRE DE RÉVEILS — affectation courante (données).",
      JSON.stringify({
        wake,
        passage: passage ?? null,
        preparation: wake.passageId && steps.length === 0 ? PASSAGE_PREPARATION : null,
        previousContextPath: wake.fromProject ? contextPath(wake.fromProject) : null,
        project: project
          ? {
              id: project.id,
              title: project.title,
              step: steps.find((step) => step.wake === wake.inBlock) ?? null,
              planAvailable: steps.length === 10,
              contextPath: project.contextPath,
              handoff: project.handoff,
              previousProjectContext: project.context,
            }
          : null,
      }),
    ].join("\n\n");
  }
  instructions(wake: WakeSlot): string {
    if (!wake.projectId) return WAKE_MANAGER_INSTRUCTIONS;
    const project = this.project(wake.projectId);
    const steps = stepsForWake(this.read()!, wake, project);
    const reasons: string[] = [];
    if (wake.phase === "prepare") reasons.push("début de bloc : préparer ou revoir les prochains wakes");
    if (steps.length !== WAKE_BLOCK) reasons.push("plan de bloc absent ou incomplet");
    else if (!steps.some((step) => step.wake === wake.inBlock)) reasons.push("intention du wake manquante");
    if (wake.switching && project.handoff?.["needsReview"] === true) reasons.push("reprise à vérifier dans les sources");
    if (reasons.length === 0) return WAKE_MANAGER_INSTRUCTIONS;
    return [WAKE_MANAGER_INSTRUCTIONS, `Skill planifier-wakes — ${reasons.join(" ; ")}.`, fs.readFileSync(WAKE_PLANNING_SKILL_FILE, "utf8")].join("\n\n");
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
