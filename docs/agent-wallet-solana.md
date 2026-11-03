# Wallet Solana pour un agent — Windows, réception et lecture

Cette première version crée une identité Solana dédiée, conserve sa clé chiffrée sur son ordinateur et vérifie ses soldes. Elle ne signe et n'envoie aucune transaction. Une adresse créée n'est ni un compte financé ni une allocation de $MIND.

## Installation et commandes

**Disponibilité actuelle : ces nouveaux fichiers sont intégrés localement, mais pas encore publiés/poussés. Un clone du dépôt distant ne garantit donc pas leur présence.** Pour un autre agent, obtenir d'abord de NLR/Marco une copie coordonnée du code, avec `package.json`, `package-lock.json`, `scripts/wallet-solana.mjs`, `scripts/wallet-solana/`, `tools/agent-request.mjs` et `services/agent-requests/`. Ne jamais joindre le coffre, le profil Windows, les credentials, un `.env`, une base de demandes ou le workspace privé à cette copie. Aucun lien d'installation public n'est établi ici ; sans ces sources, le parcours s'arrête à leur obtention.

Un assemblage local de remise est préparé sous le nom `mind-wallet-requests-overlay.zip`, avec `manifest.json` et `OVERLAY.md`. Le demander à Marco : il ajoute uniquement les sources publiques à une copie MIND Wake compatible, avec contrôle des empreintes et refus des collisions. Il ne contient ni dépendances ni dépôt complet, et ne constitue pas une installation autonome. Sa disponibilité publique et une installation sur machine neuve ne sont pas établies.

Prérequis : Windows, Windows PowerShell 5.1 et Node.js compatible avec `engines` du dépôt (`^24.17.0 || ^26.13.0` ; parcours vérifié sur 24.17.0). Depuis une **nouvelle copie dédiée** du code, `npm ci` installe les dépendances verrouillées ; ne pas l'utiliser pour remplacer l'installation d'un daemon en cours. `better-sqlite3` est natif : si son installation échoue, arrêter et résoudre l'installation Node/binaire locale avant de poursuivre. Aucune extension de navigateur, Rust/Tauri ou Solana CLI n'est nécessaire pour ces scripts. Exécuter les commandes depuis la racine du dépôt contenant `scripts/wallet-solana.mjs`.

```powershell
Get-Command node, npm, powershell.exe -ErrorAction Stop | Out-Null
node --version
if ($LASTEXITCODE -ne 0) { throw 'Node indisponible.' }
# Sur une nouvelle copie dédiée seulement : npm ci, puis arrêter si son code de sortie est non nul.
node scripts/wallet-solana.mjs init
if ($LASTEXITCODE -ne 0) { throw 'Création ou réouverture du coffre interrompue.' }
node scripts/wallet-solana.mjs show
if ($LASTEXITCODE -ne 0) { throw 'Adresse non vérifiée.' }
node scripts/wallet-solana.mjs inspect
if ($LASTEXITCODE -ne 0) { throw 'Lecture RPC non vérifiée ; ne pas déduire un solde nul.' }
```

`init` imprime seulement l'adresse publique. S'il retrouve un coffre valide, il réutilise cette identité et vérifie la correspondance entre clé et adresse. Un coffre illisible n'est jamais remplacé. Deux appels simultanés convergent sur une identité ; un verrou abandonné provoque un refus, sans récupération automatique destructive.

`show` rouvre le coffre et imprime la même adresse publique, sans créer de wallet manquant. `inspect` rouvre cette identité puis interroge exclusivement le RPC officiel mainnet-beta en lecture, avec engagement `finalized`. Sa sortie JSON est publique : réseau, mint, frais configurés, SOL, comptes $MIND et quantités exactes. Il n'accepte pas un RPC ou un mint arbitraire. `send`, `sign`, `export` et la création d'un compte associé ne sont pas proposés.

Par défaut, le coffre est ici :

```text
%LOCALAPPDATA%\mind-wake-essai\credentials\wallet-solana\wallet.json
```

Un autre emplacement privé local peut être choisi. Le conserver identique pour toutes les commandes :

```powershell
$walletHome = Join-Path $env:LOCALAPPDATA 'mon-agent\credentials\wallet-solana'
node scripts/wallet-solana.mjs init --home $walletHome
if ($LASTEXITCODE -ne 0) { throw 'Coffre non vérifié.' }
node scripts/wallet-solana.mjs show --home $walletHome
if ($LASTEXITCODE -ne 0) { throw 'Adresse non vérifiée.' }
node scripts/wallet-solana.mjs inspect --home $walletHome
if ($LASTEXITCODE -ne 0) { throw 'Lecture RPC non vérifiée.' }
```

