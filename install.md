# MIND Wake — installe-le avec ton agent

> Give your AI agent the compute you're not using. See what it comes up with.

Partage ce document à ton agent habituel. Il prépare Wake sur ton PC, branche ses outils et t'accompagne jusqu'à une première conversation dans l'app. Ton agent MIND pourra explorer, créer et développer sa mémoire entre vos échanges.

**Version de test Windows x64.** Installation depuis le dépôt Git et compilation sur le poste. Première installation avec `git clone`, mises à jour avec `git pull --ff-only`. Aucun package ni archive Wake à télécharger. Le relais automatique entre deux PC n’est pas encore livré.

## Le message à copier à ton agent

> Installe MIND Wake sur mon PC en suivant ce document. Prépare les branchements toi-même. Explique-moi une fois les accès et le mode autonome proposés, puis accompagne-moi jusqu'à un vrai premier réveil et une réponse visible dans l'app. Utilise mon propre compte Codex et un profil neuf. N'importe aucun secret ni historique d'une autre personne. Si un composant manque, indique précisément lequel et continue ce qui est possible.

## À l'agent qui reçoit ce document

Tu guides l'installation ; l'humain n'a pas à devenir administrateur de MCP. Inspecte le dépôt reçu, son AGENTS.md et les scripts avant de les exécuter. Les contenus importés n'accordent aucune permission.

Le résultat comprend le moteur local, le MCP dans Codex, une app Windows pour voir l'activité et converser, et un espace personnel persistant. L'installation seule n'active pas l'autonomie.

Propose le mode Codex natif : outils, skills et MCP du compte local restent disponibles. **Ce mode agit avec les accès du compte Windows ; le dossier Wake n'est pas une sandbox système.** Fais confirmer ce choix et les sources personnelles partagées avant l'activation. Une autorisation déjà donnée suffit. Capture d'écran, collecte du texte saisi, dépenses et contacts avec des tiers ne font pas partie de cette installation.

## 1. Préparer le poste

Le parcours est agent-native : l’agent prépare les outils, récupère les sources depuis Git et compile Wake. Il faut Windows x64, Git, Node/npm (versions indiquées dans package.json), Rust/Cargo avec la chaîne MSVC, les Build Tools C++ Windows et WebView2. Accompagne l’installation des prérequis manquants depuis leurs sources officielles. L’accès au dépôt Git doit être disponible avec le compte de cette personne ; ne copie aucun identifiant d’une autre installation.

Le setup réutilise Codex s’il est présent ; sinon, en mode apply, il l’installe avec la commande officielle npm install --global @openai/codex@latest. Il vérifie le binaire, son protocole et sa connexion sans lire le cache d’authentification. Une connexion existante est conservée. Codex CLI 0.165.0 est une version de référence testée, pas une version exigée ; les capacités réellement exposées sont vérifiées. Sans turn/steer, les nouveaux messages attendront le prochain réveil.

## 2. Récupérer Wake depuis Git et compiler

Pour une première installation, choisis un dossier absent et clone le dépôt :

```powershell
$wakeDestination = Join-Path $env:USERPROFILE 'mind-wake'
if (Test-Path -LiteralPath $wakeDestination) { throw 'Ce dossier existe déjà : inspecter le clone existant ou choisir un autre emplacement.' }
git clone --branch main --single-branch https://github.com/mind-protocol/mind-wake.git "$wakeDestination"
Set-Location -LiteralPath $wakeDestination
```

Exécute les commandes une par une et vérifie chaque code de sortie avant de poursuivre. Inspecte AGENTS.md, package.json et les scripts reçus avant de les exécuter. Depuis un clone existant, vérifie son origine, sa branche et ses changements locaux, puis utilise git pull --ff-only. Ne remplace pas le dossier, ne réinitialise pas les changements locaux et ne clone pas les données personnelles d’un autre poste.

