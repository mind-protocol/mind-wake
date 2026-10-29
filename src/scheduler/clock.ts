/**
 * Horloges du scheduler (SPEC §5.2). L'horloge murale (UTC) sert aux échéances
 * persistées et aux fenêtres ; l'horloge monotone sert aux durées d'un processus vivant.
 * Les deux sont injectées pour que les tests simulent veille, recul et changement d'heure.
 */

export interface SchedulerClock {
  /** Instant UTC courant en millisecondes depuis l'époque Unix. */
  now(): number;
  /** Millisecondes monotones, sans rapport avec l'heure murale ; jamais en recul. */
  monotonic(): number;
}

export const systemClock: SchedulerClock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
};

/** Horloge de test : l'heure murale et l'horloge monotone avancent séparément. */
export class FakeClock implements SchedulerClock {
  #wall: number;
  #mono = 0;

  constructor(wallMs: number) {
    this.#wall = wallMs;
  }

  now(): number {
    return this.#wall;
  }

  monotonic(): number {
    return this.#mono;
  }

  /** Écoulement normal du temps : les deux horloges avancent ensemble. */
  advance(ms: number): void {
    this.#wall += ms;
    this.#mono += ms;
  }

  /** Changement de l'heure murale seule (réglage, synchronisation NTP). */
  setWall(wallMs: number): void {
    this.#wall = wallMs;
  }

  /**
   * Veille du poste : l'heure murale saute ; l'horloge monotone avance de
   * `monotonicMs` (0 pour une horloge qui ne compte pas la veille).
   */
  sleep(wallMs: number, monotonicMs = 0): void {
    this.#wall += wallMs;
    this.#mono += monotonicMs;
  }
}