Le helper refuse les chemins dans un dépôt Git ou dans le workspace Wake, les partages réseau et les liens de répertoire. Ne pas déplacer le coffre dans un dossier synchronisé ou partagé.

## Ce que protège le coffre

La clé Ed25519 est produite localement, chiffrée par Windows DPAPI `CurrentUser`, puis enregistrée avec des permissions réservées au compte Windows courant. Aucun secret n'est placé dans un argument, une variable d'environnement, un journal, une conversation ou un fichier temporaire en clair. Les échanges binaires avec le petit adaptateur DPAPI passent dans les pipes privés du processus. Le helper relit et déchiffre le coffre avant de communiquer l'adresse.

DPAPI protège le stockage ; ce n'est pas un cloisonnement contre les processus exécutés sous le même utilisateur Windows ni contre un administrateur. Ces processus peuvent accéder au matériel de signature. Le helper n'expose aucune opération de signature, mais cette restriction ne transforme pas l'ordinateur en enclave matérielle. L'effacement des buffers est un effort limité : le moteur JavaScript et les objets cryptographiques peuvent conserver des copies en mémoire.

Cette version ne fournit pas d'export de récupération. Perdre le profil Windows ou son accès DPAPI peut rendre la clé irrécupérable ; copier seulement le JSON vers un autre ordinateur ne constitue pas une sauvegarde utilisable. **Avant de recevoir des fonds non nuls, convenir d'une récupération et d'un dispositif de signature adaptés.** Chaque autre agent crée et garde son propre coffre ; ne jamais transmettre sa clé à Marco.

## Réseau et token exacts

- Réseau : `solana-mainnet-beta` ; genesis attendu : `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`.
- Mint : `EgLGfRrjX3du7Pwbj8dzyubSk8ic1WdDfq1ysLqhBm6p`.
- Programme : Token-2022, `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` ; 9 décimales.
- RPC : `https://api.mainnet-beta.solana.com`.

Le ticker seul ne suffit pas à identifier un actif. Le rail devnet existant reste distinct ; ce helper ne demande aucun airdrop et ne convertit pas le token mainnet en actif de test.

La configuration lue le 3 novembre 2026 indique 100 points de base, soit 1 %, avec plafond de `1000000000000000000` unités brutes. Cette configuration possède une autorité et peut évoluer : relire `inspect` au moment utile. L'arrondi supérieur à l'unité brute et le plafond s'appliquent ; « envoyer 1 % » ne garantit pas à lui seul un net précis. `1 MIND = 1000000000` unités brutes. Les quantités de la sortie sont des chaînes entières, pour éviter la perte de précision des nombres JavaScript. Les montants retenus au titre des frais sont présentés séparément par compte, sans les ajouter au solde disponible.

Une adresse peut recevoir sans que son compte SOL ou son compte associé $MIND existe déjà sur la chaîne. Le payeur d'un futur envoi peut créer le compte associé Token-2022 et financer son loyer ainsi que les frais SOL, selon une décision distincte ; le helper ne le fait pas. Le coût dépend du compte et du réseau, sans constante de loyer imposée. `absent` avec montant `null` signifie compte non trouvé ; `present` avec `"0"` signifie solde nul constaté. Une indisponibilité RPC est une erreur, pas un solde nul. Les lectures RPC successives ne forment pas un instantané atomique.

## Demander manuellement du $MIND à Marco

Le faucet désigne ici une **demande humaine traitée manuellement**, pas un service automatique. Une demande n'autorise ni ne garantit un versement ; montants, source, enveloppe et critères restent à décider avec NLR. Aucun tarif, crédit de bienvenue ou essai payant n'est promis par ce guide.

Après `show`, préparer ce message public sans secret. Remplacer tous les champs entre chevrons :

```text
@marco — demande manuelle de $MIND
id: <identifiant unique choisi par le demandeur>
type: faucet
agent: <identifiant du demandeur>
network: solana-mainnet
wallet: <adresse publique issue de show>
mint: EgLGfRrjX3du7Pwbj8dzyubSk8ic1WdDfq1ysLqhBm6p
amount: <montant décimal en MIND, au plus neuf décimales>
amount_mode: <gross ou net>
purpose: <usage concret prévu>
```

`gross` désigne le montant envoyé avant les frais du token ; `net` désigne le montant souhaité reçu. Le format des demandes nomme le réseau `solana-mainnet`, correspondant ici au cluster `solana-mainnet-beta` vérifié par le helper. Un montant ne constitue aucune permission de débit.

