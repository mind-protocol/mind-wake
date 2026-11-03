/**
 * Arborescence de processus contenue d'une session (kill switch, AGENTS §5, ADR-003).
 *
 * Sous Windows, chaque session tourne dans un Job Object nommé, créé par un petit lanceur
 * natif (`job-launcher-source.ts`) : le processus est assigné au job dès sa création,
 * sans breakaway, et toute sa descendance y reste. Terminer le job termine l'arborescence
 * sans aucune coopération du processus ni du modèle. Le nom du job dérive de la session :
 * un autre processus (la CLI `stop`, la réconciliation au démarrage) peut le retrouver,
 * le terminer ou vérifier qu'il n'existe plus, sans dépendre d'un PID réutilisable.
 *
 * Filets successifs : commande `kill` au lanceur ; mort du lanceur (`KILL_ON_JOB_CLOSE`) ;
 * fin du canal de contrôle (daemon disparu) ; terminaison par nom.
 *
 * Hors Windows, aucun mécanisme équivalent n'est démontré : le superviseur se déclare
 * indisponible et le runner refuse tout lancement.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { DurationMs, ProfileId, SessionId } from "../contracts/index.js";
import { JOB_LAUNCHER_SOURCE } from "./job-launcher-source.js";
import { bundledJobLauncher } from "./bundled-launcher.js";

/** Borne de terminaison proposée pour G1 (ADR-003) : 1 s après la décision d'arrêt. */
export const DEFAULT_TERMINATION_TIMEOUT_MS: DurationMs = 1_000;

const CSC_PATH = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const EVENT_PREFIX = "mindwake-job ";
/** Variables minimales nécessaires au démarrage d'un processus Windows ; rien d'autre. */
const BASE_ENV_KEYS = ["SystemRoot", "SystemDrive", "windir", "TEMP", "TMP"] as const;

/** Nom du Job Object d'une session, stable et sans caractère arbitraire. */
export function jobNameFor(profileId: ProfileId, sessionId: SessionId): string {
  const digest = createHash("sha256").update(`${profileId}\0${sessionId}`).digest("hex");
  return `Local\\mindwake-session-${digest.slice(0, 32)}`;
}

export type LauncherStatus =
  | { readonly available: true; readonly launcherPath: string }
  | { readonly available: false; readonly reason: string };

/**
 * Compile le lanceur dans `runtimeDir` s'il n'y est pas déjà. Le nom du binaire porte
 * l'empreinte de la source : une source modifiée produit un nouveau binaire.
 */
