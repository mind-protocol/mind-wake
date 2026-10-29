/**
 * Contrôles humains persistés (AGENTS §3.1 et §5) : pause, reprise, arrêt d'urgence.
 * Ces fonctions n'écrivent que l'état de contrôle ; elles sont partagées par le runner
 * en processus et par la CLI, qui agit depuis un autre processus. Le runner observe
 * l'état persisté et termine la session ; la CLI `stop` termine aussi l'arborescence
 * par le nom de son job, sans dépendre du runner.
 *
 * Aucune de ces fonctions n'active l'exploration : la reprise ne fait que lever une
 * pause, après revérification de la policy consentie, et jamais un arrêt d'urgence.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  ProfileId,
  ProfileRecord,
  ProfileState,
  UnitOfWork,
  UtcTimestamp,
} from "../contracts/index.js";
import { isProfileTransitionAllowed } from "../contracts/index.js";
import { JournalWriter } from "../journal/index.js";
import { decideActivation } from "../policy/index.js";

export const PAUSE_REASON = "pause demandée par l'utilisateur";
export const RESUME_REASON = "reprise demandée par l'utilisateur";
export const STOP_REASON = "arrêt d'urgence demandé par l'utilisateur";

export interface ControlContext {
  readonly uow: UnitOfWork;
  readonly profileId: ProfileId;
  readonly now: () => Date;
}

function utc(date: Date): UtcTimestamp {
  return date.toISOString() as UtcTimestamp;
}

function recordStateChange(
  journal: JournalWriter,
  profile: ProfileRecord,
  to: ProfileState,
  reason: string,
  at: UtcTimestamp,
  extra: Record<string, string> = {},
): void {
  journal.record({
    type: "profile_state_changed",
    at,
    profileId: profile.id,
    reason,
    metadata: { from: profile.state, to, ...extra },
  });
}

// ── Pause ─────────────────────────────────────────────────────────────────────────

export type PauseStatus =
  /** Aucune session : profil en pause, plus aucun réveil. */
  | "paused"
  /** Session active : plus aucun réveil, checkpoint borné demandé puis arrêt. */
  | "pause_requested"
  | "already_paused"
  | "refused";

export interface PauseResult {
  readonly status: PauseStatus;
  readonly state: ProfileState | null;
  readonly detail: string;
}

/**
 * Pause : interdit les prochains réveils. Une session en cours passe en
 * `checkpointing` ; le runner demande alors un checkpoint dans l'enveloppe restante,
 * termine la session et place le profil en `paused`.
 */
export function requestPause(ctx: ControlContext, reason = PAUSE_REASON): PauseResult {
  return ctx.uow.transaction((tx) => {
    const profile = tx.profiles.get(ctx.profileId);
    if (profile === null) return { status: "refused", state: null, detail: "profil inconnu" };
    const at = utc(ctx.now());
    const journal = new JournalWriter(tx.journal);
    if (profile.emergencyStopLocked || profile.state === "stopped") {
      return {
        status: "refused",
        state: profile.state,
        detail: "profil déjà arrêté (arrêt d'urgence)",
      };
    }
    const openSession = tx.sessions.listOpen(profile.id)[0];
    const announce = (): void => {
      tx.profiles.setNextWake(profile.id, null);
      journal.record({
        type: "pause_requested",
        at,
        profileId: profile.id,
        ...(openSession === undefined ? {} : { sessionId: openSession.id }),
        reason,
        metadata: { from: profile.state },
      });
    };
    switch (profile.state) {
      case "paused":
        tx.profiles.setNextWake(profile.id, null);
        return { status: "already_paused", state: "paused", detail: "profil déjà en pause" };
      case "ready":
      case "hibernating":
        announce();
        tx.profiles.transition(profile.id, { from: profile.state, to: "paused", reason, at });
        recordStateChange(journal, profile, "paused", reason, at);
        return { status: "paused", state: "paused", detail: "plus aucun réveil" };
      case "running":
        announce();
        tx.profiles.transition(profile.id, { from: "running", to: "checkpointing", reason, at });
        recordStateChange(journal, profile, "checkpointing", reason, at);
        return {
          status: "pause_requested",
          state: "checkpointing",
          detail: "session en cours : checkpoint borné demandé, puis arrêt et pause",
        };
      case "checkpointing":
        announce();
        return {
          status: "pause_requested",
          state: "checkpointing",
          detail: "checkpoint en cours : pause à la fin de la session",
        };
      case "disabled":
        return {
          status: "refused",
          state: "disabled",
          detail: "profil désactivé : rien à suspendre",
        };
      case "blocked":
        return {
          status: "refused",
          state: "blocked",
          detail: "profil bloqué : la pause n'est pas une transition permise, utiliser stop",
        };
    }
  });
}

