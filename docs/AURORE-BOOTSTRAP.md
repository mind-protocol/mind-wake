# Orchestration locale cible/client

Depuis le clone intégré et approuvé, une commande lit un plan privé **local** :

```powershell
node --experimental-transform-types --disable-warning=ExperimentalWarning --import ./test/fixtures/store-ledger/ts-hooks.ts scripts/aurore-bootstrap.mjs --plan C:/LOCAL_OWNER/WakePrivate/target-plan.json
# Après revue du dryrun par l'opérateur qui a choisi le plan :
node --experimental-transform-types --disable-warning=ExperimentalWarning --import ./test/fixtures/store-ledger/ts-hooks.ts scripts/aurore-bootstrap.mjs --plan C:/LOCAL_OWNER/WakePrivate/target-plan.json --apply
```

Même commande avec le plan `role: client`, puis `--apply --probe` pour installer
la section MCP scoped et exécuter list/read. Aucun shell/URL transmis par un pair
n'est interprété. Le plan n'accepte pas de commande arbitraire. Le dryrun écrit
uniquement son JSON sur stdout ; il n'ouvre aucune connexion réseau, ne lance pas
de job et ne crée ni journal, ni répertoire, ni candidat. Ses commandes locales
de lecture vérifient Node, Git, les modules/policy et éventuellement Cargo.

## Première exécution par le propriétaire cible

1. Disposer d'une **installation locale existante**, avec manifeste version 1,
   profil/identités/pairing conservés, Node compatible et clone contenant les
   composants filesystem et maintenance intégrés. Le bootstrap n'appelle jamais
   `init`, `prepareInstallation`, `setup --apply`, login ou Windows autostart.
   Si le manifeste manque, terminer d'abord l'installation locale officielle
   depuis la version approuvée avec `scripts/setup.mjs --apply --no-open` et les
   chemins locaux choisis ; ce parcours peut nécessiter la connexion du
   propriétaire. `install-wake.ps1` pointant sur l'archive 20261029 et refusant une
   destination existante n'est pas l'installateur de cette livraison.
2. Choisir la release Git complète et sa source approuvée. Le mécanisme existant
   `checkUpdate(expectedRevision,beforeStep)` récupère/build la release dans le
   répertoire de transaction ; une révision différente est refusée. Source HTTPS
   sans credential dans l'URL, ou dépôt Git **local déjà présent** (chemin absolu,
   branche vérifiée sans réseau pendant le préflight). Aucun téléchargement
   d'archive binaire n'est inventé. Une archive approuvée doit d'abord être installée
   par le mécanisme officiel correspondant, puis donner un manifeste existant.
   Pour une nouvelle build, npm doit être présent à côté du Node du manifeste et
   Cargo doit être opérationnel dans l'environnement de l'opérateur. Le build réel
   peut consulter les fournisseurs habituels du lockfile ; aucun fallback payant.
3. Préparer le répertoire privé hors Git, hors tous les scopes et avec les ACL du
   compte propriétaire, ainsi qu'un répertoire `bootstrap-transactions` existant.
   Aucun secret n'est mis dans le plan : uniquement des chemins vers les fichiers
   privés locaux. Aucun choix ou mémoire de NLR n'est transféré.
4. La connexion privée TLS **existe déjà**. Fournir IP littérale privée, certificat
   valide pour cette IP et clé correspondante ; aucun tunnel, DNS, firewall ou
   transport n'est créé. Le client fournit sa CA approuvée. Pour la maintenance,
   le binding utilise le hub privé `/v1/messages` déjà autorisé et la confiance
   TLS normale du runtime existant (par exemple CA déjà installée ou
   `NODE_EXTRA_CA_CERTS` déjà autorisé). La CLI ne change pas cette confiance.
