/**
 * Implémentations du signal de priorité humaine. Aucune ne capture de contenu : seule
 * la durée d'inactivité (ou un état fixé par test) est lue.
 */

import { execFile, spawn } from "node:child_process";
import type { DurationMs, UtcTimestamp } from "../contracts/index.js";
import type { PrioritySignal } from "../policy/index.js";
import type { SchedulerClock } from "./clock.js";
import type { UserPrioritySignal } from "./ports.js";

function iso(ms: number): UtcTimestamp {
  return new Date(ms).toISOString() as UtcTimestamp;
}

/** Signal piloté par les tests : favorable, défavorable, daté ou indisponible. */
export class ManualPrioritySignal implements UserPrioritySignal {
  #signal: PrioritySignal | undefined;
  #error: Error | undefined;

  set(favorable: boolean, observedAtMs: number): void {
    this.#signal = { favorable, observedAt: iso(observedAtMs) };
    this.#error = undefined;
  }

  unavailable(): void {
    this.#signal = undefined;
    this.#error = undefined;
  }

  fail(error: Error): void {
    this.#error = error;
  }

  read(): Promise<PrioritySignal | undefined> {
    if (this.#error !== undefined) return Promise.reject(this.#error);
    return Promise.resolve(this.#signal);
  }
}

/** Source de durée d'inactivité du poste, en millisecondes. */
export interface IdleSource {
  idleMs(): Promise<DurationMs>;
}

/**
 * Favorable si le poste est inactif depuis au moins `idleThresholdMs`. L'observation est
 * datée à la lecture ; une source en erreur ou incohérente donne un signal absent.
 */
export class IdlePrioritySignal implements UserPrioritySignal {
  constructor(
    private readonly source: IdleSource,
    private readonly clock: SchedulerClock,
    private readonly idleThresholdMs: DurationMs,
  ) {}

  async read(): Promise<PrioritySignal | undefined> {
    const idle = await this.source.idleMs();
    if (!Number.isSafeInteger(idle) || idle < 0) return undefined;
    return { favorable: idle >= this.idleThresholdMs, observedAt: iso(this.clock.now()) };
  }
}

// `GetLastInputInfo` ne donne que l'instant de la dernière entrée clavier/souris de la
// session interactive : ni contenu, ni application, ni droits administrateur.
const WINDOWS_IDLE_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MindWakeIdle {
  [StructLayout(LayoutKind.Sequential)]
  struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")]
  static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  public static long IdleMs() {
    var info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    if (!GetLastInputInfo(ref info)) return -1;
    return unchecked((uint)Environment.TickCount - info.dwTime);
  }
}
"@
[MindWakeIdle]::IdleMs()
`;

/**
 * Inactivité Windows par `GetLastInputInfo`, via un PowerShell court sans profil.
 * Proposition pour le daemon : valable seulement dans la session interactive de
 * l'utilisateur (un service en session 0 lirait une autre session). Chaque lecture
 * lance un processus ; à remplacer par un appel natif si le coût devient gênant.
 */
export function windowsIdleSource(timeoutMs: DurationMs = 10_000): IdleSource {
  const encoded = Buffer.from(WINDOWS_IDLE_SCRIPT, "utf16le").toString("base64");
  return {
    idleMs: () =>
      new Promise((resolve, reject) => {
        execFile(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
          { timeout: timeoutMs, windowsHide: true },
          (error: Error | null, stdout: string) => {
            if (error !== null) {
              reject(error);
              return;
            }
            const value = Number(stdout.trim());
            if (!Number.isSafeInteger(value) || value < 0) {
              reject(new Error("durée d'inactivité illisible"));
              return;
            }
            resolve(value);
          },
        );
      }),
  };
}

/** Dernière inactivité observée, datée à sa lecture. */
export interface IdleObservation {
  readonly idleMs: DurationMs;
  readonly observedAtMs: number;
}

/**
 * Lecture continue de l'inactivité : la dernière valeur est disponible sans attendre,
 * pour le watchdog du runner (toutes les 50 ms) comme pour le scheduler. Une source qui
 * se tait laisse vieillir l'observation : au-delà de `maxSignalAgeMs`, la policy la
 * traite comme inconnue (pas de réveil, session interrompue).
 */
export interface IdleWatcher {
  latest(): IdleObservation | null;
  close(): void;
}

/** Interroge une `IdleSource` à intervalle fixe (tests, ou repli sans flux). */
export function pollingIdleWatcher(
  source: IdleSource,
  intervalMs: number,
  now: () => number = Date.now,
): IdleWatcher {
  let latest: IdleObservation | null = null;
  let busy = false;
  const poll = (): void => {
    if (busy) return;
    busy = true;
    source
      .idleMs()
      .then((idle) => {
        if (Number.isSafeInteger(idle) && idle >= 0) latest = { idleMs: idle, observedAtMs: now() };
      })
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  };
  poll();
  const timer = setInterval(poll, intervalMs);
  timer.unref();
  return {
    latest: () => latest,
    close: () => {
      clearInterval(timer);
    },
  };
}

/**
 * Inactivité Windows en flux : un seul PowerShell sans profil compile `GetLastInputInfo`
 * une fois, puis écrit la durée d'inactivité toutes les `intervalMs`. Lancer un PowerShell
 * par lecture coûte 0,4 à 0,9 s (compilation `Add-Type`, mesuré le 29 octobre 2026) : trop
 * lent pour une borne d'interruption d'une seconde. Aucun droit administrateur, aucun
 * contenu lu. Le processus est relancé s'il meurt ; `close()` l'arrête.
 */
export function windowsIdleWatcher(intervalMs = 250, now: () => number = Date.now): IdleWatcher {
  const script = `${WINDOWS_IDLE_SCRIPT.replace(/\[MindWakeIdle\]::IdleMs\(\)\s*$/, "")}
while ($true) { [Console]::Out.WriteLine([MindWakeIdle]::IdleMs()); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${String(Math.max(50, Math.floor(intervalMs)))} }
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  let latest: IdleObservation | null = null;
  let closed = false;
  let child: ReturnType<typeof spawn> | null = null;
  const start = (): void => {
    if (closed) return;
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const value = Number(line.trim());
        if (line.trim() !== "" && Number.isSafeInteger(value) && value >= 0) {
          latest = { idleMs: value, observedAtMs: now() };
        }
      }
    });
    child.on("error", () => undefined);
    child.on("exit", () => {
      child = null;
      // Relance après une pause : l'observation vieillit entre-temps, jamais inventée.
      if (!closed) setTimeout(start, 1_000).unref();
    });
  };
  start();
  return {
    latest: () => latest,
    close: () => {
      closed = true;
      child?.kill();
    },
  };
}

/**
 * Signal de priorité humaine sur une observation continue : favorable si le poste est
 * inactif depuis au moins le seuil de la policy, daté de l'instant de l'observation (une
 * observation ancienne est donc périmée). Aucune observation : signal absent.
 */
export class WatchedPrioritySignal implements UserPrioritySignal {
  constructor(
    private readonly watcher: IdleWatcher,
    /** Seuil `humanPriority.idleThresholdMs` de la révision effective, relu à chaque appel. */
    private readonly idleThresholdMs: () => number | null,
  ) {}

  current(): PrioritySignal | undefined {
    const observation = this.watcher.latest();
    const threshold = this.idleThresholdMs();
    if (observation === null || threshold === null) return undefined;
    return {
      favorable: observation.idleMs >= threshold,
      observedAt: iso(observation.observedAtMs),
    };
  }

  read(): Promise<PrioritySignal | undefined> {
    return Promise.resolve(this.current());
  }
}
