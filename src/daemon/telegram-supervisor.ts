/**
 * Supervision du pont Telegram (`scripts/telegram-bridge.mjs`), hébergée par `daemon run`.
 *
 * Cause des arrêts silencieux du 16 nov. 2026 : le pont était relancé à la main depuis des
 * sessions d'agent. Chaque session tourne dans un Job Object Windows sans breakaway
 * (`src/runner/process-tree.ts`), donc le pont faisait partie du job et mourait avec la
 * session, sans erreur ni ligne de journal. Exemple : pid 5832, lancé vers 16:11 UTC dans la
 * session 59b99bfa (16:10:17 → 16:12:02), dernier relevé à 16:12:01.7.
 *
 * Toutes les 10 s, le superviseur :
 * - relance le pont s'il est mort, avec un délai croissant (0, 10 s, 30 s, 1 min, 2 min, 5 min),
 *   et journalise chaque relance dans `telegram-supervisor.log` et le journal du daemon ;
 * - tue puis relance le pont s'il est figé, c'est-à-dire si un `getUpdates` est pendant bien
 *   au-delà de son délai dur (20 s) ou si aucun relevé n'a eu lieu depuis le démarrage ;
 * - dépose une alerte dans le fil du Principal si le relevé `getUpdates` ne réussit plus
 *   depuis 10 min alors que le processus tourne, ou si le pont ne tient pas après 4 relances.
 *
 * Le signal de vie est `lastPollAt` dans `telegram.sqlite`. Le pont l'écrit après chaque
 * `getUpdates`, qu'il y ait des messages ou non, environ toutes les 5 s. Le silence de NLR
 * n'est donc jamais une panne. Le verrou `telegram.pid` reste la seule garantie d'unicité :
 * un pont lancé alors qu'un autre vit sort aussitôt.
 *
 * Arrêt voulu : `telegram.json` avec `enabled: false`, ou fichier `telegram-supervisor.off`
 * dans le dossier de données. Tuer seulement le pid ne suffit plus, le pont reviendrait.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { enqueueOwnerMessage } from "../communication/owner-inbox.js";

export const TICK_MS = 10_000;
/** Relevé réussi plus récent que ça : pont en bonne santé. */
export const FRESH_MS = 120_000;
/** `getUpdates` pendant depuis plus longtemps que ça (délai dur : 20 s) : figé. */
export const HUNG_MS = 120_000;
/** Démarrage sans aucun relevé au-delà de ce délai : figé. */
export const STARTUP_GRACE_MS = 120_000;
/** Messages en cours de traitement (transcription, CLI : 300 s max chacun) au-delà : figé. */
export const STUCK_MS = 15 * 60_000;
/** Processus vivant, boucle active, mais aucun relevé réussi depuis : alerte. */
export const SILENT_MS = 10 * 60_000;
/** Relances consécutives sans retour à la santé avant alerte. */
export const FAILED_RESTARTS_ALERT = 4;
/** Santé continue au-delà de ce délai : le compteur de relances repart de zéro. */
export const STABLE_MS = 10 * 60_000;
const BACKOFF_MS = [0, 10_000, 30_000, 60_000, 120_000, 300_000];

export const SUPERVISOR_OFF_FILE = "telegram-supervisor.off";
const STATE_FILE = "telegram-supervisor.json";
const LOG_FILE = "telegram-supervisor.log";

export interface BridgeObservation {
  readonly enabled: boolean;
  readonly pid: number | null;
  readonly alive: boolean;
  /** mtime de `telegram.pid` : le pont l'écrit à l'acquisition du verrou. */
  readonly pidSince: number | null;
  /** false : base illisible à cet instant (verrouillée) ; aucune décision de mise à mort. */
  readonly heartbeatReadable: boolean;
  readonly status: string | null;
  readonly lastPollAt: number | null;
  readonly pollStartedAt: number | null;
}

