/**
 * Port consommé par les adapters runtime (Codex, Claude Code, Gemini CLI) pour donner à
 * leur CLI, confiné, un accès à son fournisseur et à lui seul.
 *
 * Usage côté adapter :
 *
 * ```ts
 * const session = await transport.open({ executable: cliExe, args: cliArgs });
 * const proc = sandbox.launch({
 *   ...spec,
 *   executable: session.launch.executable,
 *   args: session.launch.args,
 *   env: { ...spec.env, ...session.launch.env },
 *   readOnlyRoots: [...spec.readOnlyRoots, ...session.launch.readOnlyRoots],
 *   broker: session.launch.broker,
 * });
 * // … fin de session :
 * const observed = await session.close();
 * ```
 *
 * Le credential n'est PAS fourni par ce port : chaque CLI le lit et l'envoie lui-même dans
 * son flux TLS (voir README, « Credentials »).
 */

import type { NetworkDestination } from "../contracts/index.js";
import { brokerPipeName, type BrokerEndpoint } from "../sandbox/broker.js";
import { PROVIDER_ENVIRONMENT, providerAllowlist, type ProviderRuntime } from "./destinations.js";
import { ProviderRelay, type RelayEvent, type RelayStats, type RelayUpstream } from "./relay.js";
import { installShim } from "./shim-source.js";

/** Commande du CLI telle que l'adapter la lancerait sans transport. */
export interface ProviderCommand {
  /** Exécutable natif (Codex) ou `node.exe` + script d'entrée (CLI Node) : pas de `.cmd`. */
  readonly executable: string;
  readonly args: readonly string[];
}

/** Éléments à ajouter au `SandboxLaunchSpec` du lancement confiné. */
export interface ProviderLaunch {
  /** → `SandboxLaunchSpec.broker`. */
  readonly broker: BrokerEndpoint;
  /** Copie de `node.exe` dans une racine runtime : le shim enveloppe la commande. */
  readonly executable: string;
  readonly args: readonly string[];
  /** Variables non secrètes du runtime (trafic non essentiel coupé, proxy de `fetch`). */
  readonly env: Readonly<Record<string, string>>;
  /** Dossier du shim, à accorder en lecture seule. */
  readonly readOnlyRoots: readonly string[];
}

export interface ProviderTransportSession {
  readonly launch: ProviderLaunch;
  /** Observations du relais (sans terminer TLS) : tunnels, volumes, refus, erreurs amont. */
  stats(): RelayStats;
  /** Ferme le relais (coupe les tunnels restants) et rend le bilan final. */
  close(): Promise<RelayStats>;
}

export interface ProviderTransport {
  readonly runtime: ProviderRuntime;
  readonly destinations: readonly NetworkDestination[];
  open(command: ProviderCommand): Promise<ProviderTransportSession>;
}

export interface RelayTransportOptions {
  readonly runtime: ProviderRuntime;
  /** Copie de `node.exe` accessible au conteneur (l'ACL de Program Files ne l'est pas). */
  readonly nodeExecutable: string;
  /** Dossier où écrire le shim, accordé en lecture seule au conteneur. */
  readonly shimDir: string;
  /** `network.providerTransportDestinations` de la policy : restreint le catalogue. */
  readonly policyDestinations?: readonly NetworkDestination[];
  readonly journal?: (event: RelayEvent) => void;
  /** Tests seulement : accès amont simulé (serveur HTTPS local). */
  readonly upstream?: RelayUpstream;
  /** Tests seulement : remplace l'allowlist vérifiée. */
  readonly destinations?: readonly NetworkDestination[];
}

/** Arguments Node requis dans le conteneur (S2 : `realpath` échoue sur `C:\`). */
export const CONTAINED_NODE_FLAGS = ["--preserve-symlinks-main", "--preserve-symlinks"] as const;

/** Un relais par lancement, sur un port loopback éphémère, et un pipe broker imprévisible. */
export class RelayProviderTransport implements ProviderTransport {
  readonly runtime: ProviderRuntime;
  readonly destinations: readonly NetworkDestination[];
  #options: RelayTransportOptions;

  constructor(options: RelayTransportOptions) {
    this.runtime = options.runtime;
    this.destinations =
      options.destinations ?? providerAllowlist(options.runtime, options.policyDestinations);
    this.#options = options;
  }

  async open(command: ProviderCommand): Promise<ProviderTransportSession> {
    const shim = installShim(this.#options.shimDir);
    const relay = new ProviderRelay({
      runtime: this.runtime,
      destinations: this.destinations,
      ...(this.#options.journal === undefined ? {} : { journal: this.#options.journal }),
      ...(this.#options.upstream === undefined ? {} : { upstream: this.#options.upstream }),
    });
    const { port } = await relay.listen();
    const pipeName = brokerPipeName();
    const launch: ProviderLaunch = {
      broker: { pipeName, port },
      executable: this.#options.nodeExecutable,
      args: [
        ...CONTAINED_NODE_FLAGS,
        shim,
        "--pipe",
        pipeName,
        "--",
        command.executable,
        ...command.args,
      ],
      env: PROVIDER_ENVIRONMENT[this.runtime],
      readOnlyRoots: [this.#options.shimDir],
    };
    let closed: Promise<RelayStats> | null = null;
    return {
      launch,
      stats: () => relay.stats(),
      close: () => (closed ??= relay.close().then(() => relay.stats())),
    };
  }
}
