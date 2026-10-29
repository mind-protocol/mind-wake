/**
 * Ports de lancement de l'adapter Gemini : où tourne le processus (sandbox AppContainer
 * ou simple Job Object sur l'hôte), par quel canal il joint le fournisseur, et la règle
 * qui décide si un lancement est permis (ADR-005).
 */

import type { DurationMs, SessionId } from "../../contracts/index.js";
import type { AdapterHost } from "../../runner/host.js";
import type { ContainedExit, TreeTermination } from "../../runner/process-tree.js";
import type { BrokerEndpoint } from "../../sandbox/broker.js";
import type { IsolationSelfTestReport } from "../../sandbox/self-test.js";
import type { SandboxLaunchSpec } from "../../sandbox/sandbox.js";
import type { ApprovalMode } from "./config.js";

/** Forme commune à `ContainedProcess` (runner) et `SandboxedProcess` (sandbox). */
export interface GeminiProcess {
  started(): Promise<number>;
  readLine(): Promise<string | null>;
  readonly hasExited: boolean;
  readonly exited: Promise<ContainedExit>;
  terminateTree(timeoutMs: DurationMs): Promise<TreeTermination>;
}

export interface GeminiLaunchSpec {
  readonly sessionId: SessionId;
  readonly executable: string;
  readonly args: readonly string[];
  /** Espace d'exploration : dossier de travail de la CLI. */
  readonly workspace: string;
  /** `GEMINI_CLI_HOME` propre à Wake. */
  readonly home: string;
  readonly env: Readonly<Record<string, string>>;
  readonly broker: BrokerEndpoint | null;
  readonly maxProcesses?: number;
  readonly maxWallMs?: number;
}

export interface IsolationVerdict {
  readonly verified: boolean;
  readonly detail: string;
}

export interface GeminiLaunchPort {
  /** `sandbox` : AppContainer + Job Object ; `host` : Job Object seul, aucune isolation. */
  readonly kind: "sandbox" | "host";
  /** Sandbox opérationnelle et autotest de refus réussi sur ce poste. */
  isolationVerified(): Promise<IsolationVerdict>;
  launch(spec: GeminiLaunchSpec): GeminiProcess;
}

/**
 * Canal fournisseur, fourni par le relais (non implémenté ici). Le relais détient seul le
 * credential ; la bail ne transmet que le point d'accès broker et des variables sans nom
 * de secret (proxy, point d'entrée), revérifiées par la sandbox.
 */
export interface ProviderTransportLease {
  readonly broker: BrokerEndpoint | null;
  readonly env: Readonly<Record<string, string>>;
  close(): Promise<void>;
}

export interface ProviderTransportPort {
  open(sessionId: SessionId): Promise<ProviderTransportLease>;
}

/** Lancement dans la sandbox de `src/sandbox/`. */
export function sandboxLaunchPort(options: {
  readonly sandbox: {
    health(): { readonly operational: boolean; readonly detail: string };
    launch(spec: SandboxLaunchSpec): GeminiProcess;
  };
  readonly jobName: (sessionId: SessionId) => string;
  /** Racines en lecture et exécution : copie de Node, paquet de la CLI. */
  readonly runtimeRoots: readonly string[];
  /** Base de contrôle, policy, dossier de données : jamais accordés. */
  readonly protectedPaths: readonly string[];
  /** Dernier rapport d'autotest pour le binaire actuel, `null` s'il n'a pas tourné. */
  readonly selfTest: () => IsolationSelfTestReport | null;
  readonly memoryLimitMb?: number;
}): GeminiLaunchPort {
  return {
    kind: "sandbox",
    isolationVerified() {
      const health = options.sandbox.health();
      if (!health.operational) {
        return Promise.resolve({ verified: false, detail: `sandbox : ${health.detail}` });
      }
      const report = options.selfTest();
      if (report === null) {
        return Promise.resolve({ verified: false, detail: "autotest de refus jamais exécuté" });
      }
      if (!report.passed) {
        return Promise.resolve({
          verified: false,
          detail: `autotest de refus en échec${report.error === undefined ? "" : ` : ${report.error}`}`,
        });
      }
      return Promise.resolve({ verified: true, detail: health.detail });
    },
    launch(spec) {
      return options.sandbox.launch({
        jobName: options.jobName(spec.sessionId),
        executable: spec.executable,
        args: spec.args,
        cwd: spec.workspace,
        readWriteRoots: [spec.workspace, spec.home],
        readOnlyRoots: options.runtimeRoots,
        protectedPaths: options.protectedPaths,
        env: spec.env,
        ...(spec.maxProcesses === undefined ? {} : { maxProcesses: spec.maxProcesses }),
        ...(spec.maxWallMs === undefined ? {} : { maxWallMs: spec.maxWallMs }),
        ...(options.memoryLimitMb === undefined ? {} : { memoryLimitMb: options.memoryLimitMb }),
        ...(spec.broker === null ? {} : { broker: spec.broker }),
      });
    },
  };
}

