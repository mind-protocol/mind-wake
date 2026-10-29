/**
 * Ports de lancement de l'adapter Codex : où tourne le processus `codex app-server`
 * (sandbox AppContainer ou arborescence contenue de l'hôte) et par où il joint son
 * fournisseur (transport fourni par le relais fournisseur, non implémenté ici).
 *
 * Le mode sans approbation n'est accordé que si le lanceur atteste un confinement
 * AppContainer dont l'autotest de refus a réussi pour le binaire de lanceur en service
 * (AGENTS §3.6, ADR-005 §2).
 */

import type { DurationMs, ProfileId, SessionId } from "../../contracts/index.js";
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
  /**
   * Mode sans approbation demandé à Codex : transmis au runner, qui le refuse hors sandbox
   * sauf consentement ADR-006 qu'il vérifie lui-même.
   */
  readonly unattended?: boolean;
}

export interface IsolationAttestation {
  /** Processus enfermé dans un AppContainer sans capacité (réseau, fichiers, secrets). */
  readonly confined: boolean;
  /** Autotest de refus réussi sur ce poste pour le lanceur en service. */
  readonly selfTestPassed: boolean;
  readonly detail: string;
}

export interface CodexLauncher {
  /** Confinement prévu pour cette session (le runner le connaît par session). */
  isolation(sessionId: SessionId): IsolationAttestation;
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
 * Hôte du runner, sous sa forme câblée (`isolation(sessionId)`, `unattended`) ou sous la
 * forme initiale (sans isolation déclarée : Job Object seul).
 */
export type RunnerHostLike = AdapterHost & {
  isolation?(sessionId: SessionId): "sandbox" | "job_only" | "none";
};

/**
 * Lancement par le runner (`spawnContained`) : le processus est dans l'arborescence de la
 * session, que l'arrêt d'urgence termine. Confiné si le runner déclare `sandbox` (son
 * autotest de refus a réussi), sinon sur l'hôte (Job Object seul).
 */
export function hostLauncher(host: RunnerHostLike, maxProcesses?: number): CodexLauncher {
  return {
    isolation: (sessionId) => {
      const mode = host.isolation?.(sessionId) ?? "job_only";
      return mode === "sandbox"
        ? { confined: true, selfTestPassed: true, detail: "sandbox du runner (autotest réussi)" }
        : {
            confined: false,
            selfTestPassed: false,
            detail: "hôte, Job Object seul : non isolé",
          };
    },
    launch: (sessionId, command) => {
      // `unattended` et `broker` (forme câblée) passent par un objet intermédiaire : la forme
      // initiale de `ContainedCommand` les ignore.
      const contained = {
        executable: command.executable,
        args: command.args,
        env: command.env,
        cwd: command.cwd,
        ...(maxProcesses === undefined ? {} : { maxProcesses }),
        ...(command.unattended === true ? { unattended: true } : {}),
      };
      return host.spawnContained(sessionId, contained);
    },
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

/** Superviseur d'arborescence du runner (`ProcessTreeSupervisor`), forme employée. */
export interface SupervisorLike {
  spawn(
    profileId: ProfileId,
    sessionId: SessionId,
    command: {
      readonly executable: string;
      readonly args: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly cwd?: string;
    },
  ): CodexProcess;
}

/**
 * Lanceur des lectures de jauge, hors de toute session : Job Object nommé d'après une
 * session synthétique, aucune approbation (aucun tour, donc aucune commande du modèle).
 */
export function supervisorLauncher(
  supervisor: SupervisorLike,
  profileId: ProfileId,
): CodexLauncher {
  return {
    isolation: () => ({
      confined: false,
      selfTestPassed: false,
      detail: "lecture de jauge : Job Object seul, aucun tour",
    }),
    launch: (sessionId, command) =>
      supervisor.spawn(profileId, sessionId, {
        executable: command.executable,
        args: command.args,
        env: command.env,
        cwd: command.cwd,
      }),
  };
}