/** `true` si une pause a été demandée après l'événement de séquence `afterSequence`. */
export function pauseRequestedSince(
  uow: UnitOfWork,
  profileId: ProfileId,
  afterSequence: number,
): boolean {
  return uow.journal
    .list(profileId, { afterSequence })
    .some((event) => event.type === "pause_requested");
}

// ── Reprise ───────────────────────────────────────────────────────────────────────

export type ResumeStatus = "resumed" | "already_ready" | "refused";

export interface ResumeResult {
  readonly status: ResumeStatus;
  readonly state: ProfileState | null;
  /** Motif stable du refus. */
  readonly reason: string;
  readonly detail: string;
}

/**
 * Reprise : `paused → ready`, après revérification de la policy consentie. Refusée
 * après un arrêt d'urgence verrouillé, qui exige une réactivation explicite distincte.
 */
export function requestResume(ctx: ControlContext): ResumeResult {
  return ctx.uow.transaction((tx) => {
    const profile = tx.profiles.get(ctx.profileId);
    if (profile === null) {
      return {
        status: "refused",
        state: null,
        reason: "unknown_profile",
        detail: "profil inconnu",
      };
    }
    if (profile.emergencyStopLocked) {
      return {
        status: "refused",
        state: profile.state,
        reason: "emergency_stop_locked",
        detail: "arrêt d'urgence verrouillé : la reprise exige une réactivation explicite",
      };
    }
    if (profile.state === "ready") {
      return {
        status: "already_ready",
        state: "ready",
        reason: "already_ready",
        detail: "profil déjà prêt",
      };
    }
    if (profile.state !== "paused") {
      return {
        status: "refused",
        state: profile.state,
        reason: "not_paused",
        detail: `seul un profil en pause peut reprendre (état ${profile.state})`,
      };
    }
    if (tx.sessions.listOpen(profile.id).length > 0) {
      return {
        status: "refused",
        state: profile.state,
        reason: "session_still_open",
        detail: "une session est encore ouverte : attendre sa fin ou sa réconciliation",
      };
    }
    const decision = decideActivation(tx.policies, profile.id);
    if (decision.verdict === "deny") {
      return {
        status: "refused",
        state: profile.state,
        reason: decision.reason,
        detail: `policy : ${decision.detail}`,
      };
    }
    const at = utc(ctx.now());
    tx.profiles.transition(profile.id, { from: "paused", to: "ready", reason: RESUME_REASON, at });
    recordStateChange(new JournalWriter(tx.journal), profile, "ready", RESUME_REASON, at, {
      policyRevisionId: decision.revisionId,
    });
    return {
      status: "resumed",
      state: "ready",
      reason: "resumed",
      detail: "réveils de nouveau permis",
    };
  });
}

// ── Réactivation après arrêt d'urgence ────────────────────────────────────────────

export type ReactivateStatus = "reactivated" | "not_stopped" | "refused";

export interface ReactivateResult {
  readonly status: ReactivateStatus;
  readonly state: ProfileState | null;
  readonly reason: string;
  readonly detail: string;
}

const REACTIVATE_REASON = "réactivation explicite par l'humain après arrêt d'urgence";

/**
 * Action explicite dédiée de l'humain : `stopped → ready` (gardes `user_action` et
 * `checks`), verrou levé dans la même transaction, après revérification de la policy
 * consentie. Refusée tant qu'une session reste ouverte. Le marqueur de secours est
 * retiré ensuite par l'appelant.
 */
