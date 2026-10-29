/**
 * États du profil, résultats de session et transitions autorisées (SPEC §5.1).
 * La table est une donnée : le scheduler (S6) l'applique, il ne la redéfinit pas.
 */

import type { SessionId, UtcTimestamp } from "./common.js";

export const PROFILE_STATES = [
  "disabled",
  "ready",
  "running",
  "checkpointing",
  "hibernating",
  "paused",
  "blocked",
  "stopped",
] as const;

export type ProfileState = (typeof PROFILE_STATES)[number];

/** Résultat terminal d'une session, distinct de l'état du profil. */
export const SESSION_OUTCOMES = ["completed", "interrupted", "failed", "orphaned"] as const;

export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

/**
 * Condition supplémentaire attachée à une transition.
 * - `user_action` : action explicite de l'humain par le canal de confiance.
 * - `checks` : contrôles de compatibilité, budget et isolation revérifiés.
 * - `none` : la transition ne dépend que de l'événement qui la déclenche.
 */
export type TransitionGuard = "user_action" | "checks" | "none";

export interface TransitionRule {
  readonly to: ProfileState;
  readonly guards: readonly TransitionGuard[];
}

/** Transitions autorisées, reprises de la table de SPEC §5.1. Toute autre est interdite. */
export const PROFILE_TRANSITIONS: { readonly [S in ProfileState]: readonly TransitionRule[] } = {
  disabled: [{ to: "ready", guards: ["user_action", "checks"] }],
  ready: [
    { to: "running", guards: ["checks"] },
    { to: "hibernating", guards: ["none"] },
    { to: "paused", guards: ["user_action"] },
    { to: "blocked", guards: ["none"] },
    { to: "stopped", guards: ["none"] },
  ],
  running: [
    { to: "checkpointing", guards: ["none"] },
    { to: "blocked", guards: ["none"] },
    { to: "stopped", guards: ["none"] },
  ],
  checkpointing: [
    { to: "hibernating", guards: ["none"] },
    { to: "paused", guards: ["none"] },
    { to: "blocked", guards: ["none"] },
    { to: "stopped", guards: ["none"] },
  ],
  hibernating: [
    { to: "ready", guards: ["checks"] },
    { to: "paused", guards: ["user_action"] },
    { to: "stopped", guards: ["none"] },
  ],
  paused: [
    { to: "ready", guards: ["user_action", "checks"] },
    { to: "stopped", guards: ["none"] },
  ],
  blocked: [
    { to: "ready", guards: ["checks"] },
    { to: "stopped", guards: ["none"] },
  ],
  stopped: [{ to: "ready", guards: ["user_action", "checks"] }],
};

/** Changement d'état journalisé : chaque transition porte son motif (AGENTS §5). */
export interface ProfileTransition {
  readonly from: ProfileState;
  readonly to: ProfileState;
  readonly reason: string;
  readonly at: UtcTimestamp;
  readonly sessionId?: SessionId;
}

export function isProfileTransitionAllowed(from: ProfileState, to: ProfileState): boolean {
  return PROFILE_TRANSITIONS[from].some((rule) => rule.to === to);
}
