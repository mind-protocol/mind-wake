/**
 * Implémentations du signal de priorité humaine. Aucune ne capture de contenu : seule
 * la durée d'inactivité (ou un état fixé par test) est lue.
 */

import { execFile } from "node:child_process";
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
