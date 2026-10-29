/**
 * Faits de lancement du daemon. Mode SIMULÉ : adapter factice, signal d'activité
 * utilisateur simulé, Job Object seul (aucune isolation de fichiers ni de réseau).
 * Mode réel : adapter enregistré, sandbox AppContainer après autotest de refus réussi,
 * jauge officielle de quota pour la voie abonnement.
 */

import fs from "node:fs";
import type {
  ProviderQuotaSnapshot,
  RuntimeAdapter,
  RuntimeGroup,
  UtcTimestamp,
} from "../contracts/index.js";
import type {
  BillingFacts,
  LaunchFacts,
  PacingEstimate,
  PrioritySignal,
  SessionChecks,
} from "../policy/index.js";
import { canReadQuota } from "../runner/index.js";
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

/**
 * Environnement de lancement d'un adapter réel : faits de l'adapter enregistré (probe,
 * capacités, runtime configuré), isolation prête seulement après autotest de refus
 * réussi, facturation déclarée par l'enregistrement et lecture officielle de la jauge.
 * Une lecture absente ou en erreur laisse la condition inconnue : refus.
 */
export class RuntimeEnvironment implements LaunchEnvironment {
  constructor(
    private readonly adapterFacts: RuntimeAdapter,
    private readonly runtime: RuntimeGroup,
    private readonly billingFacts: BillingFacts,
    private readonly sandboxReady: () => boolean,
    /** Pilotage : chaque lecture est observée, les estimations alimentent `decideLaunch`. */
    private readonly pacing?: {
      observe(snapshots: readonly ProviderQuotaSnapshot[]): void;
      estimates(): readonly PacingEstimate[];
    },
  ) {}

  async adapter(): Promise<LaunchFacts["adapter"]> {
    const probe = await this.adapterFacts.probe();
    if (probe.simulated) return undefined;
    return { probe, capabilities: await this.adapterFacts.capabilities(), runtime: this.runtime };
  }

  sandboxOperational(): Promise<boolean | undefined> {
    return Promise.resolve(this.sandboxReady());
  }

  billing(): Promise<BillingFacts | undefined> {
    return Promise.resolve(this.billingFacts);
  }

  async quotaSnapshots(): Promise<readonly ProviderQuotaSnapshot[] | undefined> {
    if (this.billingFacts.kind !== "subscription_quota") return undefined;
    if (!canReadQuota(this.adapterFacts)) return undefined;
    const snapshots = await this.adapterFacts.readQuota();
    try {
      this.pacing?.observe(snapshots);
    } catch {
      // Le suivi du pilotage ne doit jamais empêcher la lecture de la jauge.
    }
    return snapshots;
  }

  pacingEstimates(): Promise<readonly PacingEstimate[] | undefined> {
    return Promise.resolve(this.pacing?.estimates());
  }
}

/**
 * Conditions vivantes d'une session réelle : signal d'activité réel (`GetLastInputInfo`,
 * observation continue) ; absent ou périmé, la policy le traite comme inconnu et
 * interrompt. La jauge de quota est ajoutée par le runner.
 */
export function runtimeLiveChecks(
  signal: { current(): PrioritySignal | undefined },
  sandboxReady: () => boolean,
): Omit<SessionChecks, "now"> {
  const userPriority = signal.current();
  return {
    ...(userPriority === undefined ? {} : { userPriority }),
    sandboxOperational: sandboxReady(),
  };
}