export type Verdict =
  | { kind: "disabled" }
  | { kind: "suspended" }
  | { kind: "unknown" }
  | { kind: "healthy" }
  | { kind: "starting" }
  | { kind: "busy" }
  | { kind: "degraded"; since: number }
  | { kind: "silent"; since: number }
  | { kind: "dead" }
  | { kind: "frozen"; reason: string };

/** Délai avant la relance n° `attempt` (1 = première). */
export function backoffMs(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1]!;
}

export function assessBridge(o: BridgeObservation, now: number): Verdict {
  if (!o.enabled) return { kind: "disabled" };
  if (!o.alive) return { kind: "dead" };
  if (!o.heartbeatReadable) return { kind: "unknown" };
  // Pont en pause (inbox externe coupée) : il tourne mais ne relève pas, c'est voulu.
  if (o.status === "suspended") return { kind: "suspended" };
  const since = o.pidSince ?? 0;
  const poll = o.lastPollAt ?? 0;
  const start = o.pollStartedAt ?? 0;
  if (poll >= since && now - poll <= FRESH_MS) return { kind: "healthy" };
  if (start < since) {
    // Aucun relevé commencé par ce processus.
    return now - since < STARTUP_GRACE_MS
      ? { kind: "starting" }
      : { kind: "frozen", reason: `aucun relevé depuis le démarrage (${seconds(now - since)})` };
  }
  if (start > poll) {
    // Relevé en cours. La boucle réécrit pollStartedAt à chaque essai, même en erreur :
    // une valeur ancienne veut dire que la boucle elle-même est bloquée.
    if (now - start > HUNG_MS)
      return { kind: "frozen", reason: `getUpdates pendant depuis ${seconds(now - start)}` };
    const lastGood = Math.max(poll, since);
    return now - lastGood > SILENT_MS
      ? { kind: "silent", since: lastGood }
      : { kind: "degraded", since: lastGood };
  }
  // Dernier relevé terminé, messages en traitement depuis.
  if (now - poll > STUCK_MS)
    return { kind: "frozen", reason: `traitement des messages figé depuis ${seconds(now - poll)}` };
  return { kind: "busy" };
}

