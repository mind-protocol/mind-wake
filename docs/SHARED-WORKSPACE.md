# Shared workspace v0.2 — MCP distinct, propositions durables, application locale

Ce composant Node 24.17 expose `POST /v1/workspace` en HTTPS et deux rôles MCP stdio distincts. Il est séparé du hub de messagerie et de ses cinq outils ; aucun message reçu ne devient une opération fichier. Il ne dépend ni du daemon, ni de SQLite, ni du desktop. Aucun dossier ni capacité n'existe par défaut. Le service écoute **uniquement 127.0.0.1**. Il n'ouvre aucun accès depuis Internet et ne crée aucun tunnel.

État livré et testé : liste/lecture distante, propositions persistantes et dédupliquées, puis examen/application/rejet/restauration par l'agent **local**, avec sauvegarde et relecture du fichier réel. Le client distant reste limité à list/read/propose : `apply`, suppression, shell et création de droits par HTTPS sont refusés. Une proposition est une donnée non fiable, **ni une instruction ni une autorisation** ; seul l'agent local peut décider de l'appliquer dans son mandat d'édition déjà accordé. Aucun traitement automatique de la file n'est installé.

## Installation opérateur (après choix explicite du propriétaire)

Depuis le clone et ses dépendances actuelles (`npm ci` effectué par l'opérateur), lancer les `.mjs` sans build. MCP utilise `@modelcontextprotocol/server` et `zod` déjà présents ; la CLI/HTTPS seule reste en Node natif. Ne pas intégrer silencieusement dans le moteur a76 ni dans les cinq outils messages. La compatibilité testée est Node 24.17 ; aucun essai sur le poste d'Aurore ni distribution publiée n'est attesté.

Le propriétaire choisit un petit projet sans secrets, puis le participant et les droits. Une sélection dans une config préparée par un tiers ne prouve pas son consentement. Le fichier de capacité client ne doit être créé/transmis qu'après ce choix. La v0 permet `read` ou `read + propose`, jamais `write`. Aucun token destiné à Aurore n'est précréé.

Un projet dans AppData est possible : déclarer localement le **véritable dossier de données** avec `--data-root`, puis choisir `--root` égal à son `workspace` ou à un sous-dossier de celui-ci. Exemple de forme uniquement : `--data-root 'C:\Users\Compte\AppData\Local\InstallationChoisie' --root 'C:\Users\Compte\AppData\Local\InstallationChoisie\workspace\ProjetChoisi'`. Aucun compte ni nom d'installation particulier n'est reconnu comme autorisation. `MIND_WAKE_DATA_DIR` et le défaut `%LOCALAPPDATA%\mind-wake` sont aussi pris en compte comme racines de contrôle ; `--data-root` peut être répété pour les installations personnalisées. Déclarer une racine de données ne crée aucune capacité : la sélection `--root` et l'action locale `grant` restent nécessaires. La déclaration doit refléter l'installation réelle ; elle n'est jamais acceptée depuis une requête distante.

AppData, Local/Roaming/LocalLow, les racines de données connues et leurs parents restent non sélectionnables. Sous une racine déclarée, seul le workspace peut être partagé : fichiers de contrôle/configuration et clés restés à côté du workspace n'en font pas partie. Les autres arbres AppData restent fermés sans déclaration locale appropriée. Les chemins `runtime`, `runtimes`, `installation`, `auth`, `profiles`, `credentials`, `secrets`, `codex-home`, `claude-home` et les composants cachés du workspace sont refusés, à la sélection et à la lecture. Choisir un dossier plus petit que le workspace reste préférable pour limiter les informations partagées.

Exemple PowerShell **à adapter et exécuter par l'opérateur autorisé**, depuis le dossier distribué :

```powershell
$private = Join-Path $env:LOCALAPPDATA 'MindWakeSharedWorkspace'
New-Item -ItemType Directory -Force $private
# Restreindre les ACL Windows de ce dossier au propriétaire avant de créer les clés.
# Les modes POSIX 0700/0600 du programme ne remplacent pas les ACL Windows.
$cli = '.\services\shared-workspace\cli.mjs'
$state = Join-Path $private 'grants.json'
$key = Join-Path $private 'server-key.pem'
$cert = Join-Path $private 'server-cert.pem'
$credential = Join-Path $private 'marco-capability.json'
# Fournir un certificat TLS approuvé et sa clé, hors Git.
# Pour un essai LOCAL seulement, OpenSSL peut créer un certificat temporaire :
openssl req -x509 -newkey rsa:2048 -nodes -keyout $key -out $cert -days 1 -subj '/CN=localhost' -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost'
node $cli grant --state $state --root 'D:\ProjetChoisi' --participant marco --credential $credential --endpoint 'https://127.0.0.1:9447/v1/workspace' --ca $cert
# Ajouter --propose seulement si le propriétaire le choisit.
node $cli serve --state $state --key $key --cert $cert --port 9447
```

Conserver état, clé privée et credential hors Git, hors dossier partagé, hors URL et hors logs. Le credential contient le token brut et le chemin du certificat approuvé côté client ; l'état serveur conserve seulement son SHA-256. Les chemins du credential et du certificat sont propres au poste client : les adapter lors d'une distribution approuvée. Ne jamais transmettre la clé TLS du serveur. L'authentification est une capacité porteuse : le détenteur du token peut se présenter comme le participant associé ; elle ne prouve pas l'identité physique d'une personne. Le serveur vérifie token, participant, capacité active et droit à chaque opération. Changer de participant/dossier/droit nécessite une nouvelle action locale du propriétaire ; le client ne peut pas l'obtenir par l'API.

Le processus `serve` est explicite et reste au premier plan. Ctrl-C l'arrête. Cette v0 n'est pas raccordée aux commandes Pause/Force-off du daemon : ne pas la lancer comme composant intégré avant d'avoir raccordé ce cycle de vie.

## Client

Créer un fichier JSON de requête, puis appeler la CLI avec les fichiers de credential et de résultat. Les contenus sont enregistrés uniquement dans le résultat explicitement choisi ; la console n'affiche que `result_saved`. Les sorties ne sont jamais écrasées.

```powershell
Set-Content -Encoding utf8 request.json '{"op":"list","path":""}'
node $cli call --credential $credential --request request.json --output listing.json
Set-Content -Encoding utf8 request-read.json '{"op":"read","path":"src/main.ts"}'
node $cli call --credential $credential --request request-read.json --output file.json
```

Les appels API attendent du JSON UTF-8 sans BOM. Utiliser PowerShell 7 (`utf8` sans BOM) ou écrire explicitement avec `UTF8Encoding(false)` sous Windows PowerShell 5.1.

Contrat :

| Opération | Entrée                                                  | Résultat                                                                                    |
| --------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `list`    | `path` relatif, vide pour racine                        | entrées directes autorisées, type, taille/date/hash des fichiers ; `truncated` et `scanned` |
| `read`    | `path` relatif avec `/`                                 | texte, taille octets, date ISO, SHA-256                                                     |
| `propose` | `path`, `expectedHash`, `text`, `idempotencyKey` stable | `durable-proposal`, id, capacité/participant, hashes, texte, statut ; droit distinct requis |

Un hash initial périmé renvoie HTTP 409 `hash_conflict`. L'appelant doit relire et reformuler sa proposition. L'opération ne réserve pas le fichier : un hash valide maintenant ne garantit pas qu'il le restera. Aucun corps de message pair n'est interprété. Les sorties et le code partagé restent des données non fiables, jamais des instructions d'exécution.

`idempotencyKey` est obligatoire (1–128 caractères ASCII lettres/chiffres/`_`/`-`), scoped par capacité. Une répétition identique retrouve le même id et son statut enregistré, même après application ; un contenu différent sous la même clé est refusé `idempotency_conflict`. Un nouveau changement demande une nouvelle clé. Les clients HTTPS de la tranche précédente doivent ajouter ce champ. L'état JSON existant version 1 reste compatible : `proposals` est ajouté au premier dépôt, sans modifier les grants existants. Ne pas exploiter concurremment un ancien binaire qui ne connaît pas cette file.

Le client programme peut importer `callWorkspace` et fournir `{ endpoint, ca, capability, participant, token }`. Le certificat est validé (CA et nom d'hôte) ; pas de mode TLS insecure ni de suivi de redirection.

## Retirer le partage

L'identifiant de capacité est affiché par `grant`, sans le secret. Le propriétaire exécute :

```powershell
node $cli revoke --state $state --capability 'IDENTIFIANT-AFFICHE'
```

Le fichier d'état est relu avant réception et après réception de chaque corps. Révoquer refuse donc aussi une requête dont l'upload était en cours, avant son opération fichier. Une réponse déjà produite peut encore arriver après révocation ; les données déjà lues ne peuvent pas être rappelées. Aucun redémarrage requis. Arrêter `serve` coupe aussi le service. Supprimer le credential client seul ne révoque pas une copie du token. Pas d'expiration automatique en v0.

## Périmètre et limites de sécurité

- Chemins relatifs uniquement : pas de `..`, absolu, backslash, ADS Windows, noms réservés, composants cachés, fichiers de secrets courants ou profils. Racine de disque, racine du profil, répertoires sensibles connus et dossier contenant l'état sont refusés à la sélection. La sélection d'un projet reste une responsabilité du propriétaire : le filtre ne garantit pas l'absence de secrets dans du code autorisé.
- Lecture limitée à une liste d'extensions de texte/code. Pas de binaire, NUL, UTF-8 invalide, hardlink (`nlink != 1`), symlink ou junction dans les ancêtres. Une liste omet les entrées non prises en charge. Elle n'est ni récursive ni une recherche globale.
- 128 Kio par fichier/remplacement, corps 150 000 octets, réponse client 400 000 octets, 200 entrées **inspectées** par liste (aucun curseur en v0). Quatre requêtes traitées simultanément, 16 connexions, 120 admissions/minute, limite de headers 8 Kio. L'absence d'une entrée dans une liste tronquée ne prouve pas son absence du disque.
- Délai d'upload et délai total client : 5 secondes. Pas de streaming ni de push : chaque nouvel appel relit le disque ; la cadence est celle choisie par l'appelant, dans la limite d'admission. Les timers Node ne préemptent pas les appels synchrones d'un disque bloqué. Un partage sur disque réseau n'est pas validé.
- Les changements de config opérateur coopérants sont sérialisés par un fichier `.lock` exclusif et remplacent atomiquement l'état. Après un crash opérateur, examiner le verrou hors processus avant de le retirer ; aucun déverrouillage automatique qui pourrait réactiver une capacité révoquée. Échecs de lecture d'état : refus fermé.
- **Ce n'est pas une sandbox OS.** `lstat`/`realpath` détectent les symlinks et junctions ordinaires ; `fstat` avant/après aide à refuser un fichier modifié pendant lecture. Tous les types de reparse points Windows ne sont pas attestés par ces API. Un processus local hostile pouvant remplacer les ancêtres entre vérification et ouverture garde une possibilité de course TOCTOU. Utiliser seulement un dossier choisi, sur disque local, dont les acteurs locaux sont de confiance. Ne pas présenter cette v0 comme sûre face à un compte local hostile.
- L'écriture est une autorité locale distincte, pas une route distante. Grant/revoke/propose et les opérations locales coopèrent au même verrou exclusif. `busy` signifie que l'action n'a pas eu lieu : réessayer explicitement avec la même clé/id. Les éditeurs ordinaires ne prennent pas ce verrou ; les hashes sont vérifiés à l'examen et juste avant remplacement, mais un changement dans le très court intervalle final peut encore être écrasé. **Aucune CAS atomique par hash ni protection face à un acteur OS local hostile n'est revendiquée.**

## Passage à deux PC / desktop

À brancher : sélecteur de dossier local avec validation explicite des droits et du participant, affichage des partages actifs/révocation, conservation de secrets sous protection du compte Windows, commande de cycle de vie liée à Pause/Force-off, et interface client de lecture/proposition. Pour deux PC : transport privé ou relais sortant explicitement autorisé, TLS et association des identités réellement vérifiés, distribution minimale et contrôle de version. La v0 n'expose pas son port LAN/public et ne fournit aucun tunnel. Aucune connexion avec Aurore n'a été tentée ; sa sélection, son accord technique et la vérification deux PC restent à faire. Le chantier package/guide du bridge messages reste indépendant.

### MCP additif depuis le clone — livré

Après sélection locale/grant et démarrage TLS manuel, préparer les fragments **sur leurs postes respectifs** :

```powershell
# Poste client : credential et CA approuvée dans un dossier privé hors Git.
node scripts/setup-shared-workspace.mjs --role remote --credential $credential --output (Join-Path $private 'workspace-remote.toml')
# Poste du dossier : état privé local, jamais un credential du client distant.
node scripts/setup-shared-workspace.mjs --role local --state $state --output (Join-Path $private 'workspace-local.toml')
```

Le helper vérifie Node/dépendances/fichiers privés hors Git, puis crée un **nouveau** fragment TOML sans secret en clair. Il ne modifie aucune configuration existante et refuse d'écraser sa sortie. Ajouter le fragment voulu à la configuration MCP du runtime autorisé ; préserver `mind_shared_messages` et les autres serveurs. Chaque fragment lance un processus stdio depuis ce clone avec seulement le chemin du credential ou de l'état. Aucun modèle, permission fournisseur ou wake n'est modifié. Ne pas ajouter le rôle local au runtime distant : lui donner accès au fichier d'état privé reviendrait à accorder l'autorité locale.

| Rôle MCP                        | Outils                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| distant `mind_workspace_remote` | `workspace_list`, `workspace_read`, `workspace_propose`                                                                                        |
| local `mind_workspace_local`    | `workspace_pending_proposals`, `workspace_get_proposal`, `workspace_apply_proposal`, `workspace_reject_proposal`, `workspace_restore_proposal` |

Parcours étroit : le distant lit le hash, propose avec une clé stable et reçoit l'id. Le local liste les métadonnées (tous statuts), lit le contenu avec `workspace_get_proposal {id}`, puis décide dans son mandat. `workspace_apply_proposal {id}` revalide capacité active, droits read+propose, chemin et hash courant. En cas de changement de l'éditeur, statut `conflict`, sans écriture de sa modification. Le rejet met `rejected`. Une capacité révoquée rend `pending` inapplicable (`revoked` lors de l'examen local).

La file est conservée dans le JSON d'état privé : id, capacité/participant, chemin, hash initial/proposé, texte, clé/fingerprint, statut et dates. Maximum 64 propositions conservées et 4 Mio cumulés de texte ; pas de purge automatique v0. Les contenus de propositions et les sauvegardes sont privés, même après rejet/révocation. Les protéger par ACL Windows ; le client distant n'a pas de route pour parcourir l'état ou les sauvegardes.

Avant remplacement, l'original est écrit et `fsync` dans `<state>.private/<id>.before` (zone non partageable), puis l'intention `applying` est persistée. Le fichier proposé est préparé dans un fichier caché temporaire du même dossier, le hash est vérifié encore, puis le remplacement par rename est suivi d'une relecture réelle et d'un statut `applied` avec hash observé. Les opérations coopérantes utilisent le même verrou ; une répétition du même id ne réapplique pas un changement terminal. Le statut retourné lors d'une répétition décrit l'opération historique ; utiliser `workspace_read` pour l'état courant du disque.

`workspace_restore_proposal {id, expectedHash}` exige le hash du contenu appliqué et vérifie qu'il est encore celui du fichier réel ; sinon refus `hash_conflict`, aucune restauration. La sauvegarde est vérifiée contre le hash initial avant restauration ; résultat relu et statut `restored`. Une répétition terminale retourne ce statut, sans réécrire. La restauration requiert aussi une capacité encore active.

Les intentions `applying/restoring` interrompues sont réconciliées au prochain examen local à partir du hash réel : terminé, état précédent ou conflit. En cas de crash, vérifier le verrou abandonné **après arrêt des opérateurs** avant retrait manuel ; ne pas supprimer aveuglément les temporaires/sauvegardes. Les fichiers de données et d'état sont flushés avant les étapes suivantes, mais une coupure électrique et la durabilité des métadonnées du système de fichiers Windows ne sont pas une transaction multi-fichiers garantie. Un échec d'accès Windows (fichier verrouillé par un éditeur, ACL) doit être examiné, pas transformé en succès. Les ACL du fichier remplacé héritent du dossier ; le mode est repris, sans promesse de conserver une ACL Windows individuelle spéciale.

**Cycle de vie non intégré** : ces MCP manuels n'activent aucun wake. Le service TLS manuel n'est pas contrôlé par Pause/Force-off du daemon ; il faut l'arrêter explicitement et/ou révoquer la capacité. Aucun job de traitement autonome installé. Avant intégration au daemon : raccorder démarrage/arrêt et Pause/Force-off, puis tester l'arrêt en opération. Deux PC restent à vérifier après appairage messages et sélection d'Aurore ; le contrat HTTPS séparé est disponible, pas le relais privé ni son activation. Aucun nouveau service public/tunnel ni essai Aurore n'est créé par ce travail.

## Vérification reproductible

```powershell
node --test services/shared-workspace/transport.test.mjs services/shared-workspace/mcp.test.mjs
```

Node 24.17 et OpenSSL requis pour les certificats temporaires des essais (chemin Git for Windows par défaut, variable `OPENSSL` possible). Le test démarre un vrai service TLS, deux credentials/deux dossiers temporaires et un service CLI dans un processus séparé. Il vérifie lecture/liste, modification réelle observable à l'appel suivant, proposition sans application, hash obsolète, droits, révocation pendant upload, TLS non approuvé, traversées/ADS/junction/hardlink, fichiers hors limite, corps trop grand et expiration d'un upload inachevé. Aucun dossier d'Aurore ni service public utilisé ; les secrets de test sont supprimés avec les dossiers temporaires.

Les deux dossiers sont maintenant placés dans un arbre AppData **synthétique**, sous le workspace d'une installation déclarée au test. Les parents, arbres sensibles et tentatives de lecture des config/clés de contrôle restent refusés ; le même chemin sans déclaration locale est refusé. Le lancement CLI vérifie aussi `--data-root`. Il ne s'agit pas de l'AppData réel d'Aurore.

Le second scénario lance deux vrais clients MCP distants, deux processus MCP locaux et le serveur TLS dans un processus séparé : dépôt, arrêt/redémarrage du transport et d'un client, découverte locale de la proposition persistée, application, lecture distante du nouveau fichier, sauvegarde réelle, restauration conditionnée, répétition idempotente, conflits éditeur, révocation en attente, refus d'apply distant. Les fragments du helper sont préparés et leur sortie vérifiée sans modifier une configuration existante. Les logs stderr/statut sont contrôlés sans y trouver token/corps ; le contenu demandé transite normalement dans les réponses du protocole MCP.