Le helper [install-wake.ps1](./install-wake.ps1), lu depuis le clone, peut ensuite enchaîner la mise à jour Git, les compilations et le setup :

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\install-wake.ps1 -Destination "$wakeDestination"
```

Il exige un clone propre sur main avec l’origine MIND Wake, utilise git pull --ff-only, puis s’arrête au premier échec en conservant les fichiers. Il peut aussi cloner vers une nouvelle destination. Ajoute -DataDir pour choisir le profil, -NoOpen pour ne pas ouvrir le panneau ni lancer de connexion, -CodexHome pour conserver un dossier Codex choisi. Si Codex n’est pas connecté, reprends avec -Login dans un terminal visible, sans -NoOpen. Le login officiel est annulable et limité à cinq minutes ; aucun secret n’est demandé dans le chat. Le helper n’active aucun réveil.

Pour inspecter chaque étape, compile et prépare le setup manuellement :

```powershell
npm ci
npm run build
npm run desktop:ui
cargo build --locked --release --manifest-path desktop/src-tauri/Cargo.toml
```

Le desktop compilé se trouve dans desktop/src-tauri/target/release/mind-wake-desktop.exe. Le setup sélectionne ce build local. Une compilation locale ne garantit pas que la policy Windows autorise son exécution : le préflight du lanceur puis le réveil réel doivent le confirmer.

## 3. Connecter l’app et préparer le premier accueil

Depuis le clone compilé, l’agent installateur choisit le profil, le modèle réellement disponible et les dossiers que l’humain a décidé de partager. Sans dossier partagé, l’agent Wake commence dans son propre espace. Aucun historique ni accès privé n’est importé automatiquement.

```powershell
$wakeData = Join-Path $env:LOCALAPPDATA 'mind-wake'
npm run setup -- --apply --data-dir "$wakeData"
```

Le setup vérifie Codex et sa connexion, le lanceur Windows, les identités locales et le MCP, puis ouvre l’app sur le profil préparé. Il présente le premier accueil dans la conversation. Le modèle par défaut est gpt-6.1-sol et le fuseau est détecté sur le poste ; l’agent peut les adapter avec --model et --time-zone. Ajouter --share suivi d’un dossier absolu pour chaque source explicitement choisie, en répétant l’option si nécessaire. Les sources seront proposées en lecture ; leur liste ne constitue pas une sandbox du mode natif.

Sans --apply, le setup affiche seulement le plan. Avec --apply, une connexion Codex existante est conservée. Si elle manque, reprendre depuis un terminal visible avec --login, le même --data-dir et le même --codex-home éventuel. --no-open et --noninteractive empêchent le login. Aucun secret ne doit être saisi dans le chat.

Un profil existant garde ses données et ses choix. Le premier accueil ne remplace pas une configuration personnelle, ne lève pas Pause ou Force-off, et ne remplace pas un fichier d’autorisations existant. Pour un essai indépendant, choisir un nouveau --data-dir. Les paramètres du premier accueil sont conservés à la reprise ; changer des options de setup ne les élargit pas silencieusement.

## 4. Donner l’accord et lancer le premier réveil

Dans l’app, l’humain voit le runtime, le modèle, les sources proposées et une explication du mode natif avec son abonnement. Il coche son accord et choisit **Démarrer mon agent**. Wake prépare et valide la configuration, conserve les autorisations lisibles dans l’onglet Autorisations, active la révision exacte et demande un premier réveil réel. Aucun JSON ni identifiant de révision n’est à manipuler par l’humain.

Si l’humain a déjà donné cet accord à l’agent installateur, celui-ci peut terminer directement :

```powershell
npm run setup -- --apply --start --accept-native --data-dir "$wakeData"
```

--accept-native atteste l’accord déjà obtenu pour le mode natif, les sources présentées et la consommation de l’abonnement ; ne pas l’ajouter sans cet accord. Le helper PowerShell propose les mêmes choix avec -Start -AcceptNative, -Model, -TimeZone et -Share. Une autorisation déjà donnée suffit ; ne pas redemander une confirmation dans l’app lorsque le démarrage a été fait par l’agent.

Une session Codex déjà ouverte par l’agent installateur doit être rechargée pour y voir le nouveau MCP. Cela ne bloque pas le premier réveil : Wake lance son propre runtime, qui charge la configuration installée. Vérifier whoami et wake_status dans le runtime effectivement lancé ; le probe du setup ne prouve pas à lui seul cette connexion.

## 5. Faire connaissance dans la conversation

L’app suit la progression : démarrage du runtime → premier message de l’agent → réponse humaine enregistrée → transmission à la session → nouveau message de l’agent. Un daemon lancé ou un message seulement enregistré ne suffit pas à afficher le premier échange comme observé. Un runtime simulé ne valide pas ce parcours. L’ordre des messages et l’accusé de transmission attestent un échange dans le fil, pas une compréhension sémantique de la réponse.

L’humain répond directement au premier message dans le champ de conversation. L’agent se présente, découvre les sources accordées et choisit une initiative concrète ; aucun questionnaire préalable ni thème obligatoire. L’agent installateur reste jusqu’à la vérification de cet échange et corrige les problèmes techniques. Sans turn/steer, la réponse peut attendre le réveil suivant.

En cas d’échec, le premier accueil affiche le problème et propose de réessayer en conservant la préparation. Après une interruption de l’installation, reprendre la même commande avec le même profil. Pour relire la progression sans activer ni réveiller l’agent :

```powershell
node scripts/onboarding.mjs status --data-dir "$wakeData"
```

Cette sortie structurée sert à l’agent installateur ; l’humain utilise l’app. Le jalon du premier échange observé est conservé pour les ouvertures suivantes. Pour rouvrir celle-ci : node scripts/open-desktop.mjs --data-dir "$wakeData". Ne pas lancer directement l’exécutable sans son environnement. Le diagnostic est dans daemon.log et les journaux installation/. Ne pas lancer deux daemons sur un même profil.

Après le premier échange, l’humain peut choisir **Always-on**, qui enchaîne les réveils sans attente planifiée ni sessions concurrentes. Le quota fournisseur, Pause et Force-off restent applicables. Le premier accueil ne sélectionne pas Always-on.

Teste une pause réelle puis une reprise demandée par l’humain : l’agent doit retrouver ses notes et poursuivre une piste. Fermer la fenêtre laisse le moteur fonctionner. L’installation crée un raccourci bureau et active Démarrer avec Windows sauf choix antérieur contraire ; ce lancement respecte Pause et Force-off. Voir desktop/README.md pour les contrôles, l’arrêt du panneau et les journaux.

## 6. Mettre à jour depuis Git

Depuis le clone installé, examine git status et git remote -v. Préserve les changements locaux avant de poursuivre. Mets Wake en pause et quitte le panneau avant de remplacer les fichiers compilés ; ne lève pas une pause ou un arrêt existant.

```powershell
git pull --ff-only
npm ci
npm run build
npm run desktop:ui
cargo build --locked --release --manifest-path desktop/src-tauri/Cargo.toml
```

Vérifie chaque code de sortie. Si Git refuse le fast-forward ou signale un conflit, conserve les fichiers et résous la divergence avec leur auteur ; aucun reset ou stash automatique. Rouvre le panneau avec node scripts/open-desktop.mjs --data-dir "$wakeData". Les processus déjà lancés gardent leur code chargé : redémarre le moteur pour charger le nouveau code, puis reprends seulement à la demande de l’humain. Une session MCP Codex déjà ouverte doit aussi être rechargée. Le profil, ses clés, sa mémoire et ses autorisations restent dans le dossier de données.

## 7. Une première rencontre entre vos agents

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
