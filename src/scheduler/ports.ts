/**
 * Ports du scheduler. Le scheduler décide si un réveil est permis et réserve l'enveloppe ;
 * il ne lance aucun processus lui-même. Le runner (S7) implémente `SessionLauncher`,
 * l'adapter et la sandbox alimentent `LaunchEnvironment`. Aucun de ces ports ne doit
 * consommer d'appel modèle pour répondre (SPEC §5.1).
 */

import type {
  BudgetQuantity,
  PolicyRevisionId,
  ProfileId,
  ProviderQuotaSnapshot,
  ReservationId,
  SessionId,
  SessionOutcome,
  UtcTimestamp,
} from "../contracts/index.js";
import type { BillingFacts, LaunchFacts, PrioritySignal } from "../policy/index.js";
import type { SessionFailure } from "./backoff.js";

/**
 * Autorisation de lancer une session, émise après la transaction qui a réservé
 * l'enveloppe, créé la session et placé le profil en `running`.
 */
export interface LaunchTicket {
  readonly profileId: ProfileId;
  readonly sessionId: SessionId;
  readonly reservationId: ReservationId;
  readonly policyRevisionId: PolicyRevisionId;
  /** Bornes réservées ; le runner ne peut pas les dépasser. */
  readonly maxima: readonly BudgetQuantity[];
  readonly launchedAt: UtcTimestamp;
  /** Échéance murale ; le runner mesure la durée sur son horloge monotone. */
  readonly deadline: UtcTimestamp;
  readonly maxDurationMs: number;
}

/** Fin de session rapportée au scheduler, pour le backoff et le prochain réveil. */
export interface SessionReport {
  readonly sessionId: SessionId;
  readonly outcome: SessionOutcome;
  /** Absent pour une fin normale ou une interruption voulue (pause, priorité humaine). */
  readonly failure?: SessionFailure;
}

/**
 * Lancement effectif, implémenté par le runner (S7).
 *
 * Contrat attendu de `launch` :
 * - démarrer la session du ticket, puis résoudre à sa fin ;
 * - gérer `running → checkpointing` ;
 * - laisser le profil en `checkpointing` (le scheduler choisit alors `hibernating` ou
 *   `blocked`), ou bien en `paused`, `blocked` ou `stopped` s'il y a été conduit ;
 * - clore la session et rapprocher ou marquer incertaine la réservation.
 *
 * Un rejet est traité comme un état incertain : le profil est bloqué si nécessaire et
 * la session reste ouverte pour la réconciliation.
 */
export interface SessionLauncher {
  launch(ticket: LaunchTicket): Promise<SessionReport>;
  /**
   * Après redémarrage : traiter les sessions ouvertes sans processus confirmé comme
   * orphelines, conserver leurs réservations incertaines et ramener le profil dans un
   * état stable. Le scheduler ne lance rien tant qu'une session reste ouverte.
   */
  reconcileOrphans(profileId: ProfileId): Promise<void>;
}

/**
 * Faits de lancement fournis par l'adapter, la sandbox et la facturation. Une méthode qui
 * échoue, dépasse le délai ou renvoie `undefined` laisse la condition inconnue : refus.
 */
export interface LaunchEnvironment {
  adapter(): Promise<LaunchFacts["adapter"]>;
  sandboxOperational(): Promise<boolean | undefined>;
  billing(): Promise<BillingFacts | undefined>;
  /** Lectures officielles de quota, pour la voie abonnement seulement. */
  quotaSnapshots?(): Promise<readonly ProviderQuotaSnapshot[] | undefined>;
}

/**
 * Signal de priorité humaine (SPEC §4 « Priorité humaine »). Aucune capture du contenu
 * des applications : seulement un état favorable ou non et l'instant de l'observation.
 * Un signal absent, en erreur ou plus ancien que `maxSignalAgeMs` vaut condition inconnue.
 */
export interface UserPrioritySignal {
  read(): Promise<PrioritySignal | undefined>;
}
