/**
 * Ports de lancement de l'adapter Gemini : où tourne le processus (sandbox AppContainer
 * ou simple Job Object sur l'hôte), par quel canal il joint le fournisseur, et la règle
 * qui décide si un lancement est permis (ADR-005, ADR-006).
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
 * Canal fournisseur du relais, pour la seule sandbox. Le relais est suspendu (ADR-006) :
 * sur l'hôte, la CLI joint le fournisseur par le réseau de l'hôte et ce port est ignoré.
 * La bail ne transmet que le point d'accès broker et des variables sans nom de secret ;
 * avec un compte Google, le relais ne détient ni ne réinjecte le jeton OAuth de la CLI.
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
 * Variables de l'hôte transmises en mode non isolé (ADR-006) : de quoi trouver le profil,
 * les dossiers temporaires et les outils du système. Aucun nom de secret.
 */
export const HOST_PASSTHROUGH_ENV: readonly string[] = [
  "PATH",
  "Path",
  "PATHEXT",
  "ComSpec",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
];

/**
 * Lancement sur l'hôte dans l'arborescence contenue du runner : l'arrêt d'urgence termine
 * toute la descendance (Job Object), mais aucune isolation de fichiers ni de réseau.
 * Le réseau de l'hôte sert de transport (ADR-006) : aucun broker.
 */
export function hostLaunchPort(
  host: AdapterHost,
  source: Readonly<Record<string, string | undefined>> = process.env,
): GeminiLaunchPort {
  return {
    kind: "host",
    isolationVerified() {
      return Promise.resolve({
        verified: false,
        detail: "non isolé : Job Object seul, aucune isolation de fichiers ni de réseau",
      });
    },
    launch(spec) {
      const env: Record<string, string> = {};
      for (const key of HOST_PASSTHROUGH_ENV) {
        const value = source[key];
        if (value !== undefined) env[key] = value;
      }
      return host.spawnContained(spec.sessionId, {
        executable: spec.executable,
        args: spec.args,
        env: { ...env, ...spec.env },
        cwd: spec.workspace,
        ...(spec.maxProcesses === undefined ? {} : { maxProcesses: spec.maxProcesses }),
      });
    },
  };
}

/** `autonomous` : réveil planifié ; `manual` : lancement explicite par l'humain. */
export type LaunchMode = "autonomous" | "manual";

export type LaunchRefusal =
  | "approval_outside_sandbox"
  | "unsandboxed_consent_missing"
  | "isolation_unverified"
  | "no_quota_reading";

/** `sandbox` : AppContainer vérifié ; `unsandboxed` : poste hôte, non isolé (ADR-006). */
export type LaunchIsolation = "sandbox" | "unsandboxed";

export type LaunchDecision =
  | {
      readonly allowed: true;
      readonly approvalMode: ApprovalMode;
      readonly isolation: LaunchIsolation;
    }
  | { readonly allowed: false; readonly refusal: LaunchRefusal; readonly reason: string };

/**
 * Règles d'ADR-005 et ADR-006. Le mode sans approbation et l'autonomie exigent soit la
 * sandbox avec autotest réussi, soit, sur l'hôte, le consentement distinct au mode non
 * isolé consigné dans la policy. L'autonomie exige en plus une lecture officielle de la
 * jauge de quota (garde maintenue par ADR-006).
 */
export function decideLaunch(input: {
  readonly mode: LaunchMode;
  readonly approvalMode: ApprovalMode;
  readonly portKind: GeminiLaunchPort["kind"];
  readonly isolation: IsolationVerdict;
  /** `hostUnsandboxedAcknowledged` de la policy (ADR-006). */
  readonly hostUnsandboxedConsent: boolean;
  readonly providerQuotaReading: "official" | "none";
}): LaunchDecision {
  const sandboxed = input.portKind === "sandbox" && input.isolation.verified;
  const unsandboxedAllowed = input.portKind === "host" && input.hostUnsandboxedConsent;
  const unattended = input.approvalMode === "yolo" || input.mode === "autonomous";
  if (unattended && !sandboxed && !unsandboxedAllowed) {
    const what = input.mode === "autonomous" ? "mode autonome" : "mode sans approbation";
    return input.portKind === "host"
      ? {
          allowed: false,
          refusal: "unsandboxed_consent_missing",
          reason: `${what} refusé sur l'hôte : consentement distinct au mode non isolé absent de la policy (ADR-006)`,
        }
      : {
          allowed: false,
          refusal:
            input.approvalMode === "yolo" ? "approval_outside_sandbox" : "isolation_unverified",
          reason: `${what} refusé sans isolation vérifiée (${input.isolation.detail})`,
        };
  }
  if (input.mode === "autonomous" && input.providerQuotaReading !== "official") {
    return {
      allowed: false,
      refusal: "no_quota_reading",
      reason: "mode autonome refusé : aucune lecture officielle du quota Gemini (ADR-005, ADR-006)",
    };
  }
  return {
    allowed: true,
    approvalMode: input.approvalMode,
    isolation: sandboxed ? "sandbox" : "unsandboxed",
  };
}

export class GeminiLaunchRefused extends Error {
  readonly refusal: LaunchRefusal;
  constructor(refusal: LaunchRefusal, reason: string) {
    super(reason);
    this.name = "GeminiLaunchRefused";
    this.refusal = refusal;
  }
}
