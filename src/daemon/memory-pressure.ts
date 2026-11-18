/**
 * Pression mémoire du poste (incident du 17 nov. 2026, salle 6 « Emploi remote ») : quand la
 * mémoire engageable de Windows est épuisée, n'importe quelle allocation échoue — SQLite rend
 * « out of memory » (SQLITE_NOMEM), Node meurt en « Fatal JavaScript out of memory » même avec un
 * tas de 6 Mo. Le worker des salles tombait alors en entier. Ce module mesure la mémoire
 * disponible (`os.freemem`, soit la mémoire physique disponible sous Windows) et reconnaît ces
 * erreurs, pour différer les lancements coûteux (sessions Claude ≈ 550 Mo chacune) au lieu de
 * précipiter la panne.
 */
import os from "node:os";

/** Seuil par défaut : en dessous, aucun nouveau processus lourd n'est lancé. */
export const LOW_MEMORY_FREE_MB = 1024;

export interface MemoryReading {
  readonly freeMb: number;
  readonly totalMb: number;
  readonly low: boolean;
}

export type FreeMemoryProbe = () => number;

const MB = 1024 * 1024;

export function readMemory(
  thresholdMb = LOW_MEMORY_FREE_MB,
  probe: FreeMemoryProbe = os.freemem,
  total: () => number = os.totalmem,
): MemoryReading {
  let free: number;
  try {
    free = probe();
  } catch {
    // Mesure impossible : on ne bloque jamais le travail sur une sonde muette.
    return { freeMb: Number.NaN, totalMb: Number.NaN, low: false };
  }
  const freeMb = Math.round(free / MB);
  const totalMb = Math.round(total() / MB);
  // Petite machine : le seuil ne dépasse jamais un dixième de la mémoire totale.
  const effective =
    Number.isFinite(totalMb) && totalMb > 0 ? Math.min(thresholdMb, totalMb / 10) : thresholdMb;
  return { freeMb, totalMb, low: Number.isFinite(freeMb) && freeMb < effective };
}

/** Erreur d'allocation (SQLite, libuv, V8) : signe de pression mémoire, pas d'un défaut du tour. */
export function isOutOfMemoryError(error: unknown): boolean {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  const text =
    error instanceof Error
      ? `${error.message} ${typeof code === "string" ? code : ""}`
      : String(error);
  return /out of memory|\bENOMEM\b|SQLITE_NOMEM|allocation failed|Cannot allocate memory/i.test(
    text,
  );
}

/**
 * Attente bornée avant un lancement : tant que la mémoire est basse, `check().wait` vaut vrai, au
 * plus `maxWaitMs` de suite ; ensuite le lancement passe quand même (une room ne reste jamais
 * muette indéfiniment). `note` rend un message à journaliser une fois par épisode.
 */
export class MemoryGate {
  #since: number | null = null;
  #noted = false;
  constructor(
    private readonly options: {
      readonly maxWaitMs: number;
      readonly thresholdMb?: number;
      readonly probe?: FreeMemoryProbe;
      readonly total?: () => number;
      readonly now?: () => number;
    },
  ) {}
  check(): { wait: boolean; note: string | null; reading: MemoryReading } {
    const reading = readMemory(this.options.thresholdMb, this.options.probe, this.options.total);
    const now = (this.options.now ?? Date.now)();
    if (!reading.low) {
      const recovered = this.#since !== null;
      this.#since = null;
      this.#noted = false;
      return {
        wait: false,
        note: recovered
          ? `mémoire revenue (${String(reading.freeMb)} Mo disponibles), lancement repris.`
          : null,
        reading,
      };
    }
    this.#since ??= now;
    const waited = now - this.#since;
    if (waited >= this.options.maxWaitMs) {
      const note = `mémoire toujours basse (${String(reading.freeMb)} Mo) après ${String(Math.round(waited / 1000))} s : lancement sans attendre davantage.`;
      this.#since = null;
      this.#noted = false;
      return { wait: false, note, reading };
    }
    const note = this.#noted
      ? null
      : `mémoire basse (${String(reading.freeMb)} Mo disponibles sur ${String(reading.totalMb)} Mo) : lancement différé.`;
    this.#noted = true;
    return { wait: true, note, reading };
  }
}
