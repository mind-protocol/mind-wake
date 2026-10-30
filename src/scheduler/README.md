# src/scheduler

Session S6 (SPEC §5, AGENTS §5 « Cycle de vie et continuité »). Le scheduler décide si un réveil est permis, sans appel modèle, puis réserve l'enveloppe et confie le lancement au runner. Il ne lance aucun processus lui-même.

## Modules

- `scheduler.ts` : `Scheduler.tick()` (un tour), `run(signal)` (boucle du daemon), `recover()` (au démarrage).
- `ports.ts` : ports à implémenter ailleurs.
  - `SessionLauncher` : runner, S7.
  - `LaunchEnvironment` : adapter, sandbox, facturation.
  - `UserPrioritySignal` : signal de priorité humaine.
- `windows.ts` : fenêtres hebdomadaires dans le fuseau IANA, prochaine ouverture en UTC.
- `backoff.ts` : backoff borné, délai officiel du fournisseur, plafond de tentatives.
- `instance-lock.ts` : verrou d'instance par profil.
- `state.ts` : état persistant du scheduler (migration 2 `scheduler_state`).
- `lifecycle.ts` : `transitionProfile`, transition et événement `profile_state_changed` dans une transaction. Réutilisable par S7.
- `priority.ts` : signal manuel (tests), signal d'inactivité, source Windows `GetLastInputInfo`.
- `clock.ts` : horloge murale et monotone injectables, `FakeClock`.

## Décision de réveil

Un tour n'évalue qu'en `ready` ou `hibernating`. Il ne fait rien dans les autres états : `disabled`, `paused`, `blocked`, `stopped`, `running`, `checkpointing`.

En `hibernating`, rien ne se passe avant l'échéance `profiles.next_wake_at` (UTC). À l'échéance, toutes les conditions de SPEC §5.1 sont revérifiées par `decideLaunch` (S4) :

- les faits de l'adapter, de la sandbox, de la facturation et du signal sont lus avec un délai maximal (`factTimeoutMs`). Absents, en erreur ou hors délai, ils restent inconnus, donc refusés ;
- la fenêtre est calculée ici ;
- le backoff vient de `scheduler_state` ;
- les sessions ouvertes viennent de `sessions` ;
- le budget vient du ledger, sur toutes les périodes que la session peut traverser (`ensurePeriodsCovering`), avec les plafonds de la policy consentie.

Si tout est accordé, une seule transaction SQLite :

1. réserve tokens, sessions et monnaie si une API payante est facturée ;
2. crée la session ;
3. journalise `budget_reserved` ;
4. applique `hibernating → ready` si besoin, puis `ready → running` ;
5. efface la prochaine échéance.

Le ticket part ensuite vers `SessionLauncher.launch`.

En cas de refus :

| État                     | Motif                                                                                              | Effet                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `ready`                  | attente temporaire : fenêtre, priorité, backoff, budget épuisé, condition inconnue, session active | `hibernating`                                                   |
| `ready`                  | intervention requise : consentement, révocation, borne, adapter, sandbox, budget inconnu           | `blocked`                                                       |
| `ready` ou `hibernating` | arrêt verrouillé                                                                                   | `stopped`                                                       |
| `hibernating`            | autre motif                                                                                        | on y reste : `hibernating → blocked` n'existe pas dans la table |

Le refus est journalisé (`action_denied`) seulement quand son motif change. Le scheduler reste calme.

La prochaine échéance est :

- la prochaine ouverture de fenêtre ;
- ou la fin du backoff ou de l'intervalle minimal, puis la fenêtre ;
- ou la fin de période pour un budget épuisé ;
- sinon `recheckIntervalMs`.

## Réveils explicites et Always-on

Le daemon fournit humanWakePending et alwaysOn. Une demande explicite peut avancer l’échéance et porte humanRequested vers la policy : fenêtres, priorité d’inactivité et attente de pilotage ne la retardent pas. Quota, backoff, permissions, pause, arrêt et unicité de session restent vérifiés. Always-on attend la fin du travail en cours puis relance sans intervalle planifié ; On revient à la planification. La garde abonnement remplace les réservations de tokens locales décrites pour les autres voies.

## Temps

- Les échéances sont persistées en UTC. Les fenêtres sont évaluées en heure locale du fuseau de la policy, au changement d'heure aussi :
  - une fenêtre qui commence dans l'heure absente s'ouvre au premier instant existant ;
  - une fenêtre entièrement absente est sautée ;
  - une heure répétée est ouverte deux fois.
- Le backoff et l'intervalle minimal sont aussi gardés sur l'horloge monotone du processus. Un saut de l'heure murale vers l'avant ne les abrège pas. Revers : si l'horloge monotone ne compte pas la veille, l'attente peut se prolonger d'autant après une veille, jamais se raccourcir.
- `run` dort au plus `recheckIntervalMs` entre deux tours. Après une veille du poste, il fait une seule évaluation sur l'heure courante : aucun réveil manqué n'est rejoué.

