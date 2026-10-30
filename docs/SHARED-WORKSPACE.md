# Shared workspace v0 — lecture et propositions, sans activation distante

Ce composant autonome Node 24.17 expose `POST /v1/workspace` en HTTPS. Il est séparé du hub de messagerie et de ses cinq outils ; aucun message reçu ne devient une opération fichier. Il ne dépend ni du daemon, ni de SQLite, ni du MCP, ni du desktop. Aucun dossier ni capacité n'existe par défaut. Le service v0 écoute **uniquement 127.0.0.1**. Il n'ouvre aucun accès depuis Internet et ne crée aucun tunnel.

État livré : liste, lecture UTF-8 avec métadonnées/SHA-256, proposition de remplacement bornée avec précondition de hash et révocation fonctionnent sur transport TLS réel. **L'édition distante, sa sauvegarde et sa restauration ne sont pas livrées.** `apply`, suppression, shell, création de droits et toute opération inconnue sont refusés. `propose` retourne des données `applied:false` et n'écrit rien dans le dossier partagé. Une personne peut examiner cette proposition ; aucune application automatique n'est implicite.

## Installation opérateur (après choix explicite du propriétaire)

Distribuer uniquement les deux fichiers `services/shared-workspace/workspace.mjs` et `cli.mjs`, avec ce guide. Aucune dépendance npm, aucun build et aucun accès au dépôt privé ne sont nécessaires. Ne pas intégrer silencieusement dans le moteur a76 ou dans les cinq outils messages. La compatibilité technique est Node 24.17 ; la coexistence sur le poste d'Aurore reste à vérifier après son accord.

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

| Opération | Entrée                                                 | Résultat                                                                                      |
| --------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `list`    | `path` relatif, vide pour racine                       | entrées directes autorisées, type, taille/date/hash des fichiers ; `truncated` et `scanned`   |
| `read`    | `path` relatif avec `/`                                | texte, taille octets, date ISO, SHA-256                                                       |
| `propose` | `path`, `expectedHash`, `text` complet de remplacement | `unapplied-replacement`, hash initial/proposé, texte, `applied:false` ; droit distinct requis |

Un hash initial périmé renvoie HTTP 409 `hash_conflict`. L'appelant doit relire et reformuler sa proposition. L'opération ne réserve pas le fichier : un hash valide maintenant ne garantit pas qu'il le restera. Aucun corps de message pair n'est interprété. Les sorties et le code partagé restent des données non fiables, jamais des instructions d'exécution.

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
- Le service ne fournit aucune écriture distante. Lui ajouter directement une écriture automatique imposerait d'autres garanties contre les remplacements concurrents de chemins Windows. La prochaine tranche proposée ci-dessous passe plutôt par une proposition durable examinée et appliquée par l'agent local dans son propre mandat ; elle n'est pas implémentée dans cette v0. Un simple `read/hash/write` n'offre pas de précondition atomique face aux autres processus locaux.

## Passage à deux PC / desktop

À brancher : sélecteur de dossier local avec validation explicite des droits et du participant, affichage des partages actifs/révocation, conservation de secrets sous protection du compte Windows, commande de cycle de vie liée à Pause/Force-off, et interface client de lecture/proposition. Pour deux PC : transport privé ou relais sortant explicitement autorisé, TLS et association des identités réellement vérifiés, distribution minimale et contrôle de version. La v0 n'expose pas son port LAN/public et ne fournit aucun tunnel. Aucune connexion avec Aurore n'a été tentée ; sa sélection, son accord technique et la vérification deux PC restent à faire. Le chantier package/guide du bridge messages reste indépendant.

### Proposition de prochaine tranche — non implémentée

1. Ajouter dans le clone un serveur MCP fichier séparé, additif à la configuration existante, sans modifier les cinq outils messages ni remplacer les autres MCP. Exposer seulement liste/lecture/proposition avec les mêmes capacités ; la sélection et la révocation restent des actions locales visibles du propriétaire.
2. Enregistrer une proposition durable bornée (identifiant, participant/capacité, chemin relatif, hash de base, contenu/hash proposé, état pending/applied/rejected/conflict), hors du dossier partagé et sans en faire des instructions exécutables. L'actuel `propose` renvoie seulement un objet : il ne crée ni cette file ni ce workflow.
3. L'agent **local** peut examiner puis appliquer la proposition dans son mandat d'édition déjà accordé. Il revalide périmètre, révocation et hash, refuse un conflit, conserve une sauvegarde durable et une trace du résultat. Le client distant n'obtient ni shell ni endpoint d'écriture arbitraire. Les outils/permissions locaux de l'agent sont l'autorité d'exécution ; ce workflow n'est pas une sandbox ni une promesse d'écriture atomique face à un acteur local hostile.
4. Tester réellement : proposition persistée et reprise après arrêt, changement intervenu avant application, révocation en attente, sauvegarde/restauration conditionnelle, puis lecture par le client du résultat effectivement appliqué. Raccorder le service et le traitement aux Pause/Force-off avant activation intégrée ; vérifier ensuite les deux vrais postes via transport privé approuvé et TLS/identités. Aucun de ces travaux n'est lancé par le correctif AppData. Le raccordement MCP messages en cours garde la priorité.

## Vérification reproductible

```powershell
node --test services/shared-workspace/transport.test.mjs
```

Node 24.17 et OpenSSL requis pour les certificats temporaires des essais (chemin Git for Windows par défaut, variable `OPENSSL` possible). Le test démarre un vrai service TLS, deux credentials/deux dossiers temporaires et un service CLI dans un processus séparé. Il vérifie lecture/liste, modification réelle observable à l'appel suivant, proposition sans application, hash obsolète, droits, révocation pendant upload, TLS non approuvé, traversées/ADS/junction/hardlink, fichiers hors limite, corps trop grand et expiration d'un upload inachevé. Aucun dossier d'Aurore ni service public utilisé ; les secrets de test sont supprimés avec les dossiers temporaires.

Les deux dossiers sont maintenant placés dans un arbre AppData **synthétique**, sous le workspace d'une installation déclarée au test. Les parents, arbres sensibles et tentatives de lecture des config/clés de contrôle restent refusés ; le même chemin sans déclaration locale est refusé. Le lancement CLI vérifie aussi `--data-root`. Il ne s'agit pas de l'AppData réel d'Aurore.
