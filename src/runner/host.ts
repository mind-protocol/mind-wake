/**
 * Services que le runner offre à un adapter, hors du contrat `RuntimeAdapter` (qui ne
 * change pas) : lancer un processus uniquement dans l'arborescence contenue de la
 * session (confinée par la sandbox pour un adapter réel), et soumettre chaque action
 * contrôlée au policy engine avant de l'exécuter.
 *
 * Candidats au contrat partagé quand les adapters réels (ADR-005) les utiliseront aussi.
 */

import type {
  ProviderQuotaSnapshot,
  RuntimeAdapter,
  SessionHandle,
  SessionId,
} from "../contracts/index.js";
import type { ContainedCommand, SessionProcess } from "./process-tree.js";

export interface AuthorizationVerdict {
  readonly allowed: boolean;
  /** Motif stable du policy engine (`DenyReason` ou motif d'accord). */
  readonly reason: string;
  /** La session doit s'interrompre : plus aucune action ne sera accordée. */
  readonly interruptSession: boolean;
}

/**
 * Confinement d'une session : `sandbox` (AppContainer + Job Object, autotest de refus
 * réussi), `job_only` (Job Object seul : adapter simulé), `none` (aucune session active).
 */
export type SessionIsolationMode = "sandbox" | "job_only" | "none";

export interface AdapterHost {
  /**
   * Seul moyen de lancer un processus de session : le runner peut toujours le terminer.
   * Pour un adapter réel, le processus est lancé dans la sandbox. Lève `RunnerError`
   * (`unattended_outside_sandbox`) si `command.unattended` est demandé hors sandbox.
   */
  spawnContained(sessionId: SessionId, command: ContainedCommand): SessionProcess;
  /** Décision `decideAction` revérifiée au moment de l'action, journalisée par le runner. */
  authorize(sessionId: SessionId, action: unknown): AuthorizationVerdict;
  /** Confinement de la session : un mode sans approbation n'est permis qu'en `sandbox`. */
  isolation(sessionId: SessionId): SessionIsolationMode;
}

/** Adapter capable de demander un checkpoint borné à l'agent (pause, interruption). */
export interface CheckpointRequestable {
  requestCheckpoint(handle: SessionHandle): Promise<void>;
}

export function canRequestCheckpoint(
  adapter: RuntimeAdapter,
): adapter is RuntimeAdapter & CheckpointRequestable {
  return typeof (adapter as Partial<CheckpointRequestable>).requestCheckpoint === "function";
}

/**
 * Adapter qui lit la jauge de quota d'abonnement par la méthode officielle du runtime
 * (ADR-004, ADR-005). Une lecture non officielle n'est jamais `measured` ; sans lecture,
 * un tableau vide. Le scheduler la lit avant le lancement, le runner pendant la session.
 */
export interface QuotaReadable {
  readQuota(): Promise<readonly ProviderQuotaSnapshot[]>;
}

export function canReadQuota(adapter: RuntimeAdapter): adapter is RuntimeAdapter & QuotaReadable {
  return typeof (adapter as Partial<QuotaReadable>).readQuota === "function";
}