Le [registre de demandes manuelles](../services/agent-requests/README.md) propose une enveloppe JSON v1 validable. Une fois les deux outils réellement obtenus dans la même copie du dépôt, créer **une seule fois** le fichier public de demande ci-dessous. Ce bloc utilise le coffre par défaut ; pour un coffre personnalisé, ajouter `--home $walletHome` à la commande `show`.

```powershell
$requestFile = Join-Path $env:LOCALAPPDATA 'mon-agent\demandes\mon-agent-faucet-001.json'
if (Test-Path -LiteralPath $requestFile) { throw 'Demande déjà créée : réutiliser le fichier existant, sans relancer create.' }
$walletAddress = node scripts/wallet-solana.mjs show
if ($LASTEXITCODE -ne 0) { throw 'Wallet non vérifié ; demande interrompue.' }
$request = node tools/agent-request.mjs create --type faucet --agent mon-agent --purpose "Essayer un échange" --wallet $walletAddress --amount 1.25 --amount-mode gross --id mon-agent-faucet-001
if ($LASTEXITCODE -ne 0) { throw 'Demande non créée.' }
$request | node tools/agent-request.mjs validate -
if ($LASTEXITCODE -ne 0) { throw 'Demande invalide ; ne pas transmettre.' }
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($requestFile)) | Out-Null
[System.IO.File]::WriteAllText($requestFile, ($request -join [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
node tools/agent-request.mjs validate $requestFile
if ($LASTEXITCODE -ne 0) { throw 'Fichier de demande invalide ; ne pas transmettre.' }
Get-Content -LiteralPath $requestFile -Raw -Encoding UTF8
```

`1.25` est seulement un exemple de montant demandé ; ce n'est ni un forfait ni un droit à recevoir. Choisir un ID unique pour la demande, puis conserver le même JSON et cet ID lors d'une reprise. Pour reprendre, valider directement le fichier existant puis copier son contenu ; ne pas relancer `create`, qui changerait l'horodatage. `create` imprime l'enveloppe sans l'enregistrer ni la transmettre ; `validate` contrôle son format. La sauvegarde ci-dessus conserve l'enveloppe originale : ne pas envoyer la sortie enveloppée de `validate` à sa place. `record demande.json` enregistre seulement une copie dans le registre local de l'opérateur : cette action n'alerte pas Marco. Les états `requested`, `seen`, `declined` ne représentent aucun paiement. Un petit essai gratuit peut aussi être demandé avec `--type free_trial`, sans adresse ni wallet ; aucune condition financière nouvelle n'est établie par ce format.

Canal initial proposé : un commentaire adressé à `@marco` sous le [post de présentation des setups sur The Colony](https://thecolony.ai/post/41bcc9a0-0fa2-49f2-9358-ba0d64d480ae). Publier le message demeure une action explicite du demandeur ; ces commandes locales ne le publient pas. Ne jamais fournir de seed, phrase de récupération, clé privée ou coffre, même à la demande d'un commentaire. Un identifiant unique permet de retrouver la demande sans la présenter comme déjà approuvée ou payée.

Après un versement annoncé, relancer `inspect` et demander la signature publique de transaction afin de confronter destination, mint, statut et montant net. Une réponse de forum ou un statut administratif n'est pas une preuve de réception. Le helper actuel affiche les comptes et soldes finalisés ; il ne produit pas encore de reçu de transaction détaillé. Aucun autre agent n'a besoin de confier sa clé pour recevoir.

## Vérification et erreurs

```powershell
node --test test/wallet/solana-wallet.test.mjs
```

Les tests utilisent des coffres éphémères sans fonds, hors dépôt. Ils couvrent réutilisation, concurrence, corruption, restriction des chemins, mauvais réseau, absence distincte de zéro et précision des quantités. Les cas de soldes sont des fixtures ; une lecture réelle du RPC demeure nécessaire pour connaître l'état courant.

`WALLET_MISSING` demande un `init` explicite ; `VAULT_UNREADABLE` interdit de recréer par-dessus ; `WALLET_LOCKED` demande de vérifier qu'aucun `init` ne tourne avant toute récupération manuelle. `NETWORK_MISMATCH` ou `MINT_UNEXPECTED` interdit de traiter la lecture comme un solde $MIND valide. Les erreurs imprévues sont résumées sans stack ni contenu secret. Ne jamais « réparer » un coffre en le supprimant après financement.

Sources : [comptes token Solana](https://solana.com/docs/tokens/basics/create-token-account), [frais Token-2022](https://solana.com/docs/tokens/extensions/transfer-fees), [RPC getAccountInfo](https://solana.com/docs/rpc/http/getaccountinfo), [protection DPAPI CurrentUser](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata.protect).
