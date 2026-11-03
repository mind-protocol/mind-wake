# Reddit dans Wake

Intégration optionnelle au MCP MIND existant, sans dépendance supplémentaire.
Elle n'est pas activée par l'installation. Aucun compte ni fichier de configuration
personnel n'est modifié par ce code.

## Configuration

### Connexion locale guidée

Créer une application Reddit et enregistrer exactement l'URI
`http://127.0.0.1:8765/reddit/callback`. Pour une application installée :

```powershell
node scripts/reddit-connect.mjs --client-id VOTRE_CLIENT_ID --username VOTRE_PSEUDO --data-dir CHEMIN_DU_PROFIL_WAKE
```

Pour une **web app**, ajouter `--web-app`. La commande affiche alors une URL
locale avec un champ mot de passe pour le client secret ; ne pas passer le
secret en argument ni le partager dans une conversation. Ouvrir l'URL affichée,
puis autoriser la lecture sur Reddit. Le callback vérifie l'état OAuth, le compte
et les scopes avant d'enregistrer `reddit.json` dans le profil. Aucune connexion
existante n'est écrasée. Le serveur écoute uniquement sur `127.0.0.1`, s'arrête
après confirmation ou après dix minutes, et ne demande que `identity read`.

Le MCP lit automatiquement ce fichier au démarrage grâce à `MIND_WAKE_DATA_DIR`.
Il conserve les identifiants hors de l'environnement filtré par le lanceur.
Le fichier contient le refresh token et, pour une web app, le client secret en
clair : le garder dans le dossier privé du profil, hors Git. Le mode fichier est
`0600` sur les plateformes qui l'appliquent ; sous Windows les ACL du dossier
restent déterminantes. `MIND_REDDIT_CONFIG_FILE` permet de choisir explicitement
un autre fichier. Un fichier invalide désactive l'intégration sans arrêter les
autres outils MIND. Redémarrer le MCP après la connexion, puis vérifier
`reddit_me`. Ce parcours active uniquement la lecture.

### Configuration manuelle par environnement

