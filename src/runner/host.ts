/**
 * Services que le runner offre à un adapter, hors du contrat `RuntimeAdapter` (qui ne
 * change pas) : lancer un processus uniquement dans l'arborescence contenue de la
 * session, et soumettre chaque action contrôlée au policy engine avant de l'exécuter.
 *
 * Candidats au contrat partagé quand l'adapter Codex (S11) les utilisera aussi.
 */

import type { RuntimeAdapter, SessionHandle, SessionId } from "../contracts/index.js";
import type { ContainedCommand, ContainedProcess } from "./process-tree.js";

export interface AuthorizationVerdict {
  readonly allowed: boolean;
  /** Motif stable du policy engine (`DenyReason` ou motif d'accord). */
  readonly reason: string;
  /** La session doit s'interrompre : plus aucune action ne sera accordée. */
  readonly interruptSession: boolean;
}

export interface AdapterHost {
  /** Seul moyen de lancer un processus de session : le runner peut toujours le terminer. */
  spawnContained(sessionId: SessionId, command: ContainedCommand): ContainedProcess;
  /** Décision `decideAction` revérifiée au moment de l'action, journalisée par le runner. */
  authorize(sessionId: SessionId, action: unknown): AuthorizationVerdict;
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
