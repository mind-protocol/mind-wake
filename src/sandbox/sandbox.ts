/**
 * Couche d'isolation de production (S10, ADR-003) : lanceur natif AppContainer + Job Object.
 *
 * Chaque processus confiné tourne sous l'identité d'un profil AppContainer dédié à MIND
 * Wake, sans aucune capacité (donc sans réseau), avec des ACE posées seulement sur les
 * racines de la policy pour la durée du lancement, un environnement construit
 * explicitement et une arborescence enfermée dans un Job Object nommé (limites de
 * processus et de mémoire, terminaison de toute la descendance). Les refus viennent du
 * noyau ; la validation de `spec.ts` n'est qu'une seconde barrière.
 *
 * L'interface reprend celle de `ContainedProcess` (runner) pour que le runner puisse
 * brancher l'un ou l'autre ; le nom du job suit `jobNameFor` : `ProcessTreeSupervisor`
 * (CLI `stop`, réconciliation) sait donc aussi terminer un job confiné par son nom.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import type { DurationMs } from "../contracts/index.js";
import {
  DEFAULT_TERMINATION_TIMEOUT_MS,
  type ContainedExit,
  type TreeTermination,
} from "../runner/process-tree.js";
import type { BrokerEndpoint } from "./broker.js";
import { ensureSandboxLauncher, type SandboxLauncherStatus } from "./build.js";
import {
  assertExecutableInRoots,
  assertLimit,
  resolveRoots,
  sandboxEnvironment,
  type RootSet,
} from "./spec.js";

/** Profil AppContainer de production, créé à l'activation et supprimé à la désinstallation. */
export const WAKE_APPCONTAINER_PROFILE = "mindwake.sandbox";

const EVENT_PREFIX = "mindwake-sandbox ";
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Profil temporaire, à supprimer après usage (autotest, tests de refus). */
export function ephemeralProfileName(prefix = "mindwake.selftest"): string {
  return `${prefix}.${randomBytes(6).toString("hex")}`;
}

/** Lancement confiné. Les racines sont accordées pour la seule durée du lancement. */
export interface SandboxLaunchSpec {
  /** Nom du Job Object (`jobNameFor(profileId, sessionId)` côté runner). */
  readonly jobName: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Racines d'exploration (`Modify`). */
  readonly readWriteRoots: readonly string[];
  /** Racines runtime : copie de Node, outils déclarés (`ReadAndExecute`). */
  readonly readOnlyRoots: readonly string[];
  /** Base de contrôle SQLite, policy, dossier de données : jamais dans une racine. */
  readonly protectedPaths: readonly string[];
  /** Variables ajoutées aux variables système minimales ; un nom de secret est refusé. */
  readonly env?: Readonly<Record<string, string>>;
  /** Processus actifs simultanés du job (`filesAndTools.maxProcesses`). */
  readonly maxProcesses?: number;
  /** Mémoire engagée totale du job, en Mio. */
  readonly memoryLimitMb?: number;
  /** Filet de durée imposé par le lanceur lui-même. */
  readonly maxWallMs?: number;
  /** Canal fournisseur ; absent = réseau entièrement fermé. */
  readonly broker?: BrokerEndpoint;
}

export interface SandboxExit extends ContainedExit {
  /** ACE retirées : par le lanceur, sinon par le filet de nettoyage côté daemon. */
  readonly aclRevoked: boolean;
}

export interface ProfileStatus {
  readonly sid: string | null;
  readonly exists: boolean | null;
  readonly registryMapping: boolean | null;
  readonly folder: boolean | null;
}

export interface AclStatus {
  readonly path: string;
  readonly exists: boolean;
  readonly granted: boolean;
}

/** Processus confiné et sa descendance. Même forme que `ContainedProcess` (runner). */
export class SandboxedProcess {
  readonly jobName: string;
  readonly profile: string;
  readonly roots: RootSet;
  readonly exited: Promise<SandboxExit>;
  #child: ChildProcess;
  #launcherPath: string;
  #lines: string[] = [];
  #waiters: ((line: string | null) => void)[] = [];
  #stdoutClosed = false;
  #started: Promise<number>;
  #done = false;
  #kernelMs: number | null = null;
  #events: Readonly<Record<string, unknown>>[] = [];

