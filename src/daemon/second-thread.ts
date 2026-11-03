import { tryProjectLease } from "./project-lease.js";
/**
 * Second fil Claude Code, activable depuis la vue d'ensemble (défaut : désactivé).
 *
 * Il tourne à côté du fil principal sans s'y mélanger : réglage `second-thread.json`,
 * session Claude Code persistante (`--session-id` puis `--resume`), transcription et
 * messages humains dans `second-thread.sqlite`, verrou d'instance propre. Il prend les
 * projets disponibles dans l'ordre inverse de la rotation principale, par blocs, et
 * écarte le projet sur lequel le fil principal travaille. Pause et Force-off du profil
 * l'interrompent ; il ne contourne ni quota ni limite du fournisseur.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  claudeEnvironment,
  claudeRunArgs,
  hostProfileEnv,
  userMessageLine,
} from "../adapters/claude/command.js";
import {
  claudeSessionUuid,
  promptDigest,
  writePromptFile,
} from "../adapters/claude/conversation.js";
import { parseStreamLine } from "../adapters/claude/stream.js";
import { WAKE_HOME_SYSTEM_PROMPT, withWakePersonality } from "../adapters/wake-system-prompt.js";
import { acquireInstanceLock, type InstanceLock } from "../scheduler/instance-lock.js";
import { readCounter, readCurrentProject } from "./project-change.js";
import { WakeManager, managerFile, projectStatus } from "./wake-manager.js";

export const SECOND_THREAD_CONFIG = "second-thread.json";
export const SECOND_THREAD_DB = "second-thread.sqlite";
export const SECOND_THREAD_LOCK = "second-thread.lock";
export const SECOND_THREAD_DIR = "second-thread";
export const SECOND_THREAD_BLOCK = 10;
const CONVERSATION_KEY = "second-thread";
const MAX_TEXT = 4000;

export function secondThreadEnabled(dataDir: string): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, SECOND_THREAD_CONFIG), "utf8")) as {
      enabled?: unknown;
    };
    return data.enabled === true;
  } catch {
    return false;
  }
}

export function saveSecondThreadEnabled(dataDir: string, enabled: boolean): void {
  const file = path.join(dataDir, SECOND_THREAD_CONFIG),
    tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ version: 1, enabled, updatedAt: new Date().toISOString() }) + "\n",
  );
  fs.renameSync(tmp, file);
}

export interface SecondThreadEntry {
  readonly id: number;
  readonly at: string;
  readonly role: "agent" | "human" | "event";
  readonly text: string;
  readonly turn: number | null;
  readonly projectId: string | null;
  readonly delivered: boolean;
}
interface EntryRow {
  id: number;
  at: string;
  role: SecondThreadEntry["role"];
  text: string;
  turn: number | null;
  project_id: string | null;
  delivered: number;
}
export interface SecondThreadTurn {
  readonly n: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly projectId: string | null;
  readonly outcome: string | null;
}
export interface SecondThreadPosition {
  readonly projectId: string | null;
  readonly inBlock: number;
}

/** Transcription et état du second fil, hors de la base du fil principal. */
export class SecondThreadStore {
  readonly #db: Database.Database;
  constructor(dataDir: string, options: { readOnly?: boolean } = {}) {
    const file = path.join(dataDir, SECOND_THREAD_DB);
    if (
      fs.existsSync(file) &&
      (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
    )
      throw Error("Unsafe second thread database");
    this.#db = new Database(file, options.readOnly ? { readonly: true, fileMustExist: true } : {});
    if (options.readOnly) return;
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("busy_timeout = 5000");
    this.#db
      .exec(`CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('agent','human','event')), text TEXT NOT NULL, turn INTEGER,
        project_id TEXT, delivered INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS turns(n INTEGER PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT,
        project_id TEXT, outcome TEXT, tokens INTEGER);
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  static exists(dataDir: string): boolean {
    return fs.existsSync(path.join(dataDir, SECOND_THREAD_DB));
  }
  close(): void {
    this.#db.close();
  }
  add(
    role: SecondThreadEntry["role"],
    text: string,
    turn: number | null = null,
    projectId: string | null = null,
  ): number {
    const delivered = role === "human" ? 0 : 1;
    return Number(
      this.#db
        .prepare("INSERT INTO entries(at,role,text,turn,project_id,delivered) VALUES(?,?,?,?,?,?)")
        .run(new Date().toISOString(), role, text, turn, projectId, delivered).lastInsertRowid,
    );
  }
  entries(limit = 200): SecondThreadEntry[] {
    const rows = this.#db
      .prepare("SELECT * FROM (SELECT * FROM entries ORDER BY id DESC LIMIT ?) ORDER BY id")
      .all(limit) as EntryRow[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      role: r.role,
      text: r.text,
      turn: r.turn,
      projectId: r.project_id,
      delivered: r.delivered === 1,
    }));
  }
  pendingHuman(): SecondThreadEntry[] {
    return this.entries(10_000).filter((e) => e.role === "human" && !e.delivered);
  }
  markDelivered(ids: readonly number[]): void {
    const update = this.#db.prepare("UPDATE entries SET delivered=1 WHERE id=?");
    this.#db.transaction(() => {
      for (const id of ids) update.run(id);
    })();
  }
  beginTurn(projectId: string | null): number {
    const last = this.#db.prepare("SELECT MAX(n) AS n FROM turns").get() as { n: number | null };
    const n = (last.n ?? 0) + 1;
    this.#db
      .prepare("INSERT INTO turns(n,started_at,project_id) VALUES(?,?,?)")
      .run(n, new Date().toISOString(), projectId);
    return n;
  }
  endTurn(n: number, outcome: string, tokens: number | null): void {
    this.#db
      .prepare("UPDATE turns SET ended_at=?, outcome=?, tokens=? WHERE n=?")
      .run(new Date().toISOString(), outcome, tokens, n);
  }
  lastTurn(): SecondThreadTurn | null {
    const r = this.#db.prepare("SELECT * FROM turns ORDER BY n DESC LIMIT 1").get() as
      | {
          n: number;
          started_at: string;
          ended_at: string | null;
          project_id: string | null;
          outcome: string | null;
        }
      | undefined;
    return r === undefined
      ? null
      : {
          n: r.n,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          projectId: r.project_id,
          outcome: r.outcome,
        };
  }
  get(key: string): string | null {
    const r = this.#db.prepare("SELECT value FROM state WHERE key=?").get(key) as
      { value: string } | undefined;
    return r?.value ?? null;
  }
  set(key: string, value: string): void {
    this.#db
      .prepare(
        "INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  position(): SecondThreadPosition | null {
    const raw = this.get("position");
    if (raw === null) return null;
    try {
      const p = JSON.parse(raw) as { projectId?: unknown; inBlock?: unknown };
      return {
        projectId: typeof p.projectId === "string" ? p.projectId : null,
        inBlock: Number.isSafeInteger(p.inBlock) ? (p.inBlock as number) : 0,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Projet du prochain tour : ordre inverse de la rotation principale, blocs de `block`
 * tours, jamais le projet du fil principal. `null` = exploration libre.
 */
export function pickSecondThreadProject(
  mainOrder: readonly string[],
  mainProject: string | null,
  previous: SecondThreadPosition | null,
  block = SECOND_THREAD_BLOCK,
): SecondThreadPosition {
  const reversed = [...mainOrder].reverse();
  const candidates = reversed.filter((id) => id !== mainProject);
  const first = candidates[0];
  if (first === undefined) return { projectId: null, inBlock: 1 };
  const prev = previous?.projectId ?? null;
  if (prev !== null && candidates.includes(prev) && (previous?.inBlock ?? block) < block)
    return { projectId: prev, inBlock: (previous?.inBlock ?? 0) + 1 };
  if (prev === null || !reversed.includes(prev)) return { projectId: first, inBlock: 1 };
  for (let step = 1; step <= reversed.length; step++) {
    const id = reversed[(reversed.indexOf(prev) + step) % reversed.length];
    if (id !== undefined && id !== mainProject) return { projectId: id, inBlock: 1 };
  }
  return { projectId: first, inBlock: 1 };
}

export interface ProjectLandscape {
  /** Projets disponibles dans l'ordre de la rotation principale. */
  readonly order: string[];
  readonly titles: Record<string, string>;
  /** Projet du fil principal (réservé ou en cours), sinon projet courant déclaré. */
  readonly mainProject: string | null;
}

export function readProjectLandscape(workspace: string): ProjectLandscape {
  const registry = readCounter(workspace)?.["projects"];
  const rows =
    registry !== null && typeof registry === "object" && !Array.isArray(registry)
      ? (registry as Record<string, unknown>)
      : {};
  const titles: Record<string, string> = {};
  const available: string[] = [];
  for (const [id, item] of Object.entries(rows)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ||
      item === null ||
      typeof item !== "object"
    )
      continue;
    const record = item as Record<string, unknown>;
    titles[id] = typeof record["title"] === "string" ? record["title"] : id;
    if (projectStatus(record["status"]) === "active") available.push(id);
  }
  let mainOrder: string[] = [];
  let mainProject: string | null = null;
  if (fs.existsSync(managerFile(workspace))) {
    let manager: WakeManager | null = null;
    try {
      manager = new WakeManager(workspace, { readOnly: true });
      const state = manager.status();
      mainOrder = state?.projects.map((p) => p.id) ?? [];
      mainProject = manager.pending()?.projectId ?? state?.project ?? null;
    } catch {
      // Base du fil principal illisible : le registre seul décide de l'ordre.
    } finally {
      manager?.close();
    }
  }
  const order = [
    ...mainOrder.filter((id) => available.includes(id)),
    ...available.filter((id) => !mainOrder.includes(id)),
  ];
  return { order, titles, mainProject: mainProject ?? readCurrentProject(workspace) };
}

export const SECOND_THREAD_SYSTEM_NOTE = [
  "Second fil Claude Code. Tu travailles en parallèle du fil principal de Wake, dans le même espace, sur un autre projet que lui.",
  "Ton fil avec l'humain est séparé du sien : ta réponse finale de chaque tour est publiée telle quelle dans l'onglet « Fil Claude » de l'app. Écris-la pour ton humain, brève et concrète : ce que tu as fait, trouvé ou décidé, et une question seulement si elle t'aide vraiment.",
  "N'utilise pas le canal propriétaire du fil principal (message_owner) et ne modifie ni son plan de wakes ni son registre de projets ; ne touche pas aux fichiers du projet sur lequel travaille le fil principal.",
  "Chaque tour est une relance : reprends où tu en étais dans ce fil, avance le projet attribué et conserve tes notes de reprise dans son dossier.",
].join(" ");

export function secondThreadSystemPrompt(workspace: string): string {
  return [
    withWakePersonality(workspace, WAKE_HOME_SYSTEM_PROMPT),
    "",
    SECOND_THREAD_SYSTEM_NOTE,
  ].join("\n");
}

export function secondThreadTurnMessage(input: {
  turn: number;
  position: SecondThreadPosition;
  titles: Record<string, string>;
  mainProject: string | null;
  human: readonly SecondThreadEntry[];
  now: Date;
}): string {
  const { position, titles } = input;
  const project =
    position.projectId === null
      ? "aucun projet libre : exploration libre, sans toucher au projet du fil principal"
      : `${titles[position.projectId] ?? position.projectId} (${position.projectId}), tour ${String(position.inBlock)}/${String(SECOND_THREAD_BLOCK)} du bloc`;
  const lines = [
    `Second fil — tour ${String(input.turn)}, ${input.now.toISOString()}.`,
    `Projet : ${project}.`,
    `Fil principal : ${input.mainProject === null ? "aucun projet en cours" : `${titles[input.mainProject] ?? input.mainProject} (${input.mainProject})`}.`,
  ];
  if (input.human.length > 0) {
    lines.push("", "Nouveaux messages de ton humain dans ce fil :");
    for (const h of input.human) lines.push(`- [${h.at}] ${h.text}`);
  }
  return lines.join("\n");
}

export type SecondThreadControl = "run" | "hold" | "stop";

export interface SecondThreadTurnResult {
  readonly outcome: "completed" | "error" | "rate_limited" | "interrupted";
  readonly text: string;
  readonly sessionConfirmed: boolean;
  readonly tokens: number | null;
  readonly retryAtMs: number | null;
  readonly detail: string | null;
}

export interface SecondThreadClaude {
  readonly executable: string;
  /** Arguments placés avant ceux de Claude Code (tests : script exécuté par node). */
  readonly prefixArgs?: readonly string[];
  readonly model: string;
}

export function secondThreadClaude(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SecondThreadClaude {
  return {
    executable:
      env["MIND_WAKE_CLAUDE_EXE"] ?? path.join(os.homedir(), ".local", "bin", "claude.exe"),
    model: env["MIND_WAKE_SECOND_THREAD_MODEL"] ?? env["MIND_WAKE_CLAUDE_MODEL"] ?? "opus",
  };
}

const SYSTEM_ENV_KEYS = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "TEMP",
  "TMP",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "CLAUDE_CODE_GIT_BASH_PATH",
];

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32")
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  else child.kill("SIGKILL");
}

/** Un tour Claude Code : ouvre ou reprend la session, envoie la relance, lit le flux. */
export function runClaudeTurn(input: {
  claude: SecondThreadClaude;
  workspace: string;
  promptFile: string;
  session: { mode: "new" | "resume"; id: string };
  message: string;
  control: () => SecondThreadControl;
  maxMs?: number;
}): Promise<SecondThreadTurnResult> {
  const args = claudeRunArgs({
    model: input.claude.model,
    systemPromptFile: input.promptFile,
    tools: [],
    nativeCapabilities: true,
    permission: "skip_permissions_unsandboxed",
    session: input.session,
  });
  const system = Object.fromEntries(
    SYSTEM_ENV_KEYS.flatMap((k) => {
      const v = process.env[k];
      return v === undefined ? [] : [[k, v]];
    }),
  );
  const env = { ...system, ...claudeEnvironment({ inherited: hostProfileEnv() }) };
  return new Promise((resolve) => {
    const child = spawn(input.claude.executable, [...(input.claude.prefixArgs ?? []), ...args], {
      cwd: input.workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const texts: string[] = [];
    let confirmed = false,
      tokens: number | null = null,
      retryAtMs: number | null = null,
      rejected = false;
    let outcome: SecondThreadTurnResult["outcome"] | null = null,
      detail: string | null = null,
      buffer = "";
    const finish = (o: SecondThreadTurnResult["outcome"], d: string | null) => {
      outcome ??= o;
      detail ??= d;
    };
    const watch = setInterval(() => {
      if (input.control() !== "run") {
        finish("interrupted", "pause, arrêt ou désactivation du second fil");
        killTree(child);
      }
    }, 1000);
    const deadline = setTimeout(
      () => {
        finish("interrupted", "durée maximale du tour atteinte");
        killTree(child);
      },
      input.maxMs ?? 2 * 3_600_000,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line === "") continue;
        const item = parseStreamLine(line);
        if (item.kind === "init") confirmed = true;
        else if (item.kind === "rate_limit" && item.status === "rejected") {
          rejected = true;
          retryAtMs = item.resetsAtMs;
        } else if (item.kind === "assistant_error" && item.error === "rate_limit") rejected = true;
        else if (item.kind === "result") {
          tokens =
            item.tokens === null
              ? null
              : item.tokens.input + item.tokens.cachedInput + item.tokens.output;
          if (rejected) finish("rate_limited", "limite du fournisseur");
          else if (item.isError) finish("error", item.errors[0]?.slice(0, 300) ?? item.subtype);
          else finish("completed", null);
          child.stdin.end();
        }
        if (line.includes('"type":"assistant"')) {
          try {
            const content = (JSON.parse(line) as { message?: { content?: unknown } }).message
              ?.content;
            if (Array.isArray(content)) {
              const text = content
                .filter(
                  (b): b is { type: "text"; text: string } =>
                    (b as { type?: unknown }).type === "text" &&
                    typeof (b as { text?: unknown }).text === "string",
                )
                .map((b) => b.text)
                .join("\n")
                .trim();
              if (text !== "") texts.push(text);
            }
          } catch {
            // Ligne illisible : ignorée, comme dans le parseur du flux.
          }
        }
      }
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderr = (stderr + c).slice(-2000);
    });
    child.on("error", (error) => {
      finish("error", error.message);
    });
    child.on("close", (code) => {
      clearInterval(watch);
      clearTimeout(deadline);
      if (outcome === null)
        finish(
          rejected ? "rate_limited" : "error",
          stderr.trim().slice(-300) || `sortie ${String(code)} sans résultat`,
        );
      resolve({
        outcome: outcome ?? "error",
        text: texts.at(-1) ?? "",
        sessionConfirmed: confirmed,
        tokens,
        retryAtMs,
        detail,
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.write(userMessageLine(input.message) + "\n");
  });
}

export interface SecondThreadWorkerOptions {
  readonly dataDir: string;
  readonly workspace: () => string;
  /** État du profil : `hold` en pause, `stop` après Force-off ou sans consentement. */
  readonly profile: () => SecondThreadControl;
  readonly log: (line: string) => void;
  readonly claude?: SecondThreadClaude;
  readonly turn?: typeof runClaudeTurn;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxTurns?: number;
}

export function secondThreadLockPath(dataDir: string): string {
  return path.join(dataDir, SECOND_THREAD_LOCK);
}

/** Le worker détient son verrou ; une sonde qui l'obtient le relâche aussitôt. */
export function secondThreadWorkerRunning(dataDir: string): boolean {
  if (!fs.existsSync(secondThreadLockPath(dataDir))) return false;
  try {
    acquireInstanceLock(secondThreadLockPath(dataDir)).release();
    return false;
  } catch {
    return true;
  }
}

/** Boucle du second fil : enchaîne les tours tant qu'il est activé et que le profil le permet. */
export async function runSecondThread(
  options: SecondThreadWorkerOptions,
): Promise<{ turns: number; reason: string }> {
  const lock: InstanceLock = acquireInstanceLock(secondThreadLockPath(options.dataDir));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const claude = options.claude ?? secondThreadClaude();
  const turnFn = options.turn ?? runClaudeTurn;
  const store = new SecondThreadStore(options.dataDir);
  const control = (): SecondThreadControl =>
    !secondThreadEnabled(options.dataDir) ? "stop" : options.profile();
  let turns = 0,
    failures = 0;
  try {
    for (;;) {
      const state = control();
      if (state === "stop")
        return {
          turns,
          reason: secondThreadEnabled(options.dataDir) ? "profil arrêté" : "second fil désactivé",
        };
      if (state === "hold") {
        await sleep(2000);
        continue;
      }
      if (options.maxTurns !== undefined && turns >= options.maxTurns)
        return { turns, reason: "nombre de tours atteint" };
      const workspace = options.workspace();
      const landscape = readProjectLandscape(workspace);
      let position = pickSecondThreadProject(
        landscape.order,
        landscape.mainProject,
        store.position(),
      );
      let projectLease = position.projectId ? tryProjectLease(options.dataDir,position.projectId):null;
      if(position.projectId && !projectLease) {
        const alternative=landscape.order.filter(id=>id!==landscape.mainProject && id!==position.projectId).find(id=>{
          const probe=tryProjectLease(options.dataDir,id);if(!probe)return false;projectLease=probe;return true;
        });
        if(!alternative){await sleep(1000);continue;}
        position={projectId:alternative,inBlock:1};
      }
      try {
      const human = store.pendingHuman();
      const n = store.beginTurn(position.projectId);
      store.set("position", JSON.stringify(position));
      const generation = Number(store.get("generation") ?? "0");
      const sessionId = claudeSessionUuid(CONVERSATION_KEY, generation);
      const prompt = secondThreadSystemPrompt(workspace);
      const promptFile = writePromptFile(
        path.join(options.dataDir, SECOND_THREAD_DIR),
        prompt,
        promptDigest(prompt),
      );
      const resume = store.get("confirmed") === sessionId;
      options.log(
        `second fil : tour ${String(n)} sur ${position.projectId ?? "exploration libre"} (${resume ? "reprise" : "nouvelle session"})`,
      );
      const result = await turnFn({
        claude,
        workspace,
        promptFile,
        session: { mode: resume ? "resume" : "new", id: sessionId },
        message: secondThreadTurnMessage({
          turn: n,
          position,
          titles: landscape.titles,
          mainProject: landscape.mainProject,
          human,
          now: new Date(),
        }),
        control,
      });
      turns++;
      if (result.sessionConfirmed) store.set("confirmed", sessionId);
      else if (result.outcome === "error" && resume) {
        // Session introuvable avant `init` : nouvelle génération, la mémoire du projet assure la reprise.
        store.set("generation", String(generation + 1));
      }
      if (result.sessionConfirmed || result.outcome === "completed")
        store.markDelivered(human.map((h) => h.id));
      if (result.text !== "")
        store.add("agent", result.text.slice(0, 20_000), n, position.projectId);
      if (result.outcome !== "completed")
        store.add(
          "event",
          `Tour ${String(n)} : ${result.outcome}${result.detail === null ? "" : ` — ${result.detail}`}`.slice(
            0,
            MAX_TEXT,
          ),
          n,
          position.projectId,
        );
      store.endTurn(n, result.outcome, result.tokens);
      projectLease?.release();
      projectLease=null;
      if (result.outcome === "completed") failures = 0;
      else if (result.outcome === "rate_limited") {
        const until = Math.min(
          result.retryAtMs ?? Date.now() + 15 * 60_000,
          Date.now() + 6 * 3_600_000,
        );
        options.log(`second fil : limite du fournisseur jusqu'à ${new Date(until).toISOString()}`);
        while (Date.now() < until && control() !== "stop") await sleep(5000);
      } else if (result.outcome === "error") {
        failures++;
        await sleep(Math.min(600_000, 15_000 * 2 ** Math.min(failures - 1, 6)));
      }
      } finally {projectLease?.release();}
    }
  } finally {
    store.close();
    lock.release();
  }
}

export interface SecondThreadView {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly position: SecondThreadPosition | null;
  readonly lastTurn: SecondThreadTurn | null;
  readonly entries: SecondThreadEntry[];
}

export function readSecondThread(dataDir: string, limit = 200): SecondThreadView {
  const enabled = secondThreadEnabled(dataDir);
  const running = secondThreadWorkerRunning(dataDir);
  if (!SecondThreadStore.exists(dataDir))
    return { enabled, running, position: null, lastTurn: null, entries: [] };
  const store = new SecondThreadStore(dataDir);
  try {
    return {
      enabled,
      running,
      position: store.position(),
      lastTurn: store.lastTurn(),
      entries: store.entries(limit),
    };
  } finally {
    store.close();
  }
}

export function sendToSecondThread(dataDir: string, text: string): SecondThreadEntry {
  const clean = text.trim();
  if (clean === "" || clean.length > MAX_TEXT) throw Error("Message vide ou trop long.");
  const store = new SecondThreadStore(dataDir);
  try {
    const id = store.add("human", clean);
    const entry = store.entries(1).find((e) => e.id === id);
    if (entry === undefined) throw Error("Message non enregistré.");
    return entry;
  } finally {
    store.close();
  }
}
