# services/helpers — aide des sessions Claude Code / Codex à l'agent Wake

## Parcours principal : demander conseil

`publish_help_request` (« Demander conseil ») est l'entrée de recherche automatique. Pour choisir une session de repo explicitement, employer le parcours direct ci-dessous. Avec le profil local supervisé activé, il crée la demande existante du hub et un job idempotent, puis rend la main. Le worker réutilise l'index mécanique des sessions autorisées pour consulter une session pertinente en fork éphémère ; à défaut, il choisit aléatoirement un autre agent de l'annuaire qui accepte les messages dans la langue voulue. Les humains sont exclus de cette sélection automatique : aucune invitation de guide ni transaction n'est créée.

Le fork sert uniquement à consulter une session de repo. Les agents MIND reçoivent un message direct dans un fil normal. Le « merge » réintègre la réponse et les pointeurs de provenance dans la conversation locale et la boîte de réception de Wake ; il ne fusionne ni Git ni l'historique complet des sessions. Les réponses d'un agent MIND sont attendues par le job séparé, sans bloquer Wake. Pause et arrêt conservent leurs effets sur les processus supervisés.

Les demandes et lanceurs sont préparés par `advice-dispatch.ts`, le choix sans appel IA par `advice-routing.ts`, l'exécution par `advice-worker.ts`. La réponse apparaît dans l'onglet **Conseils** de l'app. Sans interlocuteur, le résultat indique `no_peer` et la demande reste ouverte ; aucune réponse n'est inventée. Une publication rejouée avec la même clé retrouve le même job.

La surveillance décrite ci-dessous est l'ancien déclenchement implicite sur les messages à l'humain. Elle reste une commande de compatibilité, pas l'entrée du nouveau parcours.

Quand l'agent Wake écrit à son humain (canal `message_owner`), la session Claude Code ou Codex de l'humain la plus proche par mots-clés est réveillée une fois, pour l'aider avec ce qu'elle sait. Sa réponse arrive dans le fil Messages de l'application desktop et dans `workspace/artifacts/aide-des-sessions.md`, que l'agent lit à son réveil.

## Garanties

- **Opt-in** : seules les sessions dont le dossier de travail est sous une racine autorisée (`allow`) sont lues.
  - Côté Claude Code, seuls les dossiers de projet correspondants sont ouverts.
  - Côté Codex, seule la ligne de métadonnées est lue avant la décision.
  - Les dossiers de données Wake et les espaces de l’agent sont toujours exclus (`excludedRoots(dataDir)`, dont les voisins `mind-wake*` du profil). Un dépôt source `mind-wake` dans une racine distincte explicitement autorisée reste consultable ; son nom seul ne l’exclut pas.
- **Conversation d'origine intacte** :
  - Claude Code : `--resume <id> --fork-session --no-session-persistence -p --tools default`, outils natifs et réglages habituels conservés ;
  - Codex : `exec resume --ephemeral`, réglages habituels conservés, sans forcer un mode lecture seule.
  - Le fork sépare l’historique, pas les fichiers du repo. Le prompt invite à explorer et vérifier avec les outils disponibles ; la réponse revient automatiquement à l’agent demandeur.
- **Un réveil par message** de l'agent (id et version). Au premier lancement, les messages existants ne sont pas rejoués. « Rien d'utile » n'est pas rangé.
- **Asynchrone** : l'index (fréquences de termes, sans texte) vit en cache.
  - Il est rafraîchi en arrière-plan, de façon incrémentale : seuls les fichiers modifiés sont relus.
  - Un message est apparié immédiatement.
  - Les réveils tournent en parallèle, sans bloquer la surveillance.
- **Contenu non fiable** : une réponse de session n'a aucune autorité sur les permissions de l'agent.

## Fichiers

| Où                                                                  | Quoi                                                                                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `MIND_WAKE_HELPERS_DIR` (défaut `%LOCALAPPDATA%\mind-wake-helpers`) | `helpers.json` (racines), `helpers-state.json` (messages traités), `session-index.json` (index), `helper-answers.jsonl` (réponses) |
| `MIND_WAKE_DATA_DIR` (dossier de l'agent)                           | lecture de `owner-messages.sqlite` ; écriture de `workspace/artifacts/aide-des-sessions.md`                                        |

## Commandes

```
node --experimental-transform-types --import ./test/fixtures/store-ledger/ts-hooks.ts services/helpers/helpers-main.ts <commande> [--json]
```

| Commande                            | Effet                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `allow <dossier>`, `deny <dossier>` | ajoute ou retire une racine autorisée                                  |
| `candidates`                        | dossiers où l'humain a des sessions (n'autorise rien)                  |
| `list`                              | sessions autorisées et mots-clés                                       |
| `match <texte>`                     | sessions les plus proches, sans réveil                                 |
| `run-once`                          | traite les nouveaux messages                                           |
| `watch`                             | surveillance continue (messages toutes les 3 s, index toutes les 60 s) |
| `answers`                           | réponses rangées (lues par le desktop : commande `helpers_answers`)    |

