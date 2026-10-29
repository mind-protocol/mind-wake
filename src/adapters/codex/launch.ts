/**
 * Ports de lancement de l'adapter Codex : où tourne le processus `codex app-server`
 * (sandbox AppContainer ou arborescence contenue de l'hôte) et par où il joint son
 * fournisseur (transport fourni par le relais fournisseur, non implémenté ici).
 *
 * Le mode sans approbation n'est accordé que si le lanceur atteste un confinement
 * AppContainer dont l'autotest de refus a réussi pour le binaire de lanceur en service
 * (AGENTS §3.6, ADR-005 §2).
 */

import type { DurationMs, SessionId } from "../../contracts/index.js";
import type { AdapterHost } from "../../runner/host.js";
import type { BrokerEndpoint } from "../../sandbox/broker.js";
import type { SandboxLaunchSpec } from "../../sandbox/sandbox.js";
import type { LineChannel } from "./rpc.js";

/** Processus confiné vu par l'adapter : forme commune de `ContainedProcess` et `SandboxedProcess`. */
export interface CodexProcess extends LineChannel {
  started(): Promise<number>;
  readonly exited: Promise<unknown>;
  readonly hasExited: boolean;
  terminateTree(timeoutMs?: DurationMs): Promise<{
    readonly confirmed: boolean;
    readonly elapsedMs: number;
    readonly detail?: string;
  }>;
}

export interface CodexCommand {
  readonly executable: string;
  readonly args: readonly string[];
  /** Environnement complet demandé, sans secret ; rien n'est hérité du daemon. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** Canal fournisseur ; absent = aucun réseau dans le conteneur. */
  readonly broker?: BrokerEndpoint;
}

export interface IsolationAttestation {
  /** Processus enfermé dans un AppContainer sans capacité (réseau, fichiers, secrets). */
  readonly confined: boolean;
  /** Autotest de refus réussi sur ce poste pour le lanceur en service. */
  readonly selfTestPassed: boolean;
  readonly detail: string;
}

export interface CodexLauncher {
  isolation(): IsolationAttestation;
  launch(sessionId: SessionId, command: CodexCommand): CodexProcess;
}

/**
 * Canal fournisseur d'une session, ouvert par le relais fournisseur (hors conteneur) qui
 * seul détient le credential, applique l'allowlist et lit les signaux de limitation.
 */
export interface ProviderChannel {
  readonly broker?: BrokerEndpoint;
  /** Surcharges `-c clé=valeur` (TOML) qui dirigent Codex vers le relais. */
  readonly configOverrides: Readonly<Record<string, string>>;
  /** Variables non secrètes nécessaires au relais ; un nom de secret est refusé. */
  readonly env: Readonly<Record<string, string>>;
  close(): Promise<void>;
}

/** Port fourni par le relais fournisseur (`src/broker/`), injecté dans l'adapter. */
export interface ProviderTransport {
  open(sessionId: SessionId): Promise<ProviderChannel>;
}

/**
 * Lancement dans l'arborescence contenue du runner (Job Object, sans AppContainer) :
 * le runner peut tout terminer, mais rien n'est confiné. Mode manuel seulement.
 */
export function hostLauncher(host: AdapterHost, maxProcesses?: number): CodexLauncher {
  return {
    isolation: () => ({
      confined: false,
      selfTestPassed: false,
      detail: "arborescence contenue de l'hôte (Job Object), sans AppContainer",
    }),
    launch: (sessionId, command) =>
      host.spawnContained(sessionId, {
        executable: command.executable,
        args: command.args,
        env: command.env,
        cwd: command.cwd,
        ...(maxProcesses === undefined ? {} : { maxProcesses }),
      }),
  };
}

/** Sous-ensemble de `Sandbox` employé (injectable en test). */
export interface SandboxLike {
  health(): { readonly operational: boolean; readonly detail: string };
  launch(spec: SandboxLaunchSpec): CodexProcess;
}

export interface AppContainerLauncherOptions {
  readonly sandbox: SandboxLike;
  /** Empreinte de la source du lanceur en service (`sandboxSourceDigest()`). */
  readonly launcherDigest: string;
  /** Dernier autotest de refus mémorisé, avec l'empreinte du lanceur testé. */
  readonly selfTest: { readonly passed: boolean; readonly launcherDigest: string } | null;
  readonly jobName: (sessionId: SessionId) => string;
  readonly readWriteRoots: readonly string[];
  /** Doit contenir le binaire Codex, Node si nécessaire, et `CODEX_HOME`. */
  readonly readOnlyRoots: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly maxProcesses?: number;
  readonly memoryLimitMb?: number;
  readonly maxWallMs?: number;
}

/** Lancement confiné AppContainer + Job Object (S10), seul à permettre l'autonomie. */
export function appContainerLauncher(options: AppContainerLauncherOptions): CodexLauncher {
  return {
    isolation: () => {
      const health = options.sandbox.health();
      const tested =
        options.selfTest?.passed === true &&
        options.selfTest.launcherDigest === options.launcherDigest;
      return {
        confined: health.operational,
        selfTestPassed: health.operational && tested,
        detail: !health.operational
          ? health.detail
          : tested
            ? `AppContainer, autotest réussi (lanceur ${options.launcherDigest})`
            : "AppContainer sans autotest de refus réussi pour ce lanceur",
      };
    },
    launch: (sessionId, command) =>
      options.sandbox.launch({
        jobName: options.jobName(sessionId),
        executable: command.executable,
        args: command.args,
        cwd: command.cwd,
        env: command.env,
        readWriteRoots: options.readWriteRoots,
        readOnlyRoots: options.readOnlyRoots,
        protectedPaths: options.protectedPaths,
        ...(options.maxProcesses === undefined ? {} : { maxProcesses: options.maxProcesses }),
        ...(options.memoryLimitMb === undefined ? {} : { memoryLimitMb: options.memoryLimitMb }),
        ...(options.maxWallMs === undefined ? {} : { maxWallMs: options.maxWallMs }),
        ...(command.broker === undefined ? {} : { broker: command.broker }),
      }),
  };
}
