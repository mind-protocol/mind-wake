# src/daemon

Session S-D : assemblage du daemon Wake local (porte F2, SPEC §11), puis câblage des runtimes (ADR-005). En mode simulé, tout ce que le daemon produit est marqué **SIMULÉ** : sortie, journal (`simulated: true`, provenance `simulated`), `status`, bilan. Aucun port réseau.

## Registre d'adapters (`registry.ts`)

`RUNTIME_IDS` : `fake`, `codex`, `claude`, `gemini`. Le runtime est celui de `policy.runtime.adapterId`, et seulement lui : aucun repli d'un runtime, d'un compte ou d'un fournisseur vers un autre. Une `AdapterRegistration` déclare `runtime()` (comparé champ à champ à la policy), `billing()` (`subscription_quota` pour un forfait borné par la jauge), `runtimeRoots()` (racines en lecture/exécution dans la sandbox) et `create(context)`. Le registre par défaut contient fake, codex et claude. Gemini possède un adapter mais n’est pas enregistré par défaut.

## Pilotage du quota (`pacing.ts`)

`QuotaPacingStore` (migration 6 `quota_pacing`) observe chaque lecture officielle de la jauge (scheduler et runner) : usage de la fenêtre en cours, instant où la cible est atteinte, ajustement de la marge à chaque remise à zéro. Le daemon lit la jauge au début et à la fin de chaque session pour mesurer le débit (moyenne glissante par runtime et par fenêtre) et journalise la projection (`quota.pacing_rate_measured`, `quota.pacing_margin_adjusted`). Ces estimations alimentent `decideLaunch` ; elles n'autorisent rien.

## Prompt de réveil et réveils demandés par l'agent

