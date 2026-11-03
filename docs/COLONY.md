# The Colony dans Wake

Le MCP MIND expose `colony_list_tools` (catalogue et schémas, paginés) et
`colony_call_tool` (appel d'un outil du catalogue) lorsque la connexion du profil
est activée. Le second outil peut publier ou supprimer selon l'opération choisie :
ses annotations sont conservatrices. Les autorisations du propriétaire restent
nécessaires pour les actions externes ; connecter le compte ne délègue pas une
publication. Les résultats sont étiquetés comme contenu externe non fiable.

Le catalogue renvoie dix résumés par défaut : `query` filtre les noms/descriptions,
`offset` et `limit` parcourent les résultats, `include_schemas: true` fournit les
schémas complets des outils sélectionnés. `nextCursor`, s'il est présent, concerne
une autre page du serveur distant. Les erreurs métier distantes gardent `isError`.

La connexion est lue dans `MIND_WAKE_DATA_DIR/colony.json`, ou dans le chemin
explicite `MIND_COLONY_CONFIG_FILE`, sans repli vers un autre profil :

```json
{ "version": 1, "enabled": true, "apiKey": "<clé du compte col_…>", "syncReplies": true }
```

Ce fichier contient un secret : le conserver hors dépôt, dans le profil local,
avec des permissions limitées au propriétaire. Ne pas le copier dans la mémoire,
les prompts ou les logs. Aucun JWT n'est persisté. Le client échange la clé à
`https://thecolony.ai/api/v1/auth/token`, conserve le JWT en mémoire et le renouvelle
avant expiration (24 h au maximum, ou l'expiration plus courte annoncée).
Le transport MCP renouvelle aussi le JWT après un 401 avant son unique nouvelle
tentative. Il ne rejoue pas automatiquement les autres erreurs de publication.

La connexion MCP distante est paresseuse : un forum inaccessible n'empêche pas le
MCP MIND de démarrer. Redémarrer la connexion MCP MIND du client pour charger les
nouveaux outils ou activer/désactiver le fichier. Les sessions déjà ouvertes ne
reçoivent pas automatiquement un nouveau catalogue.

## Réponses dans le fil Wake

`syncReplies: true` active le collecteur et l'outil `colony_sync_inbox`.
Il vérifie les notifications chaque minute tant que Wake et sa policy sont actifs,
et importe commentaires sur nos posts, réponses et mentions comme messages reçus
de **The Colony**, avec l'auteur, l'extrait disponible et un lien vers la réponse.
Un extrait tronqué est signalé. Les DM, votes et abonnements ne sont pas importés.
Le premier passage importe aussi les réponses non lues déjà en attente ; il
repère les anciennes notifications lues sans les ajouter au fil.

Une base `colony-inbox.sqlite` du profil conserve la déduplication, les curseurs
et un verrou partagé entre processus MCP. Deux notifications du même commentaire
ne produisent qu'un message. Le délai d'une minute et les `Retry-After` des lectures
sont partagés entre clients et survivent aux redémarrages. La pagination REST est
reprise par lots de trois pages de cent ; les curseurs par offset restent soumis
aux suppressions/réordonnancements du serveur distant.

Pause, Force-off et arrêt bloquent la collecte ; le contrôle est répété après les
requêtes en vol, avant l'import. Les messages empruntent la boîte de réception
existante : ils apparaissent dans la conversation et peuvent être remis au runtime
par son mécanisme normal. Ils ne deviennent jamais des ordres du propriétaire.
Aucune publication, réponse automatique codée ici ou opération de marquage comme lu
n'est effectuée sur Colony. Le code du collecteur n'active ni Wake ni une session.

Vérification locale : tests du cycle JWT dans `test/mcp/colony.test.ts`, import,
arrêt, déduplication, pagination et throttle dans `test/mcp/colony-inbox.test.ts`.
Une recette réelle doit démarrer le MCP MIND avec le bon profil, lister ses outils,
appeler `colony_list_tools`, puis appeler un outil distant de lecture avec son
schéma réel. Un catalogue seul ne prouve pas une lecture authentifiée réussie.

Référence du service : <https://thecolony.ai/connect-agent>.

Recette réelle du 3 novembre 2026 : cinq notifications non lues ont été importées
dans le profil `mind-wake-essai`, avec provenance Colony et liens de commentaires.
La projection de conversation les retrouve ; quatre avaient déjà un reçu de remise
au runtime lors du contrôle immédiat. Cela atteste la remise, pas leur lecture ou
une réponse de l'agent. Aucun nouveau message externe n'a été envoyé pour la recette.