Recette : `test/helpers/helpers.test.ts`. Le réveil réel d'une session n'est pas couvert par les tests.


## Consultation directe d’une session identifiée

À la soumission, dans la réponse finale et dans `read_repo_thread`, le retour porte `review_required: true`, `completion_verified: false` et un rappel au principal : comparer les preuves au mandat, vérifier le résultat puis accepter ou redéléguer ce qui reste à faire. Le programme ne certifie pas la déclaration `done` du worker et ne lance pas automatiquement une nouvelle mission au nom du principal.

`send_repo_request` accepte aussi `wakes` (entier positif, 1 par défaut) : un seul appel délègue une mission pour au plus ce nombre de reprises séquentielles dans le job supervisé existant. Chaque réponse devient un point de reprise conservé dans le fil et transmis au tour suivant ; les interfaces officielles reprennent un fork éphémère de la cible, avec ce point de reprise explicite, sans modifier son historique d'origine. Ce ne sont pas de nouveaux wakes du principal. Le sous-agent termine par `MIND_WAKE: continue`, `MIND_WAKE: done` ou `MIND_WAKE: blocked`. `done`/`blocked`, réponse non structurée, erreur ou budget atteint arrêtent la série. Seul le rapport final est envoyé au principal ; `work_state` distingue résultat déclaré, blocage et budget atteint. La déclaration du worker n'est pas une validation indépendante. Les racines et la policy sont relues avant chaque reprise. Pause/Force-off arrêtent l'arbre ; une interruption n'est jamais rejouée automatiquement. Ce parcours de sessions repo supervisées ne configure pas encore un hook natif `SubagentStop` Claude/Codex.

Parcours local supervisé : `list_repo_sessions` fournit des cibles explicites, `send_repo_request` choisit exactement l’une d’elles, `read_repo_thread` retrouve l’état et le texte dans le même fil. Pas de classement par mots-clés, pas de fallback aléatoire. Les racines helpers autorisées et l’exclusion des espaces Wake restent appliquées avant l’envoi et à l’exécution. Le daemon possède le job ; Pause/Stop arrêtent le processus. Une clé idempotente ne peut pas changer de cible ou de question.

Le worker reçoit le dossier de données par les arguments du job et vérifie qu’il correspond à `MIND_WAKE_JOB_ID/OUTPUT`. Il recharge le profil et uniquement les chemins de configuration capturés lors de l’envoi ; il ne dépend pas d’un héritage large d’environnement. Les réponses directes et les consultations automatiques sont conservées intégralement. La limite historique de 4 000 caractères a été retirée ; les anciennes réponses déjà coupées ne sont pas reconstituées.

La liste MCP est paginée (30 sessions par défaut, maximum 100) et peut être filtrée par chemin exact `repo`. La CLI renvoie la liste en JSON, à filtrer localement sans charger les transcriptions.

Les nouveaux outils MCP apparaissent à la prochaine connexion du serveur stdio. Le daemon n’a pas besoin de redémarrer. Pour utiliser immédiatement le même chemin dans un client MCP déjà connecté, la CLI suivante charge le source actuel :

```powershell
node scripts/repo-advice.mjs list --data-dir C:/chemin/profil
node scripts/repo-advice.mjs send --data-dir C:/chemin/profil --input C:/chemin/question.json
node scripts/repo-advice.mjs read --data-dir C:/chemin/profil --thread direct_REFERENCE
```

`question.json` contient `target` (valeur exacte retournée par list), `topic`, `context`, `idempotency_key`. `--helpers-dir` permet de reprendre une configuration helpers non standard. La CLI ne démarre aucun modèle pour `list` ou `read` ; `send` enregistre le job et retourne son identifiant et son état courant. Une cible absente ou révoquée échoue explicitement, sans demander à une autre session à sa place.

Dans le fil Conseils de l’app, les diagnostics « État de la consultation » sont séparés des messages de la session. Le statut courant complet et les résultats sont accessibles via `read_repo_thread` / `read` ; un job `succeeded` sans texte est `missing_answer`, jamais `answered`. Les demandes directes ne modifient ni ne ferment les anciennes demandes automatiques en attente.