export function ensureJobLauncher(
  runtimeDir: string,
  platform: NodeJS.Platform = process.platform,
  bundledDirectory: string | null = fileURLToPath(new URL("../../bin/native/", import.meta.url)),
): LauncherStatus {
  if (platform !== "win32") {
    return {
      available: false,
      reason: "terminaison d'arborescence démontrée sous Windows seulement",
    };
  }
  // A distributed binary may be signed or allowed by an administrator. Never replace it
  // with an unsigned local compilation if its manifest is invalid or execution is blocked.
  if (bundledDirectory !== null) {
    const bundled = bundledJobLauncher(bundledDirectory);
    if (bundled !== null) return bundled;
  }
  const digest = createHash("sha256").update(JOB_LAUNCHER_SOURCE).digest("hex").slice(0, 16);
  const launcherPath = path.join(runtimeDir, `mindwake-job-${digest}.exe`);
  if (fs.existsSync(launcherPath)) return { available: true, launcherPath };
  if (!fs.existsSync(CSC_PATH)) {
    return { available: false, reason: "csc.exe de .NET Framework 4.x introuvable" };
  }
  fs.mkdirSync(runtimeDir, { recursive: true });
  const tmp = path.join(runtimeDir, `build-${randomUUID()}`);
  fs.mkdirSync(tmp);
  try {
    const source = path.join(tmp, "launcher.cs");
    const out = path.join(tmp, "launcher.exe");
    fs.writeFileSync(source, JOB_LAUNCHER_SOURCE);
    const result = spawnSync(CSC_PATH, ["/nologo", "/optimize", `/out:${out}`, source], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0 || !fs.existsSync(out)) {
      const detail = `${result.stdout}${result.stderr}`.trim().slice(0, 500);
      return { available: false, reason: `compilation du lanceur impossible : ${detail}` };
    }
    try {
      fs.renameSync(out, launcherPath);
    } catch (error) {
      // Compilation concurrente : un autre processus a déjà publié le même binaire.
      if (!fs.existsSync(launcherPath)) throw error;
    }
    return { available: true, launcherPath };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Commande à lancer dans l'arborescence contenue. Aucun environnement hérité. */
export interface ContainedCommand {
  readonly executable: string;
  readonly args: readonly string[];
  /** Variables ajoutées aux variables système minimales ; jamais de credential. */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Limite de processus actifs du job (`filesAndTools.maxProcesses`). */
  readonly maxProcesses?: number;
  /**
   * Le runtime est lancé en mode sans approbation (`--dangerously-skip-permissions`,
   * `--yolo`…). Permis seulement dans la sandbox, après autotest réussi (ADR-005) : hors
   * sandbox, le runner refuse le lancement.
   */
  readonly unattended?: boolean;
  /**
   * Canal fournisseur demandé : dans la sandbox, le runner ouvre le pipe du broker et en
   * transmet le chemin dans `MIND_WAKE_BROKER_PIPE`. Sans broker, le réseau reste fermé.
   */
  readonly broker?: boolean;
}

/**
 * Processus d'une session, contenu (Job Object seul) ou confiné (AppContainer + Job
 * Object, `src/sandbox`) : forme commune que le runner et les adapters manipulent.
 */
export interface SessionProcess {
  readonly jobName: string;
  readonly exited: Promise<ContainedExit & { readonly aclRevoked?: boolean }>;
  started(): Promise<number>;
  readonly hasExited: boolean;
  readLine(): Promise<string | null>;
  send(line: string): void;
  /** Ferme l'entrée standard du processus (fin de conversation `stream-json`). */
  closeInput?(): void;
  terminateTree(timeoutMs?: DurationMs): Promise<TreeTermination>;
}

/** Résultat d'une terminaison d'arborescence, mesurée depuis la décision d'arrêt. */
export interface TreeTermination {
  readonly confirmed: boolean;
  /** Délai mesuré côté daemon, de la décision à la confirmation (ou au renoncement). */
  readonly elapsedMs: number;
  /** Délai mesuré par le noyau entre `TerminateJobObject` et zéro processus actif. */
  readonly kernelMs: number | null;
  /** Dernier filet utilisé. */
  readonly via: "already_exited" | "kill_command" | "launcher_killed" | "terminate_by_name";
  readonly detail?: string;
}

export interface ContainedExit {
  /** Code du processus principal ; `null` si inconnu (lanceur tué). */
  readonly mainExitCode: number | null;
  /** Cause de terminaison du job, si le job a été terminé. */
  readonly killReason: string | null;
  readonly totalProcesses: number | null;
}

/** Processus d'une session et toute sa descendance, contenus dans un Job Object. */
export class ContainedProcess implements SessionProcess {
  readonly jobName: string;
  readonly exited: Promise<ContainedExit>;
  #child: ChildProcess;
  #launcherPath: string;
  #lines: string[] = [];
  #waiters: ((line: string | null) => void)[] = [];
  #stdoutClosed = false;
  #started: Promise<number>;
  #done = false;
  #kernelMs: number | null = null;

  constructor(launcherPath: string, jobName: string, command: ContainedCommand) {
    this.jobName = jobName;
    this.#launcherPath = launcherPath;
    const args = ["run", "--job-name", jobName];
    if (command.maxProcesses !== undefined && command.maxProcesses > 0) {
      args.push("--max-procs", String(command.maxProcesses));
    }
    if (command.cwd !== undefined) args.push("--cwd", command.cwd);
    for (const [key, value] of Object.entries(baseEnv())) args.push("--env", `${key}=${value}`);
    for (const [key, value] of Object.entries(command.env ?? {})) {
      args.push("--env", `${key}=${value}`);
    }
    args.push("--", command.executable, ...command.args);
    this.#child = spawn(launcherPath, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    // Lanceur déjà terminé : une écriture tardive sur son entrée n'a plus d'objet.
    this.#child.stdin?.on("error", () => undefined);

    let resolveStarted: (pid: number) => void = () => undefined;
    let rejectStarted: (error: Error) => void = () => undefined;
    this.#started = new Promise<number>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    // Évite un rejet non observé si personne n'attend le démarrage.
    this.#started.catch(() => undefined);

    let done: ContainedExit | null = null;
    createInterface({ input: this.#child.stderr as NodeJS.ReadableStream }).on("line", (line) => {
      if (!line.startsWith(EVENT_PREFIX)) return;
      const event = parseJson(line.slice(EVENT_PREFIX.length));
      if (event === null) return;
      if (event["event"] === "started" && typeof event["pid"] === "number") {
        resolveStarted(event["pid"]);
      } else if (event["event"] === "error") {
        rejectStarted(new Error(`lanceur : ${String(event["message"])}`));
      } else if (event["event"] === "done") {
        done = {
          mainExitCode: typeof event["mainExitCode"] === "number" ? event["mainExitCode"] : null,
          killReason: typeof event["killReason"] === "string" ? event["killReason"] : null,
          totalProcesses:
            typeof event["totalProcesses"] === "number" ? event["totalProcesses"] : null,
        };
        this.#kernelMs =
          typeof event["killToZeroMs"] === "number" && event["killToZeroMs"] >= 0
            ? event["killToZeroMs"]
            : null;
      }
    });
    createInterface({ input: this.#child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#lines.push(line);
      else waiter(line);
    });
    this.#child.stdout?.on("close", () => {
      this.#stdoutClosed = true;
      for (const waiter of this.#waiters.splice(0)) waiter(null);
    });
    this.exited = new Promise<ContainedExit>((resolve) => {
      this.#child.on("error", (error) => {
        rejectStarted(error);
      });
      this.#child.on("close", () => {
        this.#done = true;
        rejectStarted(new Error("lanceur terminé avant le démarrage"));
        resolve(done ?? { mainExitCode: null, killReason: "launcher_lost", totalProcesses: null });
      });
    });
  }

  /** PID du processus principal, une fois assigné au job. */
  started(): Promise<number> {
    return this.#started;
  }

  get hasExited(): boolean {
    return this.#done;
  }

  /** Lignes écrites par le processus sur sa sortie standard ; `null` en fin de flux. */
  async readLine(): Promise<string | null> {
    const line = this.#lines.shift();
    if (line !== undefined) return line;
    if (this.#stdoutClosed) return null;
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** Transmet une ligne sur l'entrée standard du processus. Sans effet après la fin. */
  send(line: string): void {
    if (this.#done || this.#child.stdin === null || this.#child.stdin.destroyed) return;
    this.#child.stdin.write(`in ${line.replace(/[\r\n]+/g, " ")}\n`);
  }

  /** Ferme l'entrée standard du processus (commande `eof` du lanceur). */
  closeInput(): void {
    if (this.#done || this.#child.stdin === null || this.#child.stdin.destroyed) return;
    this.#child.stdin.write("eof\n");
  }

  /**
   * Termine le processus et toute sa descendance, sans attendre leur coopération, en
   * moins de `timeoutMs` si le système le permet. Chaque filet n'est tenté que si le
   * précédent n'a pas confirmé la fin.
   */
  async terminateTree(
    timeoutMs: DurationMs = DEFAULT_TERMINATION_TIMEOUT_MS,
  ): Promise<TreeTermination> {
    const begin = performance.now();
    const elapsed = (): number => performance.now() - begin;
    if (this.#done) {
      return {
        confirmed: true,
        elapsedMs: elapsed(),
        kernelMs: this.#kernelMs,
        via: "already_exited",
      };
    }
    const exited = this.exited.then(() => true);
    const within = (ms: number): Promise<boolean> =>
      Promise.race([exited, sleep(Math.max(0, ms)).then(() => false)]);

    this.#child.stdin?.write("kill\n");
    if (await within(timeoutMs / 2)) {
      return {
        confirmed: true,
        elapsedMs: elapsed(),
        kernelMs: this.#kernelMs,
        via: "kill_command",
      };
    }
    // Lanceur bloqué : sa mort ferme le dernier handle du job, le noyau termine tout.
    this.#child.kill("SIGKILL");
    if (await within(timeoutMs / 4)) {
      const check = queryJob(this.#launcherPath, this.jobName);
      if (check.found === false || check.active === 0) {
        return { confirmed: true, elapsedMs: elapsed(), kernelMs: null, via: "launcher_killed" };
      }
    }
    const byName = terminateJobByName(
      this.#launcherPath,
      this.jobName,
      Math.max(1, timeoutMs - elapsed()),
    );
    return {
      confirmed: byName.confirmed,
      elapsedMs: elapsed(),
      kernelMs: byName.kernelMs,
      via: "terminate_by_name",
      ...(byName.detail === undefined ? {} : { detail: byName.detail }),
    };
  }
}

/** Fabrique des arborescences contenues ; seul moyen pour un adapter de lancer un processus. */
export class ProcessTreeSupervisor {
  readonly status: LauncherStatus;

  constructor(runtimeDir: string, platform: NodeJS.Platform = process.platform) {
    this.status = ensureJobLauncher(runtimeDir, platform);
  }

  get available(): boolean {
    return this.status.available;
  }

  spawn(profileId: ProfileId, sessionId: SessionId, command: ContainedCommand): ContainedProcess {
    if (!this.status.available) {
      throw new Error(`terminaison d'arborescence indisponible : ${this.status.reason}`);
    }
    return new ContainedProcess(
      this.status.launcherPath,
      jobNameFor(profileId, sessionId),
      command,
    );
  }

  /** Processus encore actifs dans le job d'une session, vus depuis n'importe quel processus. */
  query(profileId: ProfileId, sessionId: SessionId): JobQuery {
    if (!this.status.available) return { found: null, active: null };
    return queryJob(this.status.launcherPath, jobNameFor(profileId, sessionId));
  }

  /** Termine par son nom le job d'une session, même lancé par un autre processus. */
  terminate(
    profileId: ProfileId,
    sessionId: SessionId,
    timeoutMs: DurationMs = DEFAULT_TERMINATION_TIMEOUT_MS,
  ): NamedTermination {
    if (!this.status.available) {
      return {
        found: null,
        confirmed: false,
        elapsedMs: 0,
        kernelMs: null,
        detail: this.status.reason,
      };
    }
    return terminateJobByName(
      this.status.launcherPath,
      jobNameFor(profileId, sessionId),
      timeoutMs,
    );
  }
}

/** `found: null` : impossible de vérifier (mécanisme indisponible ou réponse illisible). */
export interface JobQuery {
  readonly found: boolean | null;
  readonly active: number | null;
}

export interface NamedTermination {
  readonly found: boolean | null;
  readonly confirmed: boolean;
  readonly elapsedMs: number;
  readonly kernelMs: number | null;
  readonly detail?: string;
}

function queryJob(launcherPath: string, jobName: string): JobQuery {
  const result = spawnSync(launcherPath, ["query", "--job-name", jobName], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  const json = parseJson(result.stdout.trim());
  if (json === null || typeof json["found"] !== "boolean" || typeof json["active"] !== "number") {
    return { found: null, active: null };
  }
  return { found: json["found"], active: json["active"] };
}

function terminateJobByName(
  launcherPath: string,
  jobName: string,
  timeoutMs: number,
): NamedTermination {
  const begin = performance.now();
  const result = spawnSync(
    launcherPath,
    ["terminate", "--job-name", jobName, "--timeout-ms", String(Math.ceil(timeoutMs))],
    { encoding: "utf8", windowsHide: true, timeout: timeoutMs + 5_000 },
  );
  const elapsedMs = performance.now() - begin;
  const json = parseJson(result.stdout.trim());
  if (json === null || typeof json["found"] !== "boolean") {
    return {
      found: null,
      confirmed: false,
      elapsedMs,
      kernelMs: null,
      detail: "réponse illisible",
    };
  }
  const active = typeof json["active"] === "number" ? json["active"] : null;
  const kernelMs = typeof json["ms"] === "number" ? json["ms"] : null;
  if (!json["found"]) return { found: false, confirmed: true, elapsedMs, kernelMs: null };
  return active === 0
    ? { found: true, confirmed: true, elapsedMs, kernelMs }
    : { found: true, confirmed: false, elapsedMs, kernelMs, detail: `actifs: ${String(active)}` };
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function parseJson(text: string): Readonly<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
