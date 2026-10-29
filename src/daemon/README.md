# src/daemon

Session S-D : assemblage du daemon Wake local avec l'**adapter factice uniquement** (porte F2, SPEC §11). Tout ce que ce daemon produit est marqué **SIMULÉ** : sortie, journal (`simulated: true`, provenance `simulated`), `status`, bilan. Aucun appel modèle, aucun port réseau, aucune modification système persistante.

## Commande

`mind-wake daemon run --simulated [--recheck-ms N] [--exit-after-sessions N]` — au premier plan seulement : ni service Windows, ni tâche planifiée, ni démarrage automatique. Ctrl+C : plus aucun réveil, la session en cours se termine, puis arrêt ; un second Ctrl+C arrête aussitôt (la session est alors réconciliée comme orpheline au démarrage suivant). Sans `--simulated`, refus (`real_adapter_missing`) : aucun adapter réel n'existe dans ce build. Le daemon refuse aussi si la policy active ne désigne pas l'adapter `fake` (`runtime_mismatch`), si un autre daemon tient le verrou du profil (`already_running`) ou si la terminaison d'arborescence est indisponible.

Variables réservées au développement et aux tests : `MIND_WAKE_RUNTIME_DIR` (lanceur Job Object déjà compilé), `MIND_WAKE_FAKE_SCENARIO` (scénario factice imposé à toutes les sessions : `slow`, `stubborn`…).

## Déroulement

1. Ouvre `control.sqlite`, vérifie le profil, prend le verrou d'instance (`src/scheduler/instance-lock.ts`, libéré par le système à la mort du processus).
2. Clôt les exécutions précédentes restées sans fin (`daemon_runs`, migration 3), journalise `daemon_started`.
3. `SessionRunner.reconcileAtStartup()` : arrêt d'urgence resté en marqueur de secours, sessions orphelines (`orphaned`, réservation `uncertain`, profil `blocked` ou `paused`, rien rejoué) ; puis réconciliation des artefacts (rapport seulement).
4. Boucle `Scheduler.run()` ; le daemon implémente `SessionLauncher` : charge la mémoire de l'expérience active dans le budget d'entrée (moitié de la borne de tokens), choisit le scénario de l'agent factice, puis `runner.launch({ sessionPrepared: true })` sur la session que le scheduler a créée dans la transaction de réservation.
5. Proposition d'expérience de l'agent (`experiments.ts`) : contenu non fiable, schéma fermé, aucun secret, racines d'écriture incluses dans la policy (sinon refus, jamais d'auto-attribution), une seule expérience active.
6. Checkpoint candidat : `decideAction(publish_checkpoint)` puis `publishCheckpoint` (S8), artefacts sous `<données>/workspace/artifacts`.

## Canal de contrôle

Aucun port. `pause`, `resume` et `stop` de la CLI écrivent l'état dans SQLite ; le watchdog du runner le relit toutes les 50 ms pendant une session, le scheduler à chaque tour (`--recheck-ms`, 2 s par défaut). `stop` termine aussi le Job Object de la session par son nom, sans dépendre du daemon. Signal de priorité utilisateur **simulé** : présence du fichier `<données>/simulated-user-activity` (hors de l'espace d'exploration), lu à chaque tour et à chaque tick du watchdog.

## Délais mesurés (démo, Windows 11, Node 24)

Voir le rapport de session S-D dans `docs/PLAN.md`. Bornes documentées (ADR-003) : 1 s.

## Agent factice de la démo

`src/adapters/fake/emergence.ts` : automate cellulaire élémentaire (règle 30). Mémoire vide → session A (proposition, essai sur un anneau de 10 cellules, cycle observé, échec documenté, hypothèse, checkpoint). Mémoire contenant `largeur=N` → session B (anneau 4N, 256 pas, petit résultat). Ensuite, session longue coopérative (démo des contrôles). Les choix sont scriptés ; le calcul et les artefacts sont réels.

## Limites

- **Isolation non implémentée** : seule l'arborescence de processus est contenue (Job Object) ; l'agent factice pourrait écrire hors de l'espace. `sandboxOperational` est déclaré `true` pour le seul adapter factice.
- **Signal d'activité simulé** (fichier) ; `GetLastInputInfo` (S6) n'est pas câblé.
- Aucune commande de réactivation après arrêt d'urgence : `resume` et `enable` refusent ; le profil reste `stopped` (aucun réveil, vérifié).
- `--exit-after-sessions` et l'arrêt par Ctrl+C attendent la fin de la session en cours (au plus la durée maximale de session).
- Rattachement de la session A à l'expérience choisie : écriture SQL directe (`SessionRepository` n'a pas de méthode dédiée).
- `uninstall` ne détecte pas un daemon actif : l'arrêter d'abord.