5. Préparer le grant avec le CLI filesystem existant, sous l'autorité locale du
   propriétaire. Choisir explicitement racine, scope, participant et droits ;
   aucune permission ne vient du template. Si ce grant existe déjà, le conserver.
   Exemple de forme, avec variables **choisies localement**, sans valeurs NLR :

   ```powershell
   node services/shared-workspace/cli.mjs scope-grant --state $state --root $root --data-root $dataDir --name $scope --participant $participant --rights $rights --credential $credential --endpoint $endpoint --ca $ca
   ```

   Créer le fichier serveur local selon le schéma existant :
   `{stateFile,keyFile,certFile,host,port}`. Garder les trois fichiers privés hors
   Git et hors scopes. `host` est l'IP privée choisie, `port` le port TLS choisi.
   `list,read` suffisent à la sonde. Le bootstrap vérifie un grant actif qui
   correspond exactement aux racine/participant/scope/droits du plan ; il ne crée
   ni n'élargit ce grant. Le `workspace/jobs` de cette installation doit exister.

6. Préparer les fichiers maintenance avec le schéma final existant : policy
   `{target,sharedEndpoint,grants:[{actor,actions}],releases:{releaseId:{revision}}}`,
   binding `{endpoint,key}`. `target`/`actor` sont les refs réellement obtenues
   par `whoami` sur ce hub, jamais des identités devinées. La policy doit contenir
   la release approuvée ; les grants appartiennent au propriétaire cible.
   Le contrôleur vérifie son identité au hub à l'exécution. Le préflight valide
   le schéma par `readMaintenancePolicy` sans ouvrir SQLite ni contacter le hub.
   `storeFile` est un fichier local privé existant ou futur dans un parent existant.
7. Copier le [plan cible](aurore-bootstrap.target.example.json) **hors Git**,
   adapter tous les chemins/valeurs, puis passer les deux approbations à `true`
   seulement après choix local. Calculer le hash du manifeste :

   ```powershell
   (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant()
   ```

   En cas de job déjà présent, ajouter `filesystem.existingJobSha256` avec son hash
   après revue. Aucun fichier de job existant n'est remplacé sans ce hash explicite.
   Lancer le dryrun puis `--apply`. Toute entrée changée depuis le préflight arrête
   l'opération. Si le manifeste a changé depuis la rédaction du plan, relire sa
   nouvelle version avant d'actualiser son hash.

## Activation et preuves

Le JSON d'apply contient le chemin `transaction` et un `supervisedStart` également
écrit dans `supervised-start.json` de cette transaction. Soumettre **sur le MCP Wake
local de la cible** les champs `tool: start_background_job` et `arguments` tels
qu'ils sont produits. Cette CLI ne dispose pas du client MCP Wake authentifié de
l'opérateur ; elle laisse donc `needs_supervised_start`. Aucun enfant détaché,
remplaçant de daemon ou intégrateur concurrent n'est lancé.

Vérifier `list_background_jobs`, puis le `scoped-ready.json` du run retourné.
`queued` ne signifie pas `listening`. Pause, Force-off et annulation du job restent
les contrôles existants. Le job préparé importe le helper de la release retenue.

Le champ `desktop` donne l'exécutable et le tableau d'arguments exacts pour lancer
le **superviseur existant au premier plan**, par le propriétaire local, sans
`--startup`. Fermer normalement l'ancienne app si nécessaire ; la CLI ne tue aucun
PID et ne reprend jamais Wake. Dans PowerShell, charger `supervised-start.json`,
puis :

```powershell
$start = Get-Content -LiteralPath $startArtifact -Raw | ConvertFrom-Json
$desktopArgs = @($start.desktop.args)
& $start.desktop.command @desktopArgs
```

Le superviseur lit `manifest.maintenance`. La maintenance n'est active qu'après
ce démarrage ; le manifeste seul reste `configured`. Les capacités du superviseur
actuel sont diagnose/relaunch_app/reinstall selon ses contrôles et la policy.
Le raccord `owned-runtime` ajoute relaunch_engine/relaunch_mcp seulement pour les
membres réellement possédés par leurs lanceurs. Un daemon/MCP externe reste hors
de cette autorité ; leurs versions peuvent rester unknown sans receipt valide.
Une source locale de bootstrap ne fournit pas d'update distant : ce superviseur
exige une source HTTPS approuvée pour reinstall. La policy peut être plus étroite.