  constructor(
    launcherPath: string,
    profile: string,
    roots: RootSet,
    spec: SandboxLaunchSpec,
    env: Readonly<Record<string, string>>,
  ) {
    this.jobName = spec.jobName;
    this.profile = profile;
    this.roots = roots;
    this.#launcherPath = launcherPath;
    const args = ["run", "--profile", profile, "--job-name", spec.jobName];
    for (const root of roots.readWrite) args.push("--rw", root);
    for (const root of roots.readOnly) args.push("--ro", root);
    if (spec.cwd !== undefined) args.push("--cwd", spec.cwd);
    if (spec.maxProcesses !== undefined) args.push("--max-procs", String(spec.maxProcesses));
    if (spec.memoryLimitMb !== undefined) args.push("--job-mem-mb", String(spec.memoryLimitMb));
    if (spec.maxWallMs !== undefined) args.push("--max-wall-ms", String(spec.maxWallMs));
    if (spec.broker !== undefined) {
      args.push("--broker-pipe", spec.broker.pipeName, "--broker-port", String(spec.broker.port));
    }
    for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
    args.push("--", spec.executable, ...spec.args);
    this.#child = spawn(launcherPath, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.#child.stdin?.on("error", () => undefined);

    let resolveStarted: (pid: number) => void = () => undefined;
    let rejectStarted: (error: Error) => void = () => undefined;
    this.#started = new Promise<number>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    this.#started.catch(() => undefined);

    let done: ContainedExit | null = null;
    let revoked = false;
    createInterface({ input: this.#child.stderr as NodeJS.ReadableStream }).on("line", (line) => {
      if (!line.startsWith(EVENT_PREFIX)) return;
      const event = parseJson(line.slice(EVENT_PREFIX.length));
      if (event === null) return;
      this.#events.push(event);
      const kind = event["event"];
      if (kind === "started" && typeof event["pid"] === "number") {
        resolveStarted(event["pid"]);
      } else if (kind === "error") {
        rejectStarted(new Error(`lanceur confiné : ${String(event["message"])}`));
      } else if (kind === "revoked") {
        revoked = true;
      } else if (kind === "done") {
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
    this.exited = new Promise<SandboxExit>((resolve) => {
      this.#child.on("error", (error) => {
        rejectStarted(error);
      });
      this.#child.on("close", () => {
        this.#done = true;
        rejectStarted(new Error("lanceur confiné terminé avant le démarrage"));
        // Lanceur tué avant son nettoyage : le filet retire les ACE depuis le daemon.
        const aclRevoked = revoked || revokeRoots(this.#launcherPath, profile, roots);
        resolve({
          ...(done ?? { mainExitCode: null, killReason: "launcher_lost", totalProcesses: null }),
          aclRevoked,
        });
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

  /** PID du lanceur (hors conteneur) : sa mort termine le job (`KILL_ON_JOB_CLOSE`). */
  get launcherPid(): number | undefined {
    return this.#child.pid;
  }

  /** Événements du lanceur reçus jusqu'ici (diagnostic, tests). */
  get events(): readonly Readonly<Record<string, unknown>>[] {
    return this.#events;
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

  /** Ferme l'entrée standard du processus confiné (commande `eof` du lanceur). */
  closeInput(): void {
    if (this.#done || this.#child.stdin === null || this.#child.stdin.destroyed) return;
    this.#child.stdin.write("eof\n");
  }

  /** Tue le lanceur sans lui laisser de nettoyage (tests du filet de sécurité). */
  killLauncher(): void {
    this.#child.kill("SIGKILL");
  }

  /**
   * Termine le processus et toute sa descendance sans leur coopération. Filets successifs :
   * commande `kill`, mort du lanceur (le noyau ferme le job), terminaison par nom.
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
    this.#child.kill("SIGKILL");
    if (await within(timeoutMs / 4)) {
      const check = queryJob(this.#launcherPath, this.jobName);
      if (check.found === false || check.active === 0) {
        return { confirmed: true, elapsedMs: elapsed(), kernelMs: null, via: "launcher_killed" };
      }
    }
    const byName = terminateJob(this.#launcherPath, this.jobName, timeoutMs - elapsed());
    return {
      confirmed: byName,
      elapsedMs: elapsed(),
      kernelMs: null,
      via: "terminate_by_name",
    };
  }
}

/** Isolation de production : profil dédié, lancements confinés, nettoyage vérifiable. */
export class Sandbox {
  readonly status: SandboxLauncherStatus;
  readonly profile: string;

  constructor(
    runtimeDir: string,
    profile: string = WAKE_APPCONTAINER_PROFILE,
    platform: NodeJS.Platform = process.platform,
  ) {
    if (!PROFILE_NAME.test(profile)) throw new Error(`nom de profil invalide : ${profile}`);
    this.profile = profile;
    this.status = ensureSandboxLauncher(runtimeDir, platform);
  }

  get available(): boolean {
    return this.status.available;
  }

  /** État de santé pour `doctor` et `liveChecks.sandboxOperational` (sans autotest). */
  health(): { readonly operational: boolean; readonly detail: string } {
    if (!this.status.available) return { operational: false, detail: this.status.reason };
    const profile = this.profileStatus();
    if (profile.exists !== true) {
      return { operational: false, detail: `profil AppContainer ${this.profile} absent` };
    }
    return { operational: true, detail: `profil ${this.profile} (${String(profile.sid)})` };
  }

  /** Crée le profil s'il n'existe pas (activation). Retourne son SID. */
  ensureProfile(): { readonly sid: string; readonly created: boolean } {
    const json = this.#manage(["profile-create", "--profile", this.profile]);
    if (typeof json["sid"] !== "string") throw new Error("création du profil AppContainer : échec");
    return { sid: json["sid"], created: json["created"] === true };
  }

  /** Supprime le profil (désinstallation, autotest) puis vérifie qu'il n'en reste rien. */
  deleteProfile(): ProfileStatus {
    this.#manage(["profile-delete", "--profile", this.profile], true);
    return this.profileStatus();
  }

  profileStatus(): ProfileStatus {
    if (!this.status.available) {
      return { sid: null, exists: null, registryMapping: null, folder: null };
    }
    const json = this.#manage(["profile-status", "--profile", this.profile], true);
    const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
    return {
      sid: typeof json["sid"] === "string" ? json["sid"] : null,
      exists: bool(json["exists"]),
      registryMapping: bool(json["registryMapping"]),
      folder: bool(json["folder"]),
    };
  }

  /** Lance `spec.executable` confiné. Lève `SandboxSpecError` si la spec est refusée. */
  launch(spec: SandboxLaunchSpec): SandboxedProcess {
    if (!this.status.available) {
      throw new Error(`isolation indisponible : ${this.status.reason}`);
    }
    assertLimit("maxProcesses", spec.maxProcesses, 1_000);
    assertLimit("memoryLimitMb", spec.memoryLimitMb, 1_048_576);
    assertLimit("maxWallMs", spec.maxWallMs, 2_147_483_647);
    const roots = resolveRoots(
      { readWrite: spec.readWriteRoots, readOnly: spec.readOnlyRoots },
      spec.protectedPaths,
    );
    assertExecutableInRoots(spec.executable, roots);
    const env = sandboxEnvironment(spec.env);
    return new SandboxedProcess(this.status.launcherPath, this.profile, roots, spec, env);
  }

  /** Retire les ACE du conteneur sur ces racines (filet après un lanceur tué). */
  revoke(roots: RootSet): boolean {
    if (!this.status.available) return false;
    return revokeRoots(this.status.launcherPath, this.profile, roots);
  }

  /** ACE du conteneur encore présentes sur ces racines. */
  aclStatus(roots: RootSet): readonly AclStatus[] {
    if (!this.status.available) return [];
    const json = this.#manage(["acl-status", "--profile", this.profile, ...rootArgs(roots)]);
    const list = Array.isArray(json["acl"]) ? (json["acl"] as unknown[]) : [];
    return list.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const r = item as Record<string, unknown>;
      return typeof r["path"] === "string"
        ? [{ path: r["path"], exists: r["exists"] === true, granted: r["granted"] === true }]
        : [];
    });
  }

  /** Processus encore actifs dans un job, vus depuis n'importe quel processus. */
  query(jobName: string): { readonly found: boolean | null; readonly active: number | null } {
    if (!this.status.available) return { found: null, active: null };
    return queryJob(this.status.launcherPath, jobName);
  }

  #manage(args: readonly string[], allowFailure = false): Readonly<Record<string, unknown>> {
    if (!this.status.available) throw new Error(`isolation indisponible : ${this.status.reason}`);
    const result = spawnSync(this.status.launcherPath, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    const json = parseJson(result.stdout.trim());
    if (json === null || (!allowFailure && result.status !== 0)) {
      const detail = `${result.stdout}${result.stderr}`.trim().slice(0, 300);
      throw new Error(`lanceur confiné (${String(args[0])}) : ${detail}`);
    }
    return json;
  }
}

function rootArgs(roots: RootSet): string[] {
  return [
    ...roots.readWrite.flatMap((r) => ["--rw", r]),
    ...roots.readOnly.flatMap((r) => ["--ro", r]),
  ];
}

function revokeRoots(launcherPath: string, profile: string, roots: RootSet): boolean {
  if (roots.readWrite.length + roots.readOnly.length === 0) return true;
  const result = spawnSync(launcherPath, ["revoke", "--profile", profile, ...rootArgs(roots)], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  return result.status === 0 && parseJson(result.stdout.trim()) !== null;
}

function queryJob(
  launcherPath: string,
  jobName: string,
): { readonly found: boolean | null; readonly active: number | null } {
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

function terminateJob(launcherPath: string, jobName: string, timeoutMs: number): boolean {
  const ms = Math.max(1, Math.ceil(timeoutMs));
  const result = spawnSync(
    launcherPath,
    ["terminate", "--job-name", jobName, "--timeout-ms", String(ms)],
    { encoding: "utf8", windowsHide: true, timeout: ms + 5_000 },
  );
  const json = parseJson(result.stdout.trim());
  return json !== null && (json["found"] === false || json["active"] === 0);
}

export function parseJson(text: string): Readonly<Record<string, unknown>> | null {
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