export function requestReactivate(ctx: ControlContext): ReactivateResult {
  return ctx.uow.transaction((tx) => {
    const profile = tx.profiles.get(ctx.profileId);
    if (profile === null) {
      return {
        status: "refused",
        state: null,
        reason: "unknown_profile",
        detail: "profil inconnu",
      };
    }
    if (profile.state !== "stopped" && !profile.emergencyStopLocked) {
      return {
        status: "not_stopped",
        state: profile.state,
        reason: "not_stopped",
        detail: `aucun arrêt d'urgence à lever (état ${profile.state})`,
      };
    }
    if (tx.sessions.listOpen(profile.id).length > 0) {
      return {
        status: "refused",
        state: profile.state,
        reason: "session_still_open",
        detail: "une session est encore ouverte : attendre sa fin ou sa réconciliation",
      };
    }
    const decision = decideActivation(tx.policies, profile.id);
    if (decision.verdict === "deny") {
      return {
        status: "refused",
        state: profile.state,
        reason: decision.reason,
        detail: `policy : ${decision.detail}`,
      };
    }
    const at = utc(ctx.now());
    tx.profiles.setEmergencyStopLocked(profile.id, false, at);
    if (profile.state === "stopped") {
      tx.profiles.transition(profile.id, {
        from: "stopped",
        to: "ready",
        reason: REACTIVATE_REASON,
        at,
      });
    }
    recordStateChange(new JournalWriter(tx.journal), profile, "ready", REACTIVATE_REASON, at, {
      policyRevisionId: decision.revisionId,
    });
    return {
      status: "reactivated",
      state: "ready",
      reason: "reactivated",
      detail: "arrêt d'urgence levé : réveils de nouveau permis",
    };
  });
}

// ── Arrêt d'urgence ───────────────────────────────────────────────────────────────

/**
 * Marqueur de secours, hors SQLite : écrit seulement si l'arrêt d'urgence n'a pas pu
 * être persisté. Sa présence impose au démarrage une récupération conservatrice.
 */
export class StopFlag {
  readonly path: string;

  constructor(dataDir: string) {
    this.path = path.join(dataDir, "emergency-stop.flag");
  }

  write(reason: string, at: UtcTimestamp): boolean {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.writeFileSync(this.path, `${JSON.stringify({ reason, at })}\n`);
      return true;
    } catch {
      return false;
    }
  }

  exists(): boolean {
    return fs.existsSync(this.path);
  }

  clear(): void {
    fs.rmSync(this.path, { force: true });
  }
}

export interface EmergencyStopPersistence {
  readonly persisted: boolean;
  readonly previousState: ProfileState | null;
  readonly error?: string;
  /** Marqueur de secours écrit faute de persistance. */
  readonly flagWritten: boolean;
}

/**
 * Première étape du kill switch : persiste `stopped` avec le verrou d'arrêt d'urgence,
 * supprime le prochain réveil et journalise. Ne lève jamais : en cas d'échec, le
 * marqueur de secours est écrit et l'appelant termine quand même l'arborescence.
 */
export function persistEmergencyStop(
  ctx: ControlContext,
  flag: StopFlag,
  reason = STOP_REASON,
): EmergencyStopPersistence {
  const at = utc(ctx.now());
  try {
    const previousState = ctx.uow.transaction((tx) => {
      const profile = tx.profiles.get(ctx.profileId);
      if (profile === null) throw new Error("profil inconnu");
      const journal = new JournalWriter(tx.journal);
      if (profile.state !== "stopped" && isProfileTransitionAllowed(profile.state, "stopped")) {
        tx.profiles.transition(profile.id, { from: profile.state, to: "stopped", reason, at });
        recordStateChange(journal, profile, "stopped", reason, at);
      }
      tx.profiles.setEmergencyStopLocked(profile.id, true, at);
      tx.profiles.setNextWake(profile.id, null);
      journal.record({
        type: "kill_switch_triggered",
        at,
        profileId: profile.id,
        reason,
        metadata: { from: profile.state, locked: true },
      });
      return profile.state;
    });
    return { persisted: true, previousState, flagWritten: false };
  } catch (error) {
    return {
      persisted: false,
      previousState: null,
      error: error instanceof Error ? error.message : String(error),
      flagWritten: flag.write(reason, at),
    };
  }
}
