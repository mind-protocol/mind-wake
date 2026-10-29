/**
 * Faits de lancement du daemon SIMULÉ : adapter factice, signal d'activité utilisateur
 * simulé, isolation déclarée simulée. Rien ici ne présente une capacité réelle : la
 * sandbox de production (S10) et l'adapter Codex (S11) ne sont pas implémentés, et le
 * daemon refuse de démarrer sans `--simulated`.
 */

import fs from "node:fs";
import type { RuntimeAdapter, RuntimeGroup, UtcTimestamp } from "../contracts/index.js";
import type { BillingFacts, LaunchFacts, PrioritySignal, SessionChecks } from "../policy/index.js";
import type { LaunchEnvironment, UserPrioritySignal } from "../scheduler/index.js";

/** Runtime déclaré par l'adapter factice ; la policy doit le désigner exactement. */
export const SIMULATED_RUNTIME: Omit<RuntimeGroup, "adapterId"> = {
  provider: "none",
  model: "none",
  authMode: "none",
};

function utcNow(): UtcTimestamp {
  return new Date().toISOString() as UtcTimestamp;
}

/**
 * Signal d'activité SIMULÉ : défavorable tant que le fichier `flagPath` existe. Lecture
 * synchrone, utilisable à la fois par le scheduler et par le watchdog du runner (toutes
 * les 50 ms). Aucune capture de contenu : seule la présence du fichier est lue.
 */
export class SimulatedActivitySignal implements UserPrioritySignal {
  constructor(readonly flagPath: string) {}

  current(): PrioritySignal {
    return { favorable: !fs.existsSync(this.flagPath), observedAt: utcNow() };
  }

  read(): Promise<PrioritySignal | undefined> {
    return Promise.resolve(this.current());
  }
}

/**
 * Environnement de lancement du mode simulé. `sandboxOperational` vaut `true` par
 * déclaration : seule l'arborescence de processus est contenue (Job Object, S7) ; aucune
 * isolation de fichiers, réseau ou secrets n'existe. Cette déclaration n'est admise que
 * pour l'adapter factice, qui n'exécute qu'un script local sans appel modèle.
 */
export class SimulatedEnvironment implements LaunchEnvironment {
  constructor(
    private readonly adapterFacts: RuntimeAdapter,
    private readonly runtime: RuntimeGroup,
  ) {}

  async adapter(): Promise<LaunchFacts["adapter"]> {
    const probe = await this.adapterFacts.probe();
    if (!probe.simulated) return undefined;
    return { probe, capabilities: await this.adapterFacts.capabilities(), runtime: this.runtime };
  }

  sandboxOperational(): Promise<boolean | undefined> {
    return Promise.resolve(true);
  }

  billing(): Promise<BillingFacts | undefined> {
    return Promise.resolve({ kind: "no_charge" });
  }
}

/** Conditions vivantes revérifiées par le runner avant chaque action. */
export function simulatedLiveChecks(signal: SimulatedActivitySignal): Omit<SessionChecks, "now"> {
  return { userPriority: signal.current(), sandboxOperational: true, onSubscription: false };
}