À chaque lancement, wake-prompt.ts compose la relance, les ressources courantes et les événements nouveaux dans context. Les instructions durables sont séparées ; artifacts/PERSONALITY.md est relu à chaque session Codex/Claude. La continuité repose sur les fichiers, checkpoints et conversations natives. wakeups.ts valide et archive les demandes dans workspace/wakeups/*.json : échéances candidates, jamais autorisations. Voir prompts/wake/README.md.

## Mode réel (`daemon run` sans `--simulated`)

1. Policy active désignant un adapter **enregistré** et non simulé (sinon `real_adapter_missing` ou `runtime_mismatch`) ; `probe` disponible (sinon `adapter_unavailable`) ; lanceur confiné constructible (sinon `sandbox_unavailable`), sauf en mode non isolé.
   **Mode NON ISOLÉ (ADR-006)** : si la révision porte `runtime.hostUnsandboxedAcknowledged: true` (consentement distinct, accordé seulement par `enable` avec confirmation humaine et exposé du risque), ni sandbox ni autotest ne sont exigés ; les sessions tournent sur le poste hôte dans un Job Object (arrêt d'urgence), journal `isolation: "host_unsandboxed"`, sortie préfixée `[NON ISOLÉ]`, bilans marqués « NON ISOLÉ ».
2. En profil isolé uniquement, au démarrage de `run` : profil AppContainer `mindwake.sandbox` créé s'il manque, puis **autotest de refus** complet (`runIsolationSelfTest`, ≈ 4 s), consigné dans `isolation_self_tests` (migration 4) et journalisé. L'isolation n'est prête que s'il réussit, nettoyage vérifié, pour l'empreinte du lanceur ; sinon le scheduler refuse (`sandbox_unavailable`, profil `blocked`).
3. `RuntimeEnvironment` : faits de l'adapter, isolation prête, facturation de l'enregistrement, jauge officielle (`QuotaReadable.readQuota`) pour la voie abonnement. Le ticket est lancé avec `onSubscription` : le runner relit la jauge et interrompt au seuil d'arrêt.
4. En profil isolé, sessions dans la sandbox (`src/runner/sandboxing.ts`), racines de la policy sous `<données>/workspace`, base de contrôle et dossier de données protégés.

## Commande

`mind-wake daemon run [--simulated] [--recheck-ms N] [--exit-after-sessions N]` — au premier plan seulement : ni service Windows, ni tâche planifiée, ni démarrage automatique. Ctrl+C : plus aucun réveil, la session en cours se termine, puis arrêt ; un second Ctrl+C arrête aussitôt (la session est alors réconciliée comme orpheline au démarrage suivant). `--simulated` exige une policy sur l'adapter `fake` (`runtime_mismatch`) ; sans `--simulated`, voir « Mode réel ». Le daemon refuse aussi si un autre daemon tient le verrou du profil (`already_running`) ou si la terminaison d'arborescence est indisponible.

Variables réservées au développement et aux tests : `MIND_WAKE_RUNTIME_DIR` (lanceur Job Object déjà compilé), `MIND_WAKE_FAKE_SCENARIO` (scénario factice imposé à toutes les sessions : `slow`, `stubborn`…).

## Déroulement

1. Ouvre `control.sqlite`, vérifie le profil, prend le verrou d'instance (`src/scheduler/instance-lock.ts`, libéré par le système à la mort du processus).
2. Clôt les exécutions précédentes restées sans fin (`daemon_runs`, migration 3), journalise `daemon_started`.
3. `SessionRunner.reconcileAtStartup()` : arrêt d'urgence resté en marqueur de secours, sessions orphelines (`orphaned`, réservation `uncertain`, profil `blocked` ou `paused`, rien rejoué) ; puis réconciliation des artefacts (rapport seulement).
4. Boucle `Scheduler.run()` ; le daemon implémente `SessionLauncher` : charge la mémoire de l'expérience active dans le budget d'entrée (moitié de la borne de tokens), choisit le scénario de l'agent factice, puis `runner.launch({ sessionPrepared: true })` sur la session que le scheduler a créée dans la transaction de réservation.
5. Proposition d'expérience de l'agent (`experiments.ts`) : contenu non fiable, schéma fermé, aucun secret, racines d'écriture incluses dans la policy (sinon refus, jamais d'auto-attribution), une seule expérience active.
6. Checkpoint candidat : `decideAction(publish_checkpoint)` puis `publishCheckpoint` (S8), artefacts sous `<données>/workspace/artifacts`.

## Canal de contrôle

Aucun port. `pause`, `resume` et `stop` de la CLI écrivent l'état dans SQLite ; le watchdog du runner le relit toutes les 50 ms pendant une session, le scheduler à chaque tour (`--recheck-ms`, 2 s par défaut). `stop` termine aussi le Job Object de la session par son nom, sans dépendre du daemon. Signal de priorité utilisateur : en mode `--simulated`, **simulé** par la présence du fichier `<données>/simulated-user-activity` (hors de l'espace d'exploration) ; en mode réel, **inactivité réelle du poste** (`GetLastInputInfo`, `windowsIdleWatcher`) comparée à `humanPriority.idleThresholdMs` de la révision effective, lue à chaque tour du scheduler et à chaque tick du watchdog (50 ms). Lorsque la priorité d’inactivité s’applique, retour de l’humain → interruption (checkpoint si possible) puis hibernation ; signal illisible ou plus vieux que `maxSignalAgeMs` → aucun réveil, et la session en cours est interrompue (hibernation, pas de blocage). `daemon_started` journalise `prioritySignal`.

Les réveils explicites et Always-on portent humanRequested : fenêtres, inactivité et attente de pilotage ne les retardent pas ; quota, backoff, permissions, Pause et Force-off restent appliqués. Always-on relance après la fin de session sans intervalle planifié, jamais en parallèle pour le même profil. On revient à la planification. La CLI exige reactivate après un arrêt verrouillé ; le choix explicite Always-on dans le desktop effectue cette revalidation.

Voir aussi [jobs supervisés](../../docs/BACKGROUND-JOBS.md) et [capacités natives](../../docs/NATIVE-CAPABILITIES.md).

## Délais mesurés (démo, Windows 11, Node 24)

Mesures historiques et conditions ci-dessous ; elles ne remplacent pas une recette du profil actuel. Bornes documentées (ADR-003) : 1 s.

## Agent factice de la démo

`src/adapters/fake/emergence.ts` : automate cellulaire élémentaire (règle 30). Mémoire vide → session A (proposition, essai sur un anneau de 10 cellules, cycle observé, échec documenté, hypothèse, checkpoint). Mémoire contenant `largeur=N` → session B (anneau 4N, 256 pas, petit résultat). Ensuite, session longue coopérative (démo des contrôles). Les choix sont scriptés ; le calcul et les artefacts sont réels.

## Limites

- **Adapter factice non confiné** : seule son arborescence de processus est contenue (Job Object) ; il pourrait écrire hors de l'espace. `sandboxOperational` est déclaré `true` pour le seul mode simulé. Les adapters réels ne sont confinés au niveau système que dans un profil isolé, pas en mode hôte consenti.
- **Désinstallation** : le profil AppContainer `mindwake.sandbox` créé par le mode réel n'est pas encore supprimé par `uninstall`.
- **Coût du signal réel** (mesuré le 29 octobre 2026, Windows 11, poste au repos) : un PowerShell par lecture coûte 0,44 à 0,86 s (compilation `Add-Type`), trop lent pour la borne d'une seconde. Le daemon garde donc **un seul PowerShell persistant**, sans droits administrateur, qui compile une fois (première valeur ≈ 0,64 s) puis écrit l'inactivité toutes les 250 ms (écart maximal mesuré 263 ms). Retour de l'humain → session terminée en 79 ms avec un signal injecté ; avec le flux réel, ajouter au plus un intervalle de lecture. Valable dans la session interactive de l'utilisateur seulement (un service en session 0 lirait une autre session).
- resume ne lève pas un arrêt d’urgence ; reactivate revalide la policy consentie avant de retirer le verrou.
- `--exit-after-sessions` et l'arrêt par Ctrl+C attendent la fin de la session en cours (au plus la durée maximale de session).
- Rattachement de la session A à l'expérience choisie : écriture SQL directe (`SessionRepository` n'a pas de méthode dédiée).
- `uninstall` ne détecte pas un daemon actif : l'arrêter d'abord.