`maintenanceProbe` contient l'appel exact `request_maintenance` pour diagnose de
la release, et le nom `get_maintenance_result` à appeler avec le même requestId.
Il n'est pas envoyé par la CLI. Après cinq minutes, régénérer les trois champs
temporels localement avant de soumettre :

```powershell
$start.maintenanceProbe.arguments.requestId = [guid]::NewGuid().ToString()
$start.maintenanceProbe.arguments.issuedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$start.maintenanceProbe.arguments.expiresAt = [DateTime]::UtcNow.AddMinutes(5).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$start.maintenanceProbe.arguments | ConvertTo-Json
```

Le sender réellement connecté doit avoir le grant local diagnose. Un reçu du
relais n'est pas la confirmation du contrôleur. Exiger l'observation fraîche et
`versionComparison.app: matches` après un vrai startup receipt ; ne pas substituer
le HEAD, un hash du disque ou une révision de manifeste à cette preuve.

## Client puis reprise

Le destinataire installe uniquement **son** credential/CA déjà autorisés, adapte
`caFile` dans son credential local et copie le [plan client](aurore-bootstrap.client.example.json)
hors Git. Son manifeste et son `config.toml` existant sont requis. Calculer leurs
hashes comme ci-dessus ; choisir scope, participant et fichier texte relatif de
sonde, puis `operatorApproved: true`. Lancer la même commande en dryrun, puis
`--apply --probe`. Le helper produit le candidat à partir des octets existants ;
la transaction remplace par CAS uniquement le fichier natif choisi. Une collision
`mind_workspace_scoped` est refusée, pas fusionnée arbitrairement.

Ouvrir une nouvelle session native : découvrir les sept outils scoped et vérifier
que les autres serveurs sont présents ; appeler `workspace_list {"path":""}` et
`workspace_read {"path":"LE_FICHIER_CHOISI"}`. L'apply ne prétend pas avoir rechargé
le runtime natif existant. `--probe` prouve TLS + liste/lecture du seul endpoint,
pas l'identité physique d'Aurore. Le contenu lu n'est pas journalisé.

Si le serveur n'était pas encore démarré, la configuration reste installée avec un
diagnostic d'échec et exit code 1. Reprendre **sans réappliquer la config** :

```powershell
node services/shared-workspace/cli.mjs scope-diagnose --credential $credential --scope $scope --probe $probe
```

## Rollback limité

```powershell
node scripts/aurore-bootstrap.mjs --rollback C:/LOCAL_OWNER/WakePrivate/bootstrap-transactions/bootstrap-ID
```

Le journal durable conserve hash avant/après et sauvegardes privées. Chaque
restauration vérifie le hash courant ; un changement ultérieur est conservé et
signalé `rollback_conflict`. Les fichiers nouveaux sont retirés seulement s'ils
correspondent encore exactement au hash écrit. Les répertoires de transaction,
releases/cache/build/logs restent pour audit ; aucun nettoyage, révocation de grant
ou arrêt de processus n'est caché dans ce rollback. Annuler le job exact ou fermer
le superviseur via ses contrôles avant d'annuler une activation déjà effectuée.

Les vérifications de hash sont faites immédiatement avant rename atomique, comme
dans le filesystem existant ; elles ne sont pas une primitive CAS atomique de
l'OS face à un éditeur qui écrit dans l'intervalle final. Les fichiers redirigés,
symlinks/hardlinks ordinaires et ancêtres redirigés sont refusés. Les ACL locales
restent nécessaires ; le workspace n'est pas une sandbox OS.

