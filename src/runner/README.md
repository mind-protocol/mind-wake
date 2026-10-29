# src/runner

Session S7, puis câblage des runtimes (ADR-005). Runner de sessions, contrôles humains (pause, reprise, arrêt d'urgence) et réconciliation des sessions orphelines (AGENTS §5 « Cycle de vie et continuité », SPEC §5, §8.1, §9). Un adapter réel est lancé dans la sandbox AppContainer + Job Object de `src/sandbox/` ; l'adapter factice garde le Job Object seul, marqué SIMULÉ. Aucun appel modèle dans ce dépôt.

## Modules

| Fichier                  | Rôle                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner.ts`              | `SessionRunner` : lancement sur réservation, `decideAction` avant chaque action, surveillance, interruptions, rapprochement, kill switch, réconciliation au démarrage. |
| `controls.ts`            | `requestPause`, `requestResume`, `persistEmergencyStop`, `StopFlag` : état de contrôle persisté, partagé par le runner et la CLI.                                      |
| `process-tree.ts`        | `ProcessTreeSupervisor`, `ContainedProcess` : arborescence de processus dans un Job Object Windows nommé.                                                              |
| `job-launcher-source.ts` | Source C# du lanceur natif, compilé à la demande par le `csc.exe` de .NET Framework 4.x livré avec Windows.                                                            |
| `host.ts`                | `AdapterHost` (lancer un processus contenu, faire autoriser une action, connaître le confinement), `CheckpointRequestable`, `QuotaReadable` (jauge officielle).        |
| `sandboxing.ts`          | `RunnerSandbox` (fourni par le daemon) et `sandboxSpecFor` : racines de la policy sous l'espace d'exploration, racines runtime, chemins protégés, broker, filet.       |
| `paths.ts`               | `runtimeDirFor(dataDir)` : binaires du runner dans le dossier de contrôle.                                                                                             |

## Port de lancement (pour S6)

Le scheduler appelle `decideLaunch`, réserve l'enveloppe (`ledger.reserve`), puis :

```ts
const running = await runner.launch({
  profileId,
  sessionId,
  experimentId,
  reservationId,
  decision,
  context,
  maxInputTokens,
});
const result = await running.done; // SessionResult : outcome, reason, profileState, réservation…
```

`launch` refuse (`RunnerError.code`) : décision non `allow`, réservation absente, close ou émise pour une autre session, réservation sans borne de tokens, profil non `ready` ou verrouillé, révision révoquée, session déjà active, marqueur d'arrêt d'urgence présent, terminaison d'arborescence indisponible. Le profil `ready` est revérifié dans la transaction qui crée la session et passe en `running`.

Au démarrage du daemon, appeler `runner.reconcileAtStartup()` avant tout lancement.

## Règles retenues

- **Confinement (S10 → runner)** : `probe.simulated === false` ⇒ `launch` exige `deps.sandbox` et `sandbox.ready().ok` (autotest de refus réussi pour ce lanceur), sinon `RunnerError sandbox_unavailable`. `spawnContained` lance alors via `Sandbox.launch` : racines d'écriture et de lecture de la policy résolues sous `workspaceDir` (créées au besoin), racines runtime en lecture/exécution, base de contrôle et dossier de données protégés, `maxProcesses` de la policy, filet de durée du lanceur (`maxSessionDurationMs` + grâce + 2 × borne de terminaison), réseau fermé sauf broker (`command.broker`, chemin du pipe dans `MIND_WAKE_BROKER_PIPE`). Même nom de job (`jobNameFor`) : `stop` et la réconciliation terminent aussi un job confiné. `session_started` / `session_ended` journalisent `isolation` et `aclRevoked`.
- **Mode non isolé (ADR-006)** : si la révision de la session porte `runtime.hostUnsandboxedAcknowledged: true`, un adapter réel tourne sur le poste hôte (`isolation: "host_unsandboxed"`) dans un Job Object (`ProcessTreeSupervisor`) : arrêt d'urgence, pause, priorité humaine et garde de quota inchangés, sandbox non exigée. L'environnement reste explicite (variables système minimales + `command.env`) : l'adapter transmet lui-même ce dont son CLI a besoin (`PATH`, `USERPROFILE`, `APPDATA`…).
- **Mode sans approbation** (`command.unattended`) : permis en `sandbox` ou `host_unsandboxed`, refusé pour un adapter simulé (`RunnerError unattended_outside_sandbox`, `action_denied` `runner.unattended_outside_sandbox`) ; `host.isolation(sessionId)` dit à l'adapter s'il peut passer l'option.
- **Voie abonnement** (`grant.onSubscription`) : l'adapter doit implémenter `QuotaReadable` et déclarer `providerQuotaReading: "official"` et `tokenCapEnforcement: "provider_quota_guard"` (sinon `quota_unreadable`). La réservation peut n'avoir aucune borne de tokens si la révision active la garde ; sinon `reservation_unbounded`. La jauge est lue avant `start`, puis toutes les `quotaPollIntervalMs` (15 s) ; chaque tick et chaque action évaluent `onSubscription: true` et la dernière lecture : seuil d'arrêt → interruption (`budget_exhausted`, checkpoint permis, `hibernating`) ; lecture absente, non mesurée ou plus vieille que `maxSnapshotAgeMs` → interruption (`budget_unknown`). Un échec de lecture garde la précédente, qui se périme.

- **Actions contrôlées** : l'adapter appelle `host.authorize(sessionId, action)` ; le runner évalue `decideAction` avec les conditions vivantes (`liveChecks` : priorité humaine, sandbox), journalise `action_allowed`/`action_denied`, et interrompt si `interruptSession`. Les signaux sont lus avant l'horloge du daemon : un signal ne peut pas sembler postérieur à `now`.
- **Surveillance** toutes les 50 ms (`watchdogIntervalMs`) : profil `stopped`, verrouillé ou marqueur de secours → arrêt immédiat ; profil passé en `checkpointing` par un autre processus → pause ; `assessActiveSession` (révocation, restriction, priorité humaine, sandbox) → interruption, avec checkpoint seulement si le policy engine le permet.
- **Bornes** : tokens de la réservation (interruption immédiate à la borne, checkpoint demandé dès que reste seulement `checkpointTokens`) et `maxSessionDurationMs` (checkpoint demandé `checkpointGraceMs` avant l'échéance, arrêt forcé à l'échéance).
- **Checkpoint demandé** seulement si l'enveloppe restante le permet (tokens ≥ `checkpointTokens`, temps avant échéance) ; terminaison au plus tard après `checkpointGraceMs` (2 s par défaut), que l'agent coopère ou non. Les candidats vont à `onCheckpointCandidate` (validation et publication : S8).
- **Usage** : chaque événement `usage` est enregistré aussitôt (`recordUsage`, horodatages strictement croissants), `simulated` pour un adapter simulé. En fin de session, `adapter.reconcile` confirmé → `ledger.reconcile` avec le complément de tokens, une session et la durée si réservées ; sinon `markUncertain` (borne maximale conservée).
- **Résultats** : fin déclarée et code 0 → `completed` (profil `hibernating`) ; limitation fournisseur → `interrupted` (`hibernating`) ; erreur d'authentification ou incompatibilité → `failed` (`blocked`) ; crash de l'agent → `failed` (`hibernating`) ; révocation → `interrupted` (`blocked`) ; kill switch → `interrupted` (`stopped`) ; terminaison non confirmée → `orphaned` (`blocked`). Priorité de l'état final : arrêt d'urgence, puis pause demandée, puis l'état propre à la cause.
- **Pause** (`requestPause`) : prochain réveil supprimé, `pause_requested` journalisé ; sans session, `ready`/`hibernating` → `paused` ; avec session, `running` → `checkpointing`, le runner demande le checkpoint puis termine et place le profil en `paused`.
- **Reprise** (`requestResume`) : `paused` → `ready` seulement après `decideActivation` positive et sans session ouverte ; refusée (`emergency_stop_locked`) après un arrêt d'urgence. Aucune commande ne fait `disabled → ready`.
- **Kill switch** (`runner.stop`, CLI `stop`) : 1) transaction `→ stopped` + verrou `emergencyStopLocked` + prochain réveil supprimé + `kill_switch_triggered` ; 2) plus aucune action accordée ; 3) terminaison du job, sans attendre le modèle. Si la transaction échoue, le marqueur `emergency-stop.flag` est écrit et la terminaison a lieu quand même ; un runner actif le lit à chaque surveillance ; au démarrage, `reconcileAtStartup` applique l'arrêt puis efface le marqueur ; tant qu'il existe, `launch` refuse.
- **Réconciliation au démarrage** : chaque session ouverte que ce runner ne mène pas devient `orphaned` ; un job encore présent est terminé par son nom ; la réservation passe ou reste `uncertain` ; le profil `running` devient `blocked` (`checkpointing` avec pause demandée → `paused`) ; rien n'est relancé, aucune action rejouée (`orphan_reconciled.replayed = false`). Idempotente.

## Terminaison d'arborescence (Windows)

Mécanisme repris du spike S2 (ADR-003), sans AppContainer : Job Object nommé `Local\mindwake-session-<sha256(profil, session)>`, `KILL_ON_JOB_CLOSE`, sans breakaway, assignation à la création (`PROC_THREAD_ATTRIBUTE_JOB_LIST`), poignées héritées limitées (`HANDLE_LIST` : stdin alimenté par le lanceur, stdout du lanceur, stderr vers NUL), environnement explicite, limite de processus actifs = `filesAndTools.maxProcesses`. Filets successifs : commande `kill` au lanceur ; mort du lanceur (le noyau ferme le job) ; fin du canal de contrôle du lanceur (daemon disparu) ; terminaison par nom depuis n'importe quel processus (`terminate`), qui sert aussi à la CLI et à la réconciliation (`query`). Quand le processus principal se termine, ses descendants sont terminés.

Borne documentée : **1 s** entre la décision d'arrêt et la confirmation (`DEFAULT_TERMINATION_TIMEOUT_MS`, proposée pour G1 par ADR-003). Au-delà, la session devient `orphaned`, la réservation `uncertain`, le profil `blocked`.

Mesures (Windows 11 Famille, Node 24.17.0, poste au repos, arborescence de 5 processus Node : agent, 2 enfants détachés, 2 petits-enfants détachés ; 29 octobre 2026, `npm test`) :

| Déclencheur                                                                            | Délai mesuré                                  | Noyau (`TerminateJobObject` → 0 actif) | Survivants |
| -------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------- | ---------- |
| `runner.stop()` en processus, décision → confirmation                                  | 11,5 ms ; ×5 : médiane 10,0 ms, max 11,6 ms   | 5,4 – 7,0 ms                           | 0          |
| Idem, persistance SQLite comprise                                                      | 14,7 ms                                       | —                                      | 0          |
| CLI `stop` dans un autre processus, terminaison par nom (lancement du lanceur compris) | 91 ms                                         | —                                      | 0          |
| Daemon tué brutalement (fin du canal de contrôle)                                      | 8,3 ms jusqu'à la disparition de tous les PID | —                                      | 0          |

Hors Windows, aucun mécanisme équivalent n'est démontré : `ProcessTreeSupervisor` se déclare indisponible et `launch` refuse.

## Limites restantes

- **Adapter factice non confiné** : il tourne avec les droits de l'utilisateur, Job Object seul (SIMULÉ). Les adapters réels sont confinés ; restent non testées les évasions WMI/COM (voir `src/sandbox/README.md`).
- Mesures sur poste au repos avec de petits processus ; ni charge, ni E/S noyau bloquées, ni Codex réel.
- Sans bundle natif, le lanceur est compilé à la première utilisation dans `<dataDir>/runtime/` (≈ 1 s) ; binaire non signé, `csc.exe` de .NET Framework requis. Un lanceur précompilé peut désormais être distribué dans `bin/native/`, avec manifeste et empreintes vérifiés avant usage. La chaîne de préparation et de signature ainsi que le test préalable sur le poste destinataire sont décrits dans [WINDOWS-APPLICATION-CONTROL.md](../../docs/WINDOWS-APPLICATION-CONTROL.md). Aucun certificat de production ni acceptation Windows universelle n’est fourni par cette modification.
- La sortie d'erreur de l'agent est jetée (NUL) pour que le canal d'événements du lanceur ne puisse pas être imité ; aucun diagnostic de l'agent n'est conservé.
- La CLI `stop` ne clôt pas elle-même les sessions : le runner actif le fait, sinon la réconciliation au démarrage. Si la base est inaccessible, la CLI ne connaît pas les sessions ouvertes : seul le marqueur de secours, lu par le runner actif, déclenche alors la terminaison.
- `ProfileRecord.activePolicyRevisionId` n'est toujours mis à jour par personne : le runner s'appuie sur `decision.revisionId` et sur `resolvePolicy`.
- `onCheckpointCandidate` reçoit des candidats non validés ; aucune publication (S8). La demande de checkpoint passe par `CheckpointRequestable`, hors contrat.
- Le scheduler (S6) n'est pas branché : backoff après limitation, prochain réveil après hibernation et verrou d'instance du daemon restent à lui.
