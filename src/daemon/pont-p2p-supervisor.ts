/**
 * Supervision du pont pair-à-pair ⬡ (`services/pont-p2p/main.mjs`), hébergée par `daemon run`.
 *
 * Interrupteur « Pont pair-à-pair entre colonies » des Réglages, désactivé par défaut
 * (`pont-p2p.json`, `enabled: true` pour l'activer). Toutes les 10 s, le superviseur :
 * - ne lance rien si l'interrupteur est désactivé, si le daemon s'arrête ou si Force-off est
 *   posé : aucun processus, donc aucun accès réseau ;
 * - lance le service s'il doit tourner et ne tourne pas, avec un délai croissant après un échec
 *   (0, 10 s, 30 s, 1 min, 2 min, 5 min) ;
 * - arrête le service qu'il a lancé dès que l'interrupteur est coupé (le service le constate aussi
 *   tout seul en une seconde, et s'arrête si le daemon parent disparaît).
 *
 * Le service écrit les messages reçus comme réveils dans `wakeups/` : fenêtres, pause, Force-off
 * et quota restent décidés par le scheduler, jamais par le pont.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PONT_TICK_MS = 10_000;
const BACKOFF_MS = [0, 10_000, 30_000, 60_000, 120_000, 300_000];
export const PONT_SETTINGS_FILE = "pont-p2p.json";

/** Lit seulement `enabled` et `name` ; sans fichier : désactivé. */
export function pontEnabled(dataDir: string): boolean {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir, PONT_SETTINGS_FILE), "utf8")) as { enabled?: unknown; name?: unknown };
    return s.enabled === true && typeof s.name === "string" && s.name.length > 1;
  } catch {
    return false;
  }
}

export interface PontSupervisorOptions {
  readonly dataDir: string;
  readonly wakeupsDir: () => string;
  readonly repoDir?: string;
  readonly allowed?: () => boolean;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  readonly spawnService?: (args: readonly string[]) => ChildProcess;
  readonly tickMs?: number;
}

export class PontP2PSupervisor {
  #timer: NodeJS.Timeout | undefined;
  #child: ChildProcess | null = null;
  #failures = 0;
  #nextStartAt = 0;
  #closed = false;
  readonly #o: PontSupervisorOptions;
  readonly #now: () => number;

  constructor(options: PontSupervisorOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    this.tick();
    this.#timer = setInterval(() => this.tick(), this.#o.tickMs ?? PONT_TICK_MS);
    this.#timer.unref();
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#stopChild("arrêt du daemon");
  }

  /** Processus lancé par ce superviseur (tests). */
  get running(): boolean {
    return this.#child !== null && this.#child.exitCode === null && this.#child.signalCode === null;
  }

  /** Un passage. Ne lève jamais. Renvoie l'action faite (tests). */
  tick(): "off" | "started" | "stopped" | "running" | "waiting" | null {
    if (this.#closed) return null;
    try {
      const wanted = this.#o.allowed?.() !== false && pontEnabled(this.#o.dataDir);
      if (!wanted) {
        if (this.running) {
          this.#stopChild("interrupteur désactivé ou Force-off");
          return "stopped";
        }
        this.#failures = 0;
        return "off";
      }
      if (this.running) return "running";
      const now = this.#now();
      if (now < this.#nextStartAt) return "waiting";
      this.#launch();
      return "started";
    } catch (error) {
      this.#o.log?.(`Pont ⬡ : erreur de supervision : ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  #repoDir(): string {
    return this.#o.repoDir ?? process.env["MIND_WAKE_REPO_DIR"] ?? fileURLToPath(new URL("../../", import.meta.url));
  }

  #launch(): void {
    const repo = this.#repoDir();
    const args = [
      path.join(repo, "services", "pont-p2p", "main.mjs"),
      "--data-dir", this.#o.dataDir,
      "--wakeups-dir", this.#o.wakeupsDir(),
      "--parent", String(process.pid),
    ];
    const child = (this.#o.spawnService ?? ((a) => spawn(process.execPath, [...a], { cwd: repo, windowsHide: true, stdio: "ignore" })))(args);
    this.#child = child;
    const startedAt = this.#now();
    child.on("error", () => {
      // Constaté au passage suivant.
    });
    child.on("exit", (code) => {
      if (this.#child === child) this.#child = null;
      if (this.#closed) return;
      if (code === 0) {
        this.#failures = 0;
        this.#nextStartAt = 0;
        return;
      }
      // Échec : délai croissant, sauf si le service a tenu 10 min.
      this.#failures = this.#now() - startedAt > 600_000 ? 1 : this.#failures + 1;
      this.#nextStartAt = this.#now() + BACKOFF_MS[Math.min(this.#failures, BACKOFF_MS.length - 1)]!;
      this.#o.log?.(`Pont ⬡ : service arrêté (code ${String(code)}), relance dans ${String(Math.round((this.#nextStartAt - this.#now()) / 1000))} s`);
    });
    this.#o.log?.(`Pont ⬡ : service lancé (pid ${String(child.pid ?? "?")})`);
  }

  #stopChild(reason: string): void {
    const child = this.#child;
    if (child === null) return;
    this.#child = null;
    try {
      child.kill();
    } catch {
      // Déjà terminé.
    }
    this.#o.log?.(`Pont ⬡ : service arrêté (${reason})`);
  }
}