## Backoff et fin de session

Contrat de `SessionLauncher.launch` : résoudre à la fin de la session et laisser le profil en `checkpointing`, sauf s'il a été mis en `paused`, `blocked` ou `stopped`. Le scheduler choisit alors la sortie :

- succès ou interruption voulue : compteur remis à zéro, `hibernating` ;
- limitation : attente du délai officiel s'il est fourni, sinon backoff exponentiel plafonné (`DEFAULT_BACKOFF` : 1 min → 1 h) ;
- erreur transitoire : backoff exponentiel plafonné ;
- `failed` ou `orphaned` sans détail : traité comme une erreur transitoire ;
- au-delà de `maxConsecutiveFailures` : `blocked` ;
- `auth_failed`, `incompatible`, `fatal` : `blocked` immédiatement ;
- lanceur en échec (promesse rejetée) : `running → blocked` (état incertain), session laissée ouverte pour la réconciliation ;
- profil laissé en `running` : `blocked`.

## Verrou et double lancement

- `acquireInstanceLock(instanceLockPath(dataDir, profileId))` ouvre un fichier SQLite en `locking_mode = EXCLUSIVE` après une écriture. Le verrou du système de fichiers est tenu jusqu'à la fermeture et libéré par le système à la mort du processus : pas de verrou périmé.
- Garder une référence à l'objet retourné : une connexion collectée par le ramasse-miettes est fermée, ce qui relâche le verrou (constaté en test).
- Barrières complémentaires dans la transaction de lancement : réservation refusée si une autre est `open`, index `sessions_one_open`, `profiles.transition` qui vérifie l'état de départ.
- Prouvé par des processus réels (`scheduler.process.test.ts`) : verrou exclusif puis libéré à la mort du détenteur, une seule session pour deux schedulers lancés ensemble sur des verrous distincts, pas de relance après la mort brutale du scheduler.

## Redémarrage

`recover()` détecte une session ouverte ou un profil resté en `running`/`checkpointing`. Il journalise `orphan_reconciled` (phase `requested`) et appelle `SessionLauncher.reconcileOrphans`. La réconciliation elle-même (sessions `orphaned`, réservations `uncertain`, état stable) revient à S7. Tant qu'une session reste ouverte, aucun lancement.

## Signal de priorité humaine

`UserPrioritySignal.read()` rend `{ favorable, observedAt }`. `decideLaunch` refuse un signal absent, daté du futur ou plus ancien que `humanPriority.maxSignalAgeMs`.

Implémentations :

- `ManualPrioritySignal` : tests.
- `IdlePrioritySignal` : seuil `idleThresholdMs` appliqué à une source d'inactivité.
- `windowsIdleSource()` : une lecture ponctuelle pour Windows (`doctor`).
- `windowsIdleWatcher()` : flux continu (un PowerShell persistant, une valeur toutes les 250 ms), utilisé par le daemon en mode réel avec `WatchedPrioritySignal` ; `pollingIdleWatcher(source)` pour une `IdleSource` injectée (tests).
  - Lit `GetLastInputInfo` via un PowerShell court sans profil : instant de la dernière entrée seulement, sans contenu, sans droits administrateur.
  - Valable dans la session interactive de l'utilisateur ; un service en session 0 lirait une autre session.
  - Chaque lecture lance un processus (environ 1 s).

## Limites connues

- Voie abonnement (`billing.kind === "subscription_quota"`, ADR-005) : la réservation ne porte que `sessions` (aucune enveloppe de tokens propre à Wake, aucun `provider_quota_bp` réservé). Les lectures passent par `LaunchEnvironment.quotaSnapshots` jusqu'à `decideLaunch`. Pilotage (ADR-005, complément) : estimations lues par `LaunchEnvironment.pacingEstimates` ; en attente de pilotage, prochain réveil = `min(heure calculée, maintenant + 15 min)` (la projection peut avancer le réveil) ; cible ou seuil atteint → remise à zéro de la fenêtre en cause. Sous la garde, `minIntervalBetweenSessionsMs` est ignoré : les sessions s'enchaînent jusqu'à la cible. Une lecture absente ou périmée (`budget_unknown`) bloque le profil, comme tout budget inconnu.
- `duration_ms` n'est pas réservé : le ledger n'a pas de plafond de période fourni pour cette unité. La durée est bornée par l'échéance du ticket, que le runner doit imposer.
- Un blocage requis alors que le runner a déjà mis le profil en `hibernating` ne peut pas être appliqué (`hibernating → blocked` absent de la table). Il est journalisé (`error`), et le backoff maximal empêche une relance immédiate.
- `profiles.active_policy_revision_id` n'est pas mis à jour par le scheduler : la révision en vigueur vient de `resolvePolicy`.
- Le scheduler ne lève jamais `blocked` lui-même. La sortie de `blocked`, `paused` ou `stopped` est une action humaine (CLI).