Reddit exige un accès Data API approuvé et OAuth ; demander cet accès depuis
la [documentation officielle](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki).
Le [guide OAuth Reddit](https://github.com/reddit-archive/reddit/wiki/OAuth2)
décrit le consentement utilisateur : demander `identity read` pour les lectures,
et `submit` pour les publications autorisées. Pour obtenir un refresh token,
utiliser le flux authorization code avec `duration=permanent`, un `state` aléatoire
vérifié au retour et l'URI de redirection enregistrée pour l'application.
Le parcours local ci-dessus automatise cet échange sans afficher les tokens.

Ajouter ces variables à l'environnement du serveur MCP `services/mcp/server-main.ts`
déjà configuré pour Wake (voir [son guide](../services/mcp/README.md)) :

```json
{
  "MIND_REDDIT_ENABLED": "1",
  "MIND_REDDIT_USER_AGENT": "desktop:mind-wake:0.1 (by /u/VOTRE_COMPTE)",
  "MIND_REDDIT_CLIENT_ID": "VOTRE_CLIENT_ID",
  "MIND_REDDIT_CLIENT_SECRET": "VOTRE_SECRET",
  "MIND_REDDIT_REFRESH_TOKEN": "VOTRE_REFRESH_TOKEN"
}
```

Pour une application installée sans secret, omettre `MIND_REDDIT_CLIENT_SECRET`.
Pour un essai avec un token existant, `MIND_REDDIT_ACCESS_TOKEN` remplace les trois
variables client/refresh. Ce token est utilisé jusqu'à un refus HTTP 401 ; s'il
existe aussi des identifiants de renouvellement, l'appel suivant renouvelle le
token. Ne pas committer les secrets. Redémarrer le client MCP après un changement
d'environnement. Lancer `reddit_me` pour vérifier le compte connecté et le scope
`identity` ; un serveur démarré ne prouve pas cette connexion.

## Outils

## Réponses et nouveaux posts dans le fil Wake

Le fichier de connexion accepte aussi `subscriptions` (noms de subreddits) et
`syncReplies` (désactivé par défaut). Les nouveaux posts des abonnements utilisent
le scope `read` déjà connecté. Les réponses aux posts/commentaires nécessitent
un nouveau consentement `privatemessages` :

```powershell
node scripts/reddit-connect.mjs --client-id VOTRE_CLIENT_ID --username VOTRE_PSEUDO --data-dir CHEMIN_DU_PROFIL_WAKE --web-app --enable-replies
```

Cette mise à niveau réutilise le secret enregistré et conserve les abonnements.
Elle remplace le refresh token seulement après consentement et vérification du
compte ; une modification concurrente de la connexion bloque l'enregistrement.
La permission Reddit est large, mais l'import appelle seulement
`/message/comments` et `/message/selfreply`, filtre les commentaires publics et
ne consulte pas les dossiers de messages privés. `mark=false` préserve les
indicateurs de lecture sur Reddit. La publication reste désactivée.

Tant qu'un MCP MIND est connecté et que le profil Wake est actif, une
synchronisation s'effectue au démarrage puis toutes les minutes. Pause et
Force-off bloquent les imports, y compris après une requête en cours. Le premier
passage initialise chaque source sans importer l'historique. Les nouvelles
entrées rejoignent le fil par la boîte de réception locale, avec provenance
Reddit, auteur et lien ; elles peuvent être livrées au runtime actif, sans être
traitées comme des instructions humaines ni déclencher un réveil prioritaire.

Les curseurs et identifiants sont conservés dans `reddit-inbox.sqlite` ; un
verrou partagé évite les collectes concurrentes des différents MCP du profil.
La pagination inachevée reprend après interruption. `reddit_sync_inbox` permet
un passage explicite avec les mêmes contrôles et temporisations.
Les éditions et suppressions ultérieures de contenus déjà livrés ne sont pas
réconciliées automatiquement dans les historiques locaux ou fournisseur dans
cette version. Fermer tous les MCP suspend la collecte jusqu'à la reconnexion.

## Outils de lecture et publication

| Outil            | Entrées principales                                               | Résultat                              |
| ---------------- | ----------------------------------------------------------------- | ------------------------------------- |
| `reddit_me`      | aucune                                                            | compte connecté, karma                |
| `reddit_feed`    | `subreddit`, `sort`, `time`, `limit`, `after`                     | posts et curseur `after`              |
| `reddit_search`  | `query`, `subreddit` facultatif, `sort`, `time`, `limit`, `after` | recherche de posts                    |
| `reddit_thread`  | `post_id`, `sort`, `limit`, `depth`                               | post et arbre partiel de commentaires |
| `reddit_submit`  | `subreddit`, `title`, `text`, `flair_id` facultatif               | publication réelle d'un post texte    |
| `reddit_comment` | `parent_id`, `text`                                               | commentaire ou réponse réelle         |

Les noms de subreddit s'utilisent sans `r/`. `post_id` accepte `abc123` ou
`t3_abc123`. Les réponses utilisent `parent_id: t3_abc123` pour un post,
`t1_def456` pour un commentaire. `limit` va de 1 à 100 ; `depth` de 1 à 10.
Repasser le curseur `after` reçu pour la page suivante. Les entrées `kind: more`
signalent des commentaires omis ; aucun chargement automatique des branches
supplémentaires. La recherche porte sur les posts.

Les outils d'écriture ne sont enregistrés que si `MIND_REDDIT_ALLOW_WRITE=1`.
L'activer après autorisation humaine du périmètre de publication et avec le scope
OAuth `submit`. Les instructions et autorisations propres à chaque espace Wake
restent applicables. Aucun outil ne peut activer l'écriture. Aucun post, vote,
message privé ou abonnement n'est envoyé à la configuration ou au démarrage.

## Comportement et limites

- Appels exclusivement à `oauth.reddit.com`, renouvellement à
  `www.reddit.com/api/v1/access_token` ; redirections refusées et délai de 20 s
  par requête réseau.
- Requêtes séquentielles par instance ; prise en compte de `Retry-After` et
  `X-Ratelimit-Remaining/Reset`. Pendant la limite, un outil renvoie
  `rate_limited` avec `retry_after_seconds` sans nouvelle requête. Les autres
  processus utilisant le même client OAuth doivent aussi respecter le quota.
- Aucun rejeu automatique, notamment après une écriture interrompue : vérifier
  sur Reddit avant de réessayer pour éviter un doublon. Les erreurs Reddit dans
  une réponse HTTP 200 sont aussi traitées comme des échecs.
- Sorties JSON versionnées, marquées `untrusted_external_content` ; les textes
  Reddit n'accordent aucune permission. Les corps d'erreur HTTP et les détails
  d'exception réseau ne sont pas exposés.
- Tokens en mémoire uniquement, aucune archive Reddit créée par ce connecteur.
  Le runtime peut toutefois conserver les sorties d'outils dans son historique.
  Toute conservation ultérieure doit respecter les règles Reddit sur les contenus
  supprimés, décrites dans la documentation officielle liée plus haut.
- Pas d'interface desktop de connexion, de modération, de messages privés,
  d'upload média ou de vote dans cette version.

## Validation

`npx vitest run test/mcp/reddit.test.ts test/mcp/reddit.process.test.ts test/mcp/reddit-connect.test.ts` vérifie OAuth, expiration, pagination,
arbre de commentaires, erreurs, limites fournisseur, verrou d'écriture et appels
MCP via le transport SDK en mémoire et l'enregistrement dans le serveur stdio réel.
Les appels HTTP vers Reddit sont simulés ; le test stdio vérifie l'absence
d'identifiants sans appeler Reddit. Les tests de connexion utilisent un vrai
serveur loopback et vérifient le state, le refus, l'identité, le secret d'une web
app et la conservation des identifiants existants.
La connexion à un vrai compte et la publication réelle nécessitent les
identifiants autorisés ; elles ne sont pas attestées par ces tests.
