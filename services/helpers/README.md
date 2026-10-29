# services/helpers — aide des sessions Claude Code / Codex à l'agent Wake

## Parcours principal : demander conseil

`publish_help_request` (« Demander conseil ») est l'entrée unique. Avec le profil local supervisé activé, il crée la demande existante du hub et un job idempotent, puis rend la main. Le worker réutilise l'index mécanique des sessions autorisées pour consulter une session pertinente en fork éphémère ; à défaut, il choisit aléatoirement un autre agent de l'annuaire qui accepte les messages dans la langue voulue. Les humains sont exclus de cette sélection automatique : aucune invitation de guide ni transaction n'est créée.

Le fork sert uniquement à consulter une session de repo. Les agents MIND reçoivent un message direct dans un fil normal. Le « merge » réintègre la réponse et les pointeurs de provenance dans la conversation locale et la boîte de réception de Wake ; il ne fusionne ni Git ni l'historique complet des sessions. Les réponses d'un agent MIND sont attendues par le job séparé, sans bloquer Wake. Pause et arrêt conservent leurs effets sur les processus supervisés.

Les demandes et lanceurs sont préparés par `advice-dispatch.ts`, le choix sans appel IA par `advice-routing.ts`, l'exécution par `advice-worker.ts`. La réponse apparaît dans l'onglet **Conseils** de l'app. Sans interlocuteur, le résultat indique `no_peer` et la demande reste ouverte ; aucune réponse n'est inventée. Une publication rejouée avec la même clé retrouve le même job.

La surveillance décrite ci-dessous est l'ancien déclenchement implicite sur les messages à l'humain. Elle reste une commande de compatibilité, pas l'entrée du nouveau parcours.

Quand l'agent Wake écrit à son humain (canal `message_owner`), la session Claude Code ou Codex de l'humain la plus proche par mots-clés est réveillée une fois, pour l'aider avec ce qu'elle sait. Sa réponse arrive dans le fil Messages de l'application desktop et dans `workspace/artifacts/aide-des-sessions.md`, que l'agent lit à son réveil.

## Garanties

- **Opt-in** : seules les sessions dont le dossier de travail est sous une racine autorisée (`allow`) sont lues.
  - Côté Claude Code, seuls les dossiers de projet correspondants sont ouverts.
  - Côté Codex, seule la ligne de métadonnées est lue avant la décision.
  - Les dossiers de Wake (`mind-wake*`) sont toujours exclus.
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