function seconds(ms: number): string {
  return ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

export interface SupervisorState {
  /** Relances depuis le dernier retour durable à la santé. */
  restarts: number;
  lastRestartAt: number | null;
  nextRestartAt: number;
  healthySince: number | null;
  /** Incident signalé dans le fil, effacé au retour à la santé. */
  alert: { id: string; at: number; reason: string } | null;
}

const EMPTY: SupervisorState = {
  restarts: 0,
  lastRestartAt: null,
  nextRestartAt: 0,
  healthySince: null,
  alert: null,
};

export interface TelegramSupervisorOptions {
  readonly dataDir: string;
  readonly repoDir?: string;
  readonly allowed?: () => boolean;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  readonly observe?: () => BridgeObservation;
  readonly spawnBridge?: () => number | null;
  /** Vrai seulement si `pid` est bien un `telegram-bridge.mjs` : on ne tue jamais un pid recyclé. */
  readonly isBridgeProcess?: (pid: number) => boolean;
  readonly kill?: (pid: number) => void;
  readonly alert?: (text: string, id: string) => void;
  readonly tickMs?: number;
}

export class TelegramSupervisor {
  #timer: NodeJS.Timeout | undefined;
  #closed = false;
  readonly #o: TelegramSupervisorOptions;
  readonly #now: () => number;

  constructor(options: TelegramSupervisorOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    this.tick();
    this.#timer = setInterval(() => this.tick(), this.#o.tickMs ?? TICK_MS);
    this.#timer.unref();
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  /** Un passage. Exposé aux tests ; ne lève jamais. */
  tick(): Verdict | null {
    if (this.#closed) return null;
    try {
      return this.#tick();
    } catch (error) {
      this.#write(`erreur de supervision : ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  #tick(): Verdict | null {
    const { dataDir } = this.#o;
    if (this.#o.allowed?.() === false || fs.existsSync(path.join(dataDir, SUPERVISOR_OFF_FILE)))
      return null;
    const now = this.#now();
    const observation = (this.#o.observe ?? (() => observeBridge(dataDir)))();
    const verdict = assessBridge(observation, now);
    const state = this.#load();
    switch (verdict.kind) {
      case "healthy":
        state.healthySince ??= now;
        if (state.restarts > 0 && now - state.healthySince >= STABLE_MS) state.restarts = 0;
        if (state.alert !== null) {
          this.#alert(
            `Pont Telegram rétabli : les relevés getUpdates repartent (pid ${String(observation.pid)}). Incident signalé à ${new Date(state.alert.at).toISOString()} : ${state.alert.reason}.`,
          );
          this.#write(`rétabli après alerte (${state.alert.reason})`);
          state.alert = null;
        }
        break;
      case "dead":
        state.healthySince = null;
        if (now >= state.nextRestartAt) this.#restart(state, now, observation.pid === null ? "pas de pid" : `pid ${String(observation.pid)} mort`);
        break;
      case "frozen":
        state.healthySince = null;
        if (now >= state.nextRestartAt && observation.pid !== null) {
          const isBridge = (this.#o.isBridgeProcess ?? isBridgeProcess)(observation.pid);
          if (!isBridge) {
            // pid recyclé par un autre programme : le verrou est périmé, le pont est mort.
            this.#restart(state, now, `pid ${String(observation.pid)} n'est plus un pont`);
            break;
          }
          this.#write(`figé (${verdict.reason}) : arrêt du pid ${String(observation.pid)}`);
          (this.#o.kill ?? ((pid: number) => process.kill(pid)))(observation.pid);
          // La relance suit au passage suivant, une fois le processus constaté mort.
          state.nextRestartAt = now;
        }
        break;
      case "silent":
        state.healthySince = null;
        this.#raise(
          state,
          now,
          `aucun relevé getUpdates réussi depuis ${new Date(verdict.since).toISOString()} alors que le pont tourne`,
        );
        break;
      default:
        if (verdict.kind !== "starting" && verdict.kind !== "busy" && verdict.kind !== "unknown")
          state.healthySince = null;
    }
    if (state.restarts >= FAILED_RESTARTS_ALERT && state.healthySince === null)
      this.#raise(state, now, `${String(state.restarts)} relances sans retour à un relevé normal`);
    this.#save(state);
    return verdict;
  }

  #restart(state: SupervisorState, now: number, cause: string): void {
    state.restarts += 1;
    state.lastRestartAt = now;
    state.nextRestartAt = now + backoffMs(state.restarts + 1);
    const pid = (this.#o.spawnBridge ?? (() => spawnBridge(this.#o.dataDir, this.#repoDir())))();
    this.#write(
      `relance n° ${String(state.restarts)} (${cause}) → pid ${String(pid)} ; prochaine relance possible dans ${seconds(state.nextRestartAt - now)}`,
    );
  }

  #raise(state: SupervisorState, now: number, reason: string): void {
    if (state.alert !== null) return;
    const id = `telegram-supervisor-${randomUUID()}`;
    state.alert = { id, at: now, reason };
    this.#alert(
      `⚠️ Pont Telegram : ${reason}. NLR ne reçoit peut-être pas tes réponses et ses messages n'arrivent peut-être pas. Journal : telegram-supervisor.log et telegram.stderr.log dans le dossier de données.`,
      id,
    );
    this.#write(`alerte déposée dans le fil : ${reason}`);
  }

  #alert(text: string, id = `telegram-supervisor-${randomUUID()}`): void {
    try {
      (this.#o.alert ?? ((t: string, i: string) => publishAlert(this.#o.dataDir, t, i)))(text, id);
    } catch (error) {
      this.#write(`alerte non déposée : ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #repoDir(): string {
    return (
      this.#o.repoDir ??
      process.env["MIND_WAKE_REPO_DIR"] ??
      fileURLToPath(new URL("../../", import.meta.url))
    );
  }

  #write(line: string): void {
    try {
      fs.appendFileSync(
        path.join(this.#o.dataDir, LOG_FILE),
        `${new Date(this.#now()).toISOString()} ${line}\n`,
      );
    } catch {
      // Le journal du daemon reste.
    }
    this.#o.log?.(`Telegram : ${line}`);
  }

  #load(): SupervisorState {
    try {
      return { ...EMPTY, ...(JSON.parse(fs.readFileSync(path.join(this.#o.dataDir, STATE_FILE), "utf8")) as Partial<SupervisorState>) };
    } catch {
      return { ...EMPTY };
    }
  }

  #save(state: SupervisorState): void {
    const file = path.join(this.#o.dataDir, STATE_FILE);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
    fs.renameSync(`${file}.tmp`, file);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function time(value: string | undefined): number | null {
  const at = value === undefined ? NaN : Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** Lit uniquement `enabled` de la configuration ; rien d'autre n'en sort. */
function telegramEnabled(dataDir: string): boolean {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dataDir, "telegram.json"), "utf8")) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

export function observeBridge(dataDir: string): BridgeObservation {
  const enabled = telegramEnabled(dataDir);
  let pid: number | null = null;
  let pidSince: number | null = null;
  try {
    const lock = path.join(dataDir, "telegram.pid");
    const value = Number(fs.readFileSync(lock, "utf8").trim());
    if (Number.isInteger(value) && value > 0) {
      pid = value;
      pidSince = fs.statSync(lock).mtimeMs;
    }
  } catch {
    // Pas de verrou : pas de pont.
  }
  const state: Record<string, string> = {};
  let heartbeatReadable = true;
  let db: Database.Database | undefined;
  try {
    db = new Database(path.join(dataDir, "telegram.sqlite"), { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 2000");
    for (const row of db
      .prepare("SELECT key,value FROM state WHERE key IN ('status','lastPollAt','pollStartedAt')")
      .all() as { key: string; value: string }[])
      state[row.key] = row.value;
  } catch {
    heartbeatReadable = false;
  } finally {
    db?.close();
  }
  return {
    enabled,
    pid,
    alive: pid !== null && alive(pid),
    pidSince,
    heartbeatReadable,
    status: state["status"] ?? null,
    lastPollAt: time(state["lastPollAt"]),
    pollStartedAt: time(state["pollStartedAt"]),
  };
}

export function isBridgeProcess(pid: number): boolean {
  if (process.platform !== "win32") {
    try {
      return fs.readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").includes("telegram-bridge.mjs");
    } catch {
      return false;
    }
  }
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}").CommandLine`,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 15_000 },
  );
  return result.status === 0 && result.stdout.includes("telegram-bridge.mjs");
}

/** Même lancement que `scripts/telegram-start.mjs` ; le pont prend lui-même le verrou. */
export function spawnBridge(dataDir: string, repoDir: string): number | null {
  const stdout = fs.openSync(path.join(dataDir, "telegram.stdout.log"), "a");
  const stderr = fs.openSync(path.join(dataDir, "telegram.stderr.log"), "a");
  try {
    const child = spawn(process.execPath, [path.join(repoDir, "scripts/telegram-bridge.mjs"), dataDir], {
      cwd: repoDir,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
    });
    child.on("error", () => {
      // Constaté au passage suivant : pid absent, nouvelle relance après délai.
    });
    child.unref();
    return child.pid ?? null;
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
}

/** Alerte dans le fil du Principal, par la même voie que les messages du Coach. */
export function publishAlert(dataDir: string, text: string, id: string): void {
  enqueueOwnerMessage(dataDir, {
    id,
    at: new Date().toISOString(),
    text,
    origin: {
      kind: "peer_message",
      channel: "telegram-supervisor",
      author: "Superviseur Telegram",
      senderRef: "telegram-supervisor",
      recipientRef: "principal",
      threadId: "telegram-supervisor",
      messageId: id,
      correlationId: id,
    },
  });
}