Les états JSON gardent `prepared`, `configured`, `listening`, `loadedVersion` et
`reading` séparés. `installation.source` distingue `clean_source`, `buildWIP`,
`source_revision_differs` et `source_unattested`. Même un build propre n'atteste pas
une version chargée. Cette livraison n'a activé aucun vrai profil ni contacté
Aurore ; la revue/intégration/publication et la recette live restent au principal.

## Workspace Git actif, indépendamment de l'app (v2)

Le propriétaire cible copie `docs/aurore-bootstrap.workspace.example.json` dans
son dossier privé, hors du workspace Git et des scopes partagés. Il désigne le
**workspace actif déjà existant**, pas le clone de l'app. L'origine exacte prévue
pour Aurore est `https://github.com/mind-protocol/scisense-aurore-workspace.git`.
Les deux approbations restent false dans l'exemple ; le propriétaire choisit les
chemins, vérifie l'origine et approuve le commit complet correspondant aux
instructions `352dd86`. Ce préfixe seul n'est pas accepté comme révision.

Relever localement l'origine et le HEAD actuel, sans modifier le dépôt :

```powershell
git -C C:/LOCAL_OWNER/ACTIVE_AURORE_WORKSPACE remote get-url origin
git -C C:/LOCAL_OWNER/ACTIVE_AURORE_WORKSPACE rev-parse HEAD
```

Placer ce HEAD complet dans `workspace.expectedHead`, le commit approuvé complet
dans `workspace.expectedRevision`, et approuver le plan après sa revue locale.
Créer au préalable le répertoire privé `transactionRoot`. Même commande unique :

```powershell
node scripts/aurore-bootstrap.mjs --plan C:/LOCAL_OWNER/WakePrivate/workspace-plan.json
node scripts/aurore-bootstrap.mjs --plan C:/LOCAL_OWNER/WakePrivate/workspace-plan.json --apply
```

Le rôle `workspace` n'exige ni upgrade de l'app ni changement du manifeste. Le
même objet `workspace` peut être ajouté à un plan `target` pour exécuter sa mise
à jour avant l'updater, après le préflight complet des deux parties. Il n'est pas
permis dans un plan `client`. Aucun réglage de synchronisation automatique n'est
créé ou activé. Le verrou `.git/mind-wake-workspace-sync.lock` est partagé avec
la synchronisation 60 secondes existante ; une opération en cours est refusée,
sans enlever son verrou ni arrêter son propriétaire.

Le dryrun ne fait aucun fetch. Si l'objet approuvé n'est pas encore local, la
vérification d'ascendance et des chemins nouveaux termine après le fetch sous
`--apply`, avant toute modification des fichiers de travail. Le fetch porte sur
l'origine exacte approuvée et le commit complet, sans écrire FETCH_HEAD ni
changer les branches de suivi. Puis `git merge --ff-only --no-autostash` applique
ce commit sur la branche existante. Aucun push, reset, clean, stash, changement
de branche ou modification globale de Git. Un chemin d'origine absolu est aussi
accepté pour les fixtures et sources locales explicitement approuvées.

Le préflight refuse les changements suivis, même sans conflit apparent, les
substitutions d'objets Git (`refs/replace` sont neutralisées),
historiques divergents, les HEAD détachés, worktrees liés, index masqués, filtres
de checkout, symlinks/submodules et origines réécrites. Il laisse les fichiers
non suivis ou ignorés en place et refuse toute collision, y compris ignorée.
Les changements upstream de `artifacts/PERSONALITY.md`, `memory/`, `memories/`,
`relations/`, `artifacts/memory/`, `artifacts/relations/` et `AUTORISATIONS.json`
sont refusés, sauf le consentement exact décrit ci-dessous pour PERSONALITY.
Les instructions suivies propres, comme AGENTS.md, peuvent être
actualisées par le fast-forward approuvé ; toute version locale modifiée doit
être réconciliée localement avant de réessayer, sans action destructive suggérée.