/**
 * Lancement sur l'hôte dans l'arborescence contenue du runner : terminaison garantie,
 * mais aucune isolation de fichiers ni de réseau. Réservé au lancement manuel, sans mode
 * sans approbation.
 */
export function hostLaunchPort(host: AdapterHost): GeminiLaunchPort {
  return {
    kind: "host",
    isolationVerified() {
      return Promise.resolve({
        verified: false,
        detail: "lancement hôte : Job Object seul, aucune isolation de fichiers ni de réseau",
      });
    },
    launch(spec) {
      return host.spawnContained(spec.sessionId, {
        executable: spec.executable,
        args: spec.args,
        env: spec.env,
        cwd: spec.workspace,
        ...(spec.maxProcesses === undefined ? {} : { maxProcesses: spec.maxProcesses }),
      });
    },
  };
}

/** `autonomous` : réveil planifié ; `manual` : lancement explicite par l'humain. */
export type LaunchMode = "autonomous" | "manual";

export type LaunchRefusal =
  "approval_outside_sandbox" | "isolation_unverified" | "no_quota_reading";

export type LaunchDecision =
  | { readonly allowed: true; readonly approvalMode: ApprovalMode }
  | { readonly allowed: false; readonly refusal: LaunchRefusal; readonly reason: string };

/**
 * Règle d'ADR-005 : le mode sans approbation exige la sandbox avec autotest réussi ;
 * l'autonomie exige en plus une lecture officielle de la jauge de quota.
 */
export function decideLaunch(input: {
  readonly mode: LaunchMode;
  readonly approvalMode: ApprovalMode;
  readonly portKind: GeminiLaunchPort["kind"];
  readonly isolation: IsolationVerdict;
  readonly providerQuotaReading: "official" | "none";
}): LaunchDecision {
  const isolated = input.portKind === "sandbox" && input.isolation.verified;
  if (input.approvalMode === "yolo" && !isolated) {
    return {
      allowed: false,
      refusal: "approval_outside_sandbox",
      reason: `mode sans approbation refusé hors sandbox vérifiée (${input.isolation.detail})`,
    };
  }
  if (input.mode === "autonomous") {
    if (!isolated) {
      return {
        allowed: false,
        refusal: "isolation_unverified",
        reason: `mode autonome refusé sans isolation vérifiée (${input.isolation.detail})`,
      };
    }
    if (input.providerQuotaReading !== "official") {
      return {
        allowed: false,
        refusal: "no_quota_reading",
        reason: "mode autonome refusé : aucune lecture officielle du quota Gemini (ADR-005)",
      };
    }
  }
  return { allowed: true, approvalMode: input.approvalMode };
}

export class GeminiLaunchRefused extends Error {
  readonly refusal: LaunchRefusal;
  constructor(refusal: LaunchRefusal, reason: string) {
    super(reason);
    this.name = "GeminiLaunchRefused";
    this.refusal = refusal;
  }
}
