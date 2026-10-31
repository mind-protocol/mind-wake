# Notion read-only - local production integration

The production MCP entry registerConnectorTools registers Notion through the
reviewed Gmail FINAL core: ConnectorRecords, WindowsVault DPAPI and ConnectorGate.
There is no second vault, policy engine or scheduler. No real account was connected.

## Owner setup and disconnect

Create an INTERNAL connection in your Notion workspace with Read content ONLY.
Disable insert/update, comments and user information. Share the intended root
pages explicitly. Notion sharing includes children; includeDescendants adds a
local restriction on their expansion.

Copy examples/notion-readonly.setup.json outside the sources. Replace the
synthetic bot UUID (accountId), workspaceId, exact workspaceName and rootPageIds
(maximum 20). This JSON contains no token. In an interactive owner terminal,
after the existing Wake policy allows api.notion.com:443 and host execution:

```powershell
mind-wake connectors notion-setup scope.json --data-dir PROFILE_PATH
mind-wake connectors notion-status --data-dir PROFILE_PATH
mind-wake connectors notion-disconnect --data-dir PROFILE_PATH
```

Setup displays the scope and requires CONNECT, then receives the internal token
through hidden input. No token argument, environment variable, plaintext config,
bridge or terminal echo. Configuration/grant and token are encrypted separately
with DPAPI CurrentUser, without a plaintext fallback. Setup validates GET /users/me
(bot ID, workspace owner, workspace ID/name), then reads each selected root under
the common Gate. There is no users.list, person profile or email request.

The remote capability set and token kind cannot be introspected with these
endpoints. The owner must select the internal connection and Read content only.
The code accepts only internal mode and only allowlisted reads, but cannot prove
that the supplied token has no additional provider permissions. PAT and public
OAuth are outside this journey; no shared client_secret or external backend.

Disconnect closes local access before secret cleanup, invalidates pending setups
and reports cleanup failure. Remote revocation is not attempted: remove page
sharing and revoke/replace the connection token in Notion settings separately.
Pause, Force-off, policy withdrawal and stop-flag take precedence. No MCP tool
can create a grant, configure a connection or receive a token.

## States and effective controls

CLI notion-status and MCP notion_status separate installed, configured,
authorized and available. CLI never probes the provider and reports available
false. MCP requires a successful provider read within 30 seconds in that process,
the same slot and currently allowed controls. Public scope includes bot/workspace
identity and roots, without internal references or secrets. Failure is not consent
withdrawal; a stored token alone is not local authorization.

NotionLocal binds the generation/token/bot/workspace, validates /users/me on each
operation and rechecks the common grant/control before each request, page, retry
and return. The shared Gate also aborts waits and suppresses results after
withdrawal. There is no persistent body cache, indexing, attachment download or
file-sharing export. CLI test seams are in-process arguments; production has no
flag, environment variable or configurable base URL to bypass these controls.

## Endpoints et bornes

`GET /users/me` is additionally allowlisted for bot/workspace binding only.
No `GET /users` or arbitrary user lookup is exposed.

API fixée : **`2026-03-11`**, dont le modèle bases/sources de données introduit
en `2025-09-03`. En-tête `Notion-Version` sur chaque requête.

| Méthode | Chemin exact                                | Usage                                                  |
| ------- | ------------------------------------------- | ------------------------------------------------------ |
| GET     | `/v1/pages/{uuid}`                          | Page racine ou enfant vérifié                          |
| GET     | `/v1/pages/{uuid}/properties/{property_id}` | Propriété choisie                                      |
| GET     | `/v1/blocks/{uuid}`                         | Bloc découvert sous un parent autorisé                 |
| GET     | `/v1/blocks/{uuid}/children`                | Liste explicite d'enfants                              |
| GET     | `/v1/databases/{uuid}`                      | Métadonnées et sources déclarées                       |
| GET     | `/v1/data_sources/{uuid}`                   | Source déclarée par la base                            |
| POST    | `/v1/data_sources/{uuid}/query`             | Lecture bornée des entrées                             |
| POST    | `/v1/search`                                | Recherche de titre bornée, résultats racines accordées |

Ces deux POST sont des lectures. Pas de `databases/{id}/query` ancien modèle,
ni endpoint d'écriture, commentaire, utilisateur ou fichier. Origine fixe
`https://api.notion.com`, aucun paramètre de base URL, redirections refusées.