Les sauvegardes privées des seuls chemins touchés et l'intention sont persistées
avant merge. Le rollback existant prend le même verrou, vérifie HEAD, branche,
index, fichiers suivis et empreinte des fichiers non suivis, puis utilise un
checkout Git à deux arbres et `update-ref` avec comparaison du commit attendu.
Il restaure les octets sauvegardés, sans reset ni nettoyage du workspace. Tout
changement concurrent est conservé et signalé ; les objets Git récupérés, reflogs
et répertoires vides restent pour audit. Une interruption entre merge et journal
final exige une revue locale et ne déclenche pas de restauration aveugle. Ces
gardes ne prétendent pas rendre Git et rename atomiques face à un éditeur hostile
qui écrit entre la dernière comparaison et l'opération.

Le JSON distingue `workspaceRevision`, `sourceRevision`, `installation` et
`loadedVersion`. Un rôle workspace laisse `sourceRevision: not_updated` et les
versions chargées inconnues. Le même plan rejoué sur la révision déjà présente
donne `already_current` sans fetch. Un autre HEAD inattendu est refusé.
`workspace.nextWake.state: needs_next_wake_proof` reste ouvert. Le propriétaire
utilise ensuite le réveil permis par ses contrôles Wake, puis vérifie dans le
runtime réellement lancé le workspace actif, la révision et le chargement de
son `artifacts/PERSONALITY.md`. Aucun pull ou relaunch de l'app seul ne prouve le
prompt actif ; ce bootstrap n'invente ni wake, ni receipt, ni réponse owner.

### Consentement local borné pour les instructions personnelles

L'objet optionnel `workspace.ownerInstructions` de l'exemple est volontairement
invalide tant que le propriétaire ne l'a pas rempli et approuvé après lecture
locale des deux versions. Le supprimer si aucune mise à jour de PERSONALITY
n'est demandée. Il ne donne aucune autorisation sur mémoire, relations ou
AUTORISATIONS, ni sur un autre chemin, une casse différente ou un fichier ajouté.

Le propriétaire obtient d'abord localement les objets approuvés par son canal
Git autorisé si nécessaire. Pour chacun des deux commits complets déjà vérifiés :

```powershell
git -C C:/LOCAL_OWNER/ACTIVE_AURORE_WORKSPACE show FULL_COMMIT:artifacts/PERSONALITY.md
git -C C:/LOCAL_OWNER/ACTIVE_AURORE_WORKSPACE rev-parse FULL_COMMIT:artifacts/PERSONALITY.md
```

Lire les deux contenus, puis relever le SHA-256 des octets bruts de chaque blob
(sans conversion de fin de ligne par un pipeline texte PowerShell). Par exemple,
commande Node locale avec COMMIT et ROOT choisis explicitement :

```javascript
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const bytes = execFileSync("git", [
  "-C",
  ROOT,
  "cat-file",
  "blob",
  COMMIT + ":artifacts/PERSONALITY.md",
]);
console.log(createHash("sha256").update(bytes).digest("hex"));
```

Renseigner `beforeRevision/afterRevision` égaux à `expectedHead/expectedRevision`,
les deux blobs Git et leurs SHA-256, puis choisir
`approvedAfterLocalReview: true` seulement après cette lecture et acceptation
locale. L'approbation générale du plan ne remplace pas ce choix spécifique.
Le préflight vérifie le blob initial et les octets locaux avant fetch ; il
vérifie aussi la cible dès qu'elle est disponible, avant merge. Sans exception,
un changement de PERSONALITY est refusé avant merge (et dès le préflight si
l'objet est déjà local). Le dryrun reste sans fetch ni écriture.

Seuls deux fichiers Git réguliers mode 100644 au chemin exact sont acceptés.
Un contenu local personnalisé, même commité, une autre révision ou empreinte
exige une réconciliation et une nouvelle revue locale ; aucun forçage ni fusion
rédactionnelle. Le même plan reste idempotent à la cible exacte. Sauvegarde et
rollback gardent leurs comparaisons concurrentes, y compris pour PERSONALITY.
Le prochain réveil et sa lecture effective restent à prouver séparément.
