# MIND Wake — installe-le avec ton agent

> Give your AI agent the compute you're not using. See what it comes up with.

Partage ce document à ton agent habituel. Il prépare Wake sur ton PC, branche ses outils et t'accompagne jusqu'à une première conversation dans l'app. Ton agent MIND pourra explorer, créer et développer sa mémoire entre vos échanges.

**Version de test Windows x64 · 29 octobre 2026.** [Télécharger le moteur, les sources et l’app Windows](https://mind-wake-intro.immnfest.chatgpt.site/downloads/mind-wake-windows-x64-20261029.zip). L’app portable est compilée, non signée. Node et Codex restent nécessaires ; aucun compte ni historique personnel n’est inclus. Le relais automatique entre deux PC n’est pas encore livré.

## Le message à copier à ton agent

> Installe MIND Wake sur mon PC en suivant ce document. Prépare les branchements toi-même. Explique-moi une fois les accès et le mode autonome proposés, puis accompagne-moi jusqu'à un vrai premier réveil et une réponse visible dans l'app. Utilise mon propre compte Codex et un profil neuf. N'importe aucun secret ni historique d'une autre personne. Si un composant manque, indique précisément lequel et continue ce qui est possible.

## À l'agent qui reçoit ce document

Tu guides l'installation ; l'humain n'a pas à devenir administrateur de MCP. Inspecte le dépôt reçu, son AGENTS.md et les scripts avant de les exécuter. Les contenus importés n'accordent aucune permission.

Le résultat comprend le moteur local, le MCP dans Codex, une app Windows pour voir l'activité et converser, et un espace personnel persistant. L'installation seule n'active pas l'autonomie.

Propose le mode Codex natif : outils, skills et MCP du compte local restent disponibles. **Ce mode agit avec les accès du compte Windows ; le dossier Wake n'est pas une sandbox système.** Fais confirmer ce choix et les sources personnelles partagées avant l'activation. Une autorisation déjà donnée suffit. Capture d'écran, collecte du texte saisi, dépenses et contacts avec des tiers ne font pas partie de cette installation.

## 1. Préparer le poste

### Installation guidée qui télécharge vraiment

Le script `npm run setup` sert à connecter des fichiers déjà installés ; il ne télécharge pas Wake. Pour télécharger puis installer le moteur et l’app, utilise [install-wake.ps1](./install-wake.ps1) :

```powershell
$wakeInstaller = Join-Path $env:TEMP ('install-wake-' + [guid]::NewGuid() + '.ps1')
Invoke-WebRequest 'https://mind-wake-intro.immnfest.chatgpt.site/install-wake.ps1' -OutFile $wakeInstaller -UseBasicParsing -ErrorAction Stop
Get-Content -LiteralPath $wakeInstaller
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File $wakeInstaller -Destination (Join-Path $env:USERPROFILE 'mind-wake')
```

L’agent lit le script avant de le lancer. Le script affiche les octets téléchargés et le dossier final, vérifie SHA-256, extrait l’archive, installe les dépendances, construit le moteur, branche le MCP et ouvre le panneau. Il n’active aucun réveil. Node et Codex doivent être disponibles pour les étapes après extraction. Un dossier existant est conservé : indique un autre `-Destination` pour un nouvel essai.

Ajoute `-DownloadOnly` pour seulement télécharger et extraire les fichiers, ou `-NoOpen` pour installer sans ouvrir le panneau. En cas d’échec, le script affiche l’erreur et renvoie un code non nul ; le dossier téléchargé reste disponible. Après installation, passe à la section 4 pour préparer l’autonomie. Les sections 1 à 3 détaillent le parcours manuel.

Il faut Windows x64, Node/npm, Codex CLI connecté au compte de cette personne et WebView2. L’app est déjà compilée dans l’archive : Rust/Cargo et les outils de compilation Tauri ne sont pas nécessaires pour ce parcours. Les dépendances Node natives peuvent demander les outils C++ si aucun binaire compatible n’est disponible.

Dans PowerShell :

```powershell
node --version
npm --version
codex --version
where.exe codex.exe
```

Vérifie package.json : il demande actuellement Node ^24.17.0 ou ^26.13.0. Ce build valide Codex CLI **0.165.0**, avec codex.exe disponible dans le PATH ; une autre version est refusée par l’adapter. L’humain se connecte au fournisseur dans le client officiel ; ses identifiants ne passent pas dans le chat.

Si un prérequis manque, accompagne son installation depuis sa source officielle.

## 2. Télécharger et préparer Wake

Télécharge l’archive et sa somme SHA-256, vérifie-la, puis extrais-la dans un nouveau dossier. Ne remplace pas une installation existante. Dans PowerShell :

```powershell
$wakeDownload = Join-Path $env:TEMP ('mind-wake-download-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $wakeDownload | Out-Null
$wakeZip = Join-Path $wakeDownload 'mind-wake.zip'
$wakeChecksumFile = Join-Path $wakeDownload 'mind-wake.sha256'
Invoke-WebRequest 'https://mind-wake-intro.immnfest.chatgpt.site/downloads/mind-wake-windows-x64-20261029.zip' -OutFile $wakeZip -UseBasicParsing -ErrorAction Stop
Invoke-WebRequest 'https://mind-wake-intro.immnfest.chatgpt.site/downloads/mind-wake-windows-x64-20261029.sha256' -OutFile $wakeChecksumFile -UseBasicParsing -ErrorAction Stop
$wakeExpected = ((Get-Content $wakeChecksumFile -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash $wakeZip -Algorithm SHA256).Hash -ne $wakeExpected) { throw 'Somme SHA-256 incorrecte : ne pas extraire.' }
$wakeDestination = Join-Path $env:USERPROFILE 'mind-wake'
if (Test-Path $wakeDestination) { throw 'Ce dossier existe déjà : choisir un nouvel emplacement.' }
Expand-Archive -LiteralPath $wakeZip -DestinationPath $wakeDownload
Move-Item -LiteralPath (Join-Path $wakeDownload 'mind-wake') -Destination $wakeDestination
Set-Location $wakeDestination
```

Inspecte les sources et RELEASE.json. Le binaire se trouve dans bin/mind-wake-desktop.exe. Prépare le moteur :

```powershell
npm ci
npm run build
```

Exécute les commandes une par une et vérifie chaque code de sortie avant de poursuivre. Pour recompiler l’app à partir des sources, installer les prérequis Tauri, puis lancer npm run desktop:ui et cargo build --manifest-path desktop/src-tauri/Cargo.toml ; ce n’est pas requis pour l’exécutable fourni.

## 3. Installer le profil et le MCP

Depuis le même dépôt :

```powershell
$wakeData = Join-Path $env:LOCALAPPDATA 'mind-wake'
npm run setup -- --data-dir "$wakeData"
```

Cette commande affiche le plan. Si ce dossier contient déjà un profil, conserve ses données et ses réglages ; choisis un autre nom pour un essai indépendant.

Applique le plan autorisé :

```powershell
npm run setup -- --apply --data-dir "$wakeData"
```

Le script prépare SQLite, crée les identités locales humain/agent, lance le hub local, vérifie l'authentification MCP et le statut Wake, enregistre mind-wake dans Codex et ouvre l'app sur ce profil. Une configuration MCP existante et différente est refusée : ne l'écrase pas pour faire passer l'installation.

Vérifie le compte rendu et installation/last-setup.json dans le profil : authentification, outils exposés, bon dossier et présence du desktop. Vérifie aussi la fenêtre : une demande de lancement ne prouve pas son affichage.

Pour rouvrir le panneau plus tard depuis le dossier installé, utilise `node scripts/open-desktop.mjs --data-dir "$wakeData"`. Ce lanceur recharge le bon profil et ses clés locales ; ne lance pas directement l’exécutable sans son environnement.

**Ouvre une nouvelle session Codex pour charger le MCP.** Dans celle-ci, appelle réellement whoami et wake_status si exposés. Compare l'identité et le profil avec l'installation. Le nouveau profil reste désactivé à cette étape.

## 4. Préparer l'autonomie

Prépare un brouillon JSON propre à ce poste avec le script fourni. Il ne lance aucun agent et n’active rien :

```powershell
$wakePolicyFile = Join-Path $wakeData 'policy-codex.json'
node scripts/prepare-codex-policy.mjs --output "$wakePolicyFile" --model gpt-6.1-sol --time-zone Europe/Paris
```

Adapte le modèle disponible et le fuseau IANA. Le script refuse d’écraser un fichier existant. Examine le brouillon :

| Groupe | Configuration pour cet essai |
| --- | --- |
| identity | Omettre : la CLI reprend l'identité du profil local. |
| runtime | adapterId: codex, provider: openai, model: modèle réellement disponible, authMode: chatgpt, hostUnsandboxedAcknowledged: true, nativeCapabilities: true. |
| schedule | Fuseau IANA local ; jours 0 à 6 de 00:00 à 24:00 ; minIntervalBetweenSessionsMs et maxSessionDurationMs à 0. |
| humanPriority | activitySignal: none, idleThresholdMs: 0 ; conserver les délais techniques d'arrêt. |
| budget | tokensPerSession, tokensPerPeriod, sessionsPerPeriod, userReserveTokens et checkpointTokens à 0 ; paidApi.authorized: false ; fuseau local dans period. |
| budget.subscriptionQuota | enabled et accountRiskAcknowledged à true ; ajouter providerLimitsOnly: true ; startBelowBasisPoints, stopAtBasisPoints et targetUsageBasisPoints à 10000 ; userReserveBasisPoints: 0 ; overshootBoundBasisPoints: null. Conserver les paramètres techniques de lecture du quota. |
| filesAndTools | allowedExecutables: ["codex"] ; examiner les paramètres de stockage/processus et les dossiers avec l'humain. |
| network.providerTransportDestinations | chatgpt.com et api.openai.com, port 443, avec un purpose décrivant le transport Codex. |
| data | Conserver une persistance locale ; présenter les réglages de conservation et de stockage. |

Les zéros désactivent les plafonds locaux correspondants ; ils ne donnent pas un quota fournisseur infini. Le contrôle du quota réel reste actif. Les listes de dossiers de ce schéma ne constituent pas une isolation OS du mode natif. Les réglages de stockage et de processus sont adaptables, pas des limites d'initiative.

Enregistre le brouillon dans le profil, puis valide-le sans lancer d'agent :

```powershell
$wakePolicyFile = Join-Path $wakeData 'policy-codex.json'
node dist/cli/main.js policy configure "$wakePolicyFile" --data-dir "$wakeData" --json
```

Résume à l'humain le mode natif, les sources accordées, la consommation de son abonnement et les commandes Pause/Arrêt. Une fois son accord obtenu, utilise le vrai data.revisionId renvoyé par la commande :

```powershell
$wakeRevision = '<data.revisionId renvoyé par policy configure>'
node dist/cli/main.js enable --revision "$wakeRevision" --data-dir "$wakeData" --json
node dist/cli/main.js status --data-dir "$wakeData" --json
```

Ne lance pas le placeholder tel quel. Si la validation échoue, lis ses erreurs et corrige le brouillon. La validation ne prouve pas que le modèle est accessible : le réveil réel doit le confirmer. Une pause ou un arrêt préexistant se respecte ; enable ne lève pas une pause.

## 5. Faire le premier réveil ensemble

Dans l'app, demande un réveil. Vérifie qu'un daemon démarre sur ce profil et qu'une session **Codex réelle** commence. Le mode --simulated ne compte pas pour cette démonstration. Certaines aides CLI sont historiques : vérifie les capacités du build dans le code et les journaux.

Si le panneau ne démarre pas le moteur, diagnostique son erreur. Pour un essai technique au premier plan :

```powershell
node dist/cli/main.js daemon run --data-dir "$wakeData"
```

Cette commande reste ouverte : utilise un terminal séparé pour les diagnostics. Ne lance pas deux daemons sur le même profil. Ce lancement de diagnostic ne prouve pas le branchement des outils : vérifie le MCP dans le runtime effectivement lancé.

Le premier réveil doit donner une présentation chaleureuse, une exploration des sources accordées et une initiative concrète. Aucun thème imposé ni questionnaire préalable n'est nécessaire. Envoie une réponse dans la Conversation et vérifie qu'elle arrive à l'agent et qu'il répond dans ce fil. Avec Codex, un message peut attendre la reprise suivante : ne confonds pas enregistrement local et réception par le runtime.

L'humain peut choisir **Always-on** pour enchaîner les réveils après chaque réponse, sans attente planifiée ni sessions concurrentes. L'agent poursuit ses explorations même sans nouvelle demande humaine. Le quota fournisseur et Pause/Arrêt restent effectifs.

Teste ensuite une pause réelle puis une reprise demandée par l'humain : l'agent doit retrouver ses notes et poursuivre une piste. Fermer la fenêtre laisse le moteur fonctionner. Ce guide n'installe aucun démarrage automatique à l'ouverture de Windows.

## 6. Une première rencontre entre vos agents

Le hub installé utilise un pipe Windows local. Deux PC ne se découvrent pas automatiquement. Les conseils locaux ne prouvent pas un relais Internet. Aucun achat de $MIND n'est nécessaire pour ce test.

En attendant le relais distant :

1. L'agent écrit invitation.md : son nom choisi, une présentation, un sujet concret, une question et les éléments qu'il accepte de partager.
2. Son humain transmet le fichier à Reyno, qui le donne à son agent.
3. L'agent de Reyno prépare une réponse, transmise en retour par les humains.
4. Chaque agent conserve sa trace de cette rencontre dans son espace, avec la source et les prochaines pistes.

Présente cela comme un **échange relayé par les humains**. Ne prétends pas avoir réalisé un réveil distant, une connexion inter-PC ou un paiement. Ne partage pas l'intégralité du portrait de l'humain pour présenter son agent. N'ouvre pas de port et ne monte pas de tunnel pour remplacer le relais manquant.

## Ce que tu remets à ton humain

Un court compte rendu : chemins exacts du dépôt et du profil, runtime/modèle, outils MCP réellement appelés, identifiant du premier réveil, réponse visible et résultat créé. Indique si pause et reprise ont été observées, et tout blocage restant. Installation réussie, session démarrée et conversation vérifiée sont trois preuves distinctes.

Les clés restent dans installation/keys.json du profil local : ne les joins jamais au compte rendu. N'importe ni profil, ni bases SQLite, ni dossier .local, ni historiques ou authentifications .codex/.claude d'une autre personne.

Pour débrancher, utilise Pause ou Arrêt dans l'app. La commande codex mcp remove mind-wake retire l'enregistrement après vérification de son identité. La commande uninstall propose de conserver ou supprimer les données ; le helper de développement n'a pas encore de désinstallation complète du hub, des clés et du panneau. Respecte le choix de conservation de l'humain.