Chaque get repart d'une racine accordée et revalide son chemin : les objets
doivent être annoncés par la liste d'enfants, par les sources de la base, ou
par le query de leur source ; l'objet relu doit avoir le même ID et le bon
parent. Aucun cache de droits ou de chemins entre opérations. Un ID issu
d'une relation ne suffit pas. Les blocs synchronisés depuis un autre bloc
ne sont pas développés. Les relations/liens restent des références non fiables.

Une liste : 25 éléments par page, 4 pages maximum, curseurs opaques conservés
uniquement en mémoire pour l'opération, cycles refusés et troncature explicite.
Chemin de 8 objets maximum, pas de récursion automatique. Une propriété renvoie
sa première réponse seulement ; `truncated` signale une suite éventuelle, sans
suivre `next_url`. La recherche contacte l'index partagé de la connexion avec
un titre obligatoire : seuls les hits correspondant aux **racines locales**
sont renvoyés, après get frais. Les autres hits transitent en mémoire uniquement.
Utiliser `notion_list` pour découvrir des descendants : pas de recherche globale
des corps ni de garantie d'exhaustivité.

429 : respecter Retry-After numérique de 0 à 5 secondes, au maximum deux
nouvelles tentatives. Pour une attente supérieure, invalide ou absente, rendre
`rate_limited` immédiatement et laisser l'appelant reprendre plus tard. Chaque
tentative, page et retour vérifie le grant ; le signal coupe aussi l'attente.
Réponse transport limitée à 2 Mo réels. Le délai global et le signal d'arrêt
relèvent du `ConnectorGate` commun. Erreurs stables sans corps fournisseur,
cause, token ou URL authentifiée ; aucun logger ajouté.

## Données et limites connues

Le résultat porte provider, version API, compte/workspace du grant, ID, URL
canonique dérivée de l'ID, date de lecture et dates source disponibles. Les
propriétés utilisent la provenance de leur page vérifiée. Une URL canonique
peut rediriger dans le navigateur ; elle n'est jamais utilisée pour fetch.
Les dates indisponibles restent nulles (notamment les références de sources).

Tous les contenus et propriétés portent `untrusted_source_content` : ils ne
peuvent accorder de droits ou devenir des instructions. Les fichiers et liens
peuvent apparaître comme métadonnées de contenu ; aucun téléchargement n'a lieu.
Aucun cache durable, index, tâche automatique, export vers partage fichiers,
nouveau droit filesystem ou configuration live. Le consommateur ne doit pas
transformer cette lecture en export implicite.

Limites assumées : uniquement racines de type page ; validation stricte des
parents, qui peut refuser des structures Notion atypiques ; résultats limités
et incomplets ; pas de preuve sur un compte réel. Le parcours commun de production
est vérifié avec fournisseurs et saisies propriétaires synthétiques.

## Sources officielles consultées le 31 octobre 2026

- [Autorisation : connexion interne, PAT et OAuth public](https://developers.notion.com/guides/get-started/authorization).
- [Capacités et absence d'information utilisateur](https://developers.notion.com/reference/capabilities).
- [Token bot identity](https://developers.notion.com/reference/get-self), [bot workspace fields](https://developers.notion.com/reference/user) checked during independent integration review.
- [Versioning](https://developers.notion.com/reference/versioning), [migration 2026-03-11](https://developers.notion.com/guides/get-started/upgrade-guide-2026-03-11).
- [Query d'une source](https://developers.notion.com/reference/query-a-data-source), [search par titre](https://developers.notion.com/reference/post-search).
- [Blocs et parents](https://developers.notion.com/reference/block), [get bloc](https://developers.notion.com/reference/retrieve-a-block), [propriété](https://developers.notion.com/reference/retrieve-a-page-property), [get source](https://developers.notion.com/reference/retrieve-a-data-source).

## Vérification reproductible

Avec les dépendances verrouillées du projet :

```powershell
node node_modules/vitest/vitest.mjs run src/connectors test/mcp/connectors.process.test.ts test/mcp/notion.process.test.ts test/mcp/notion.integration.test.ts test/mcp/surface.process.test.ts --maxWorkers=1
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/eslint/bin/eslint.js src/connectors/notion services/mcp/notion-tools.ts test/fixtures/notion/server.ts test/mcp/notion.process.test.ts
```

Les preuves réellement exécutées et les dépendances de reprise figurent dans
`output/connecteurs-revue-integration/verification.json` et `RESULTAT.md`.
