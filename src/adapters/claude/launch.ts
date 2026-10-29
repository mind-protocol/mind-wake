/**
 * Ports de lancement de l'adapter Claude Code. L'adapter ne lance jamais `claude` lui-même :
 *
 * - `ClaudeLauncher` donne le processus : par le runner (`hostClaudeLauncher`, qui confine
 *   selon le mode de la session : sandbox, ou hôte NON ISOLÉ consenti par la policy,
 *   ADR-006), directement par la sandbox (`sandboxClaudeLauncher`, ADR-005), ou hors session
 *   pour la seule lecture de jauge (`supervisorClaudeLauncher`, Job Object, aucun tour) ;
 * - `ClaudeNetworkPort` ouvre le transport fournisseur d'une session. Il sera fourni par
 *   le relais fournisseur (`src/broker/`) ; cet adapter ne l'implémente pas. Il ne transmet
 *   jamais de credential : l'authentification reste celle du CLI officiel.
 */

import type { DurationMs, SessionId, UtcTimestamp } from "../../contracts/index.js";
import type { ProfileId } from "../../contracts/index.js";
import type { AdapterHost } from "../../runner/host.js";
import type {
  ContainedCommand,
  SessionProcess,
  TreeTermination,
} from "../../runner/process-tree.js";
import type { BrokerEndpoint } from "../../sandbox/broker.js";
import type { Sandbox } from "../../sandbox/sandbox.js";

/** Forme commune à `ContainedProcess` (runner) et `SandboxedProcess` (sandbox). */
export interface ClaudeProcess {
  started(): Promise<number>;
  readonly exited: Promise<{ readonly mainExitCode: number | null }>;
  readonly hasExited: boolean;
  readLine(): Promise<string | null>;
  send(line: string): void;
  /** Ferme l'entrée standard : le CLI en entrée `stream-json` se termine après son tour. */
  closeInput?(): void;
  terminateTree(timeoutMs?: DurationMs): Promise<TreeTermination>;
}

/** Canal fournisseur accordé à une session : endpoint broker et variables non secrètes. */
export interface ClaudeNetworkGrant {
  /** Pipe du broker pour un lancement confiné ; absent sur le poste hôte. */
  readonly broker?: BrokerEndpoint;
  /** Variables de transport (par exemple `HTTPS_PROXY`), jamais un credential. */
  readonly env: Readonly<Record<string, string>>;
}

export interface ClaudeNetworkPort {
  open(sessionId: SessionId): Promise<ClaudeNetworkGrant>;
  close(sessionId: SessionId): Promise<void>;
}

export interface ClaudeLaunchSpec {
  readonly sessionId: SessionId;
  readonly executable: string;
  readonly args: readonly string[];
  /** Espace d'exploration : dossier de travail du CLI. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Espace d'exploration et dossier de configuration Claude dédié à Wake. */
  readonly readWriteRoots: readonly string[];
  /** Binaire `claude`, prompts système, Git Bash. */
  readonly readOnlyRoots: readonly string[];
  readonly network: ClaudeNetworkGrant | null;
  readonly deadline: UtcTimestamp | null;
  /** Mode sans approbation (`--dangerously-skip-permissions`) : le runner le revérifie. */
  readonly unattended: boolean;
}

/**
 * Isolation offerte par un lanceur. Seule `appcontainer` avec autotest de refus réussi
 * autorise `--dangerously-skip-permissions` (AGENTS principe 6, ADR-005).
 */
export type ClaudeIsolation =
  | { readonly kind: "appcontainer"; readonly selfTestPassed: boolean; readonly detail: string }
  | {
      readonly kind: "host_job";
      readonly detail: string;
      /**
       * Le lanceur atteste le consentement distinct au mode non isolé (runner en
       * `host_unsandboxed`, dérivé de la policy, ADR-006).
       */
      readonly unsandboxedConsent?: boolean;
    };

export interface ClaudeLauncher {
  /** Isolation pour une session donnée, ou en général sans session. */
  isolation(sessionId?: SessionId): ClaudeIsolation;
  launch(spec: ClaudeLaunchSpec): ClaudeProcess;
}

export interface SandboxClaudeLauncherOptions {
  readonly sandbox: Sandbox;
  /**
   * Résultat du dernier autotest de refus sur ce poste pour le binaire courant du lanceur
   * (`runIsolationSelfTest().passed`, mémorisé par le daemon avec `sourceDigest`).
   */
  readonly selfTestPassed: () => boolean;
  readonly jobNameFor: (sessionId: SessionId) => string;
  /** Base de contrôle, policy, dossier de données : jamais accordés au conteneur. */
  readonly protectedPaths: readonly string[];
  readonly maxProcesses?: number;
  readonly memoryLimitMb?: number;
  readonly now?: () => number;
}

/** Lancement confiné : AppContainer sans capacité, Job Object, seule sortie = broker. */
export function sandboxClaudeLauncher(options: SandboxClaudeLauncherOptions): ClaudeLauncher {
  const now = options.now ?? Date.now;
  return {
    isolation(): ClaudeIsolation {
      const health = options.sandbox.health();
      return {
        kind: "appcontainer",
        selfTestPassed: health.operational && options.selfTestPassed(),
        detail: health.detail,
      };
    },
    launch(spec: ClaudeLaunchSpec): ClaudeProcess {
      if (spec.deadline === null)
        throw new Error("Unlimited duration is currently supported by the host launcher only");
      const remaining = Date.parse(spec.deadline) - now();
      return options.sandbox.launch({
        jobName: options.jobNameFor(spec.sessionId),
        executable: spec.executable,
        args: spec.args,
        cwd: spec.cwd,
        readWriteRoots: spec.readWriteRoots,
        readOnlyRoots: spec.readOnlyRoots,
        protectedPaths: options.protectedPaths,
        env: spec.env,
        maxWallMs: Math.max(1, Math.floor(remaining)),
        ...(options.maxProcesses === undefined ? {} : { maxProcesses: options.maxProcesses }),
        ...(options.memoryLimitMb === undefined ? {} : { memoryLimitMb: options.memoryLimitMb }),
        ...(spec.network?.broker === undefined ? {} : { broker: spec.network.broker }),
      });
    },
  };
}

/**
 * Lancement par le runner (`AdapterHost.spawnContained`), qui confine selon le mode de la
 * session : `sandbox` (AppContainer, autotest réussi), `host_unsandboxed` (NON ISOLÉ,
 * consentement de la policy, Job Object pour l'arrêt d'urgence) ou Job Object seul.
 */
export function hostClaudeLauncher(host: AdapterHost, maxProcesses?: number): ClaudeLauncher {
  return {
    isolation: (sessionId) => {
      const mode = sessionId === undefined ? "none" : host.isolation(sessionId);
      if (mode === "sandbox") {
        return { kind: "appcontainer", selfTestPassed: true, detail: "sandbox du runner" };
      }
      return {
        kind: "host_job",
        detail: `Job Object du runner (${mode})`,
        unsandboxedConsent: mode === "host_unsandboxed",
      };
    },
    launch: (spec) =>
      host.spawnContained(spec.sessionId, {
        executable: spec.executable,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
        unattended: spec.unattended,
        ...(spec.network?.broker === undefined ? {} : { broker: true }),
        ...(maxProcesses === undefined ? {} : { maxProcesses }),
      }),
  };
}

/** Superviseur d'arborescences du runner (`ProcessTreeSupervisor`), forme employée. */
export interface ClaudeSupervisorLike {
  spawn(profileId: ProfileId, sessionId: SessionId, command: ContainedCommand): SessionProcess;
}

/**
 * Lecture de jauge hors session : Job Object nommé d'après une session synthétique, jamais
 * de mode sans approbation (aucun outil, aucune requête au modèle).
 */
export function supervisorClaudeLauncher(
  supervisor: ClaudeSupervisorLike | (() => ClaudeSupervisorLike),
  profileId: ProfileId,
): ClaudeLauncher {
  const resolve = (): ClaudeSupervisorLike =>
    typeof supervisor === "function" ? supervisor() : supervisor;
  return {
    isolation: () => ({ kind: "host_job", detail: "lecture de jauge : Job Object, aucun tour" }),
    launch: (spec) =>
      resolve().spawn(profileId, spec.sessionId, {
        executable: spec.executable,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
      }),
  };
}
