# desktop — panneau « Que fait mon agent ? »

Application Tauri 2 pour Windows (`SPEC.md` §21, décision `docs/decisions/ADR-007-application-desktop.md`) : icône dans la zone de notification, panneau d'état, pause, reprise et arrêt d'urgence. Client de la CLI `mind-wake` : aucun port, aucune lecture directe de SQLite, aucune donnée hors de ce que `status --json` expose.

L’application est un composant requis de l’installation Wake agent-first (`SPEC.md` §3.1, révision d’ADR-007). Le parcours unique prépare le moteur local, la connexion MCP côté agent et le desktop côté humain :

- L'agent installe et configure par `install.md` et la CLI.
- Toute action proposée ici a un équivalent CLI `--json`, et l'application appelle cet équivalent.
- Aucune configuration n'existe uniquement dans les menus.
- Le desktop reçoit les messages de l’agent, permet à l’humain de répondre et donne accès aux contrôles. La CLI reste disponible pour l’administration, les diagnostics et les tests ; elle ne remplace pas le desktop dans l’installation produit. Fermer la fenêtre n’arrête pas le daemon.

Découpage : `docs/PLAN.md`, tranches D0–D5.

## Lancer (développement)

Prérequis : Node (voir `package.json`), Rust ≥ 1.90 avec la chaîne MSVC, Build Tools C++, WebView2.

```bash
npm run desktop
```

Cette commande construit la CLI (`dist/`), compile l'UI (`desktop/ui/build/`), puis compile et lance l'application. Les fichiers de l'UI sont embarqués à la compilation : relancer après une modification. Variables facultatives :

| Variable             | Effet                                                      |
| -------------------- | ---------------------------------------------------------- |
| `MIND_WAKE_DATA_DIR` | Dossier de données, transmis à la CLI comme pour l'humain  |
| `MIND_WAKE_CLI`      | Chemin de `main.js` (défaut : `dist/cli/main.js` du dépôt) |
| `MIND_WAKE_NODE`     | Chemin absolu de `node.exe` (défaut : `node` du PATH)      |

## Messages avec ton agent

Le fil de conversation et son champ de saisie restent visibles pendant les changements d’onglet. Les vues du menu remplacent le contenu du panneau voisin (à droite sur grand écran, en dessous sur une fenêtre étroite). Documents et Conversation montrent le lecteur dans ce panneau ; le brouillon et le défilement du fil sont conservés.

Le lecteur de documents à droite ouvre automatiquement le dernier fichier consulté dans l’espace sélectionné. Sans historique, il choisit une page d’accueil disponible (`index.html`, `objectifs.html`, `README.md`, etc.). Un fichier mémorisé disparu déclenche un repli vers l’accueil ; les erreurs ou dossiers sans document affichent une indication explicite au lieu d’un cadre vide.

L’onglet **Autorisations** du menu latéral édite les décisions et périmètres de `workspace/AUTORISATIONS.json` du profil actif. Il propose un import JSON explicite si les choix n’existent pas encore, une recherche et un enregistrement avec détection des modifications concurrentes. Les commandes natives de lecture et d’écriture sont réservées à la fenêtre principale ; aucun chemin de fichier libre n’est accepté du webview. Les choix personnels du dépôt ne sont pas appliqués automatiquement aux nouveaux utilisateurs. Le MCP relit le fichier au prochain appel de `unsure_what_to_do`.

L'onglet **Messages** montre ce que ton agent Wake t'écrit et te permet de lui répondre, sans hub ni réseau :

- **Ce qu'il t'écrit** : sa note de travail `artifacts/questions-for-human.md`, rendue comme texte non fiable (`mind-wake messages`).
- **Ce que tu lui réponds** (`mind-wake reply`, texte sur l'entrée standard) :
  - c'est d'abord enregistré dans `human-messages.jsonl`, dans le dossier de données hors de son espace : ce registre fait foi ;
  - c'est ensuite recopié dans un bloc balisé de sa note, qu'il relit à son prochain réveil.
- **Réveil** : la case « Réveiller mon agent pour qu'il lise ma réponse », cochée par défaut, enchaîne `mind-wake wake` après l'envoi. L'agent se réveille quand fenêtres, priorité humaine (inactivité), intervalle et budgets le permettent. Un refus n'annule pas la réponse. La réponse n'accorde aucune permission.

Le nom de la note est la convention que l'agent a choisie lors de sa première session. Le prompt de réveil ne l'annonce pas encore.

## Fils privés

L'onglet **Fils** affiche les messages de l'agent et permet d'y répondre. Il passe par `services/mcp/owner-main.ts`, avec le hub MIND local et la clé de liaison de la partie humaine.

| Variable            | Rôle                                                              |
| ------------------- | ----------------------------------------------------------------- |
| `MIND_MCP_HUB_PIPE` | Pipe du hub, héritée de l'environnement de lancement              |
| `MIND_MCP_LINK_KEY` | Clé de la partie humaine, héritée de l'environnement de lancement |
| `MIND_OWNER_CLI`    | Autre chemin du script (facultatif)                               |

Sans hub, l'onglet affiche « Fils indisponibles ». Les toasts ne sont pas encore livrés. La clé n'est pas encore conservée dans le coffre d'identifiants Windows.

## Comportement

- **Voyant** sur l'icône et dans le panneau, relu toutes les 3 s : bleu éveillé (session en cours), vert allumé (réveils permis), orange éteint (pause, blocage, désactivé), rouge arrêt forcé, gris inconnu.
- **Clic gauche** sur l'icône : ouvre le panneau.
- **Clic droit** : menu avec Ouvrir le panneau, le sélecteur et Pause.
  - Le sélecteur **On / Réveil / Force-off** est coché d'après l'état réel.
  - On correspond à `resume`, Réveil à `wake`, Force-off à `stop`.
  - Quitter le panneau ferme seulement l'application : Wake continue.
- **Graphe** : réveils et consommation des 24 dernières heures, tirés de `journal --json`.
  - Une barre représente les tokens d'une session.
  - Une barre grisée pleine hauteur signale une consommation inconnue, jamais zéro.
  - Les sessions SIMULÉES apparaissent en orange.
- Fermer la fenêtre la masque. L'installation active le démarrage avec Windows, désactivable dans le menu de l'icône.
- Le statut est relu toutes les 2 s. En cas d'échec, de lecture de plus de 10 s ou de format inattendu, le panneau affiche « État indisponible ».
- Dans le panneau, Force-off demande un second clic dans les 5 s. Dans le menu de l'icône, il est immédiat. Après un arrêt d'urgence, On et Réveil sont désactivés et la CLI refuse la reprise.
- Un daemon simulé est signalé par « SIMULÉ ». Le budget disponible reste « inconnu » tant que la CLI ne le mesure pas.

## Tests

Le panneau s'ouvre en plein écran par défaut. **Quitter le plein écran**, **Échap** ou **F11** permettent de revenir en fenêtre. Le bouton **Redémarrer l’app** est accessible dans l'en-tête : il relance uniquement le panneau, sans interrompre le daemon ni changer le mode de l'agent. Pour une installation supervisée, il recharge le manifeste et utilise la dernière version installée ; en lancement direct, il relance le même exécutable.

### Installation et démarrage Windows

`npm run setup -- --apply` crée un raccourci **MIND Wake** sur le bureau de l'utilisateur et active **Démarrer avec Windows** par défaut (à l'ouverture de session Windows). L'option se décoche dans le menu de l'icône de notification ; une nouvelle installation conserve ce choix. La commande équivalente est `node scripts/windows-integration.mjs enable|disable|status`, avec `MIND_WAKE_DATA_DIR` pour choisir le profil installé.

Au démarrage Windows, le lanceur démarre le moteur en mode **On** planifié seulement si le profil est prêt ou en hibernation et le moteur absent. Pause, Force-off, verrou d'urgence et profils non configurés restent respectés. Always-on n'est pas activé par ce lancement. Un moteur déjà actif n'est pas modifié.

Les raccourcis et `node scripts/open-desktop.mjs` supervisent le panneau : un crash relance l'application avec un délai progressif de 1 à 60 secondes. **Quitter le panneau** termine volontairement cette supervision ; fermer la fenêtre la masque. Une seconde ouverture retrouve le panneau existant. Le journal est `installation/desktop-supervisor.log`. La supervision ne redémarre pas un daemon arrêté par l'humain. Le lancement direct de l'exécutable ou `npm run desktop` reste un lancement de développement sans superviseur.

Les raccourcis utilisent les dossiers Windows de l'utilisateur (y compris un bureau redirigé), PowerShell masqué et le manifeste d'installation pour retrouver Node, le profil et les connexions locales. Aucune clé n'est inscrite dans le raccourci. Cette intégration appartient à l'installation locale actuelle ; elle ne constitue pas un installeur MSI.

- `npx vitest run desktop/ui` : modèles du panneau et du graphe.
- `cargo test` dans `src-tauri` : validation des identifiants venant du webview.
- `test/mcp/owner.process.test.ts` : pont des fils contre un vrai hub.

Le panneau et les fils ont été pilotés dans l'application réelle par le port de débogage WebView2, en test seulement. Le menu et le voyant de l'icône restent à vérifier à la main.

## Pas encore fait

- `message_owner` (§23) et toasts.
- Clé de la partie humaine dans le coffre d'identifiants Windows.
- Installeur et chemin de CLI distribué (F5).
- Signal d'activité réel.
- Lecture du ledger dans `status`.

## Messages éditables de l’agent

Le MCP local expose publication, liste, modification et suppression lorsque le canal humain est activé (`MIND_WAKE_OWNER_MESSAGES=1`). La CLI `messages --json` fournit `agentMessages` avec ID, version, date initiale et date de modification ; l’app relit ce fil et remplace son affichage à chaque actualisation. Les éditions restent au même emplacement et portent la mention « modifié ». Les suppressions retirent uniquement le message de l’agent ; les réponses de l’humain restent visibles. La note historique reste le repli tant qu’aucune mutation du nouveau canal n’a abouti.

## Always-on

Quatrième position du sélecteur, aussi présente dans le menu de l’icône : une réponse terminée relance la session suivante sans intervalle planifié, sans attendre une réponse humaine. Le mode est conservé dans `execution-mode.json`, hors de l’espace de l’agent, et exposé par `status --json` (`executionMode`). `mind-wake always-on` le sélectionne ; `mind-wake on` revient à la planification normale. Le bouton desktop démarre aussi le moteur si nécessaire.

La fin effective de la session précédente déclenche la réévaluation immédiate ; une seule session peut tourner. Le mode écarte les fenêtres horaires, l’attente d’inactivité et le pilotage temporel, tout en respectant l’indisponibilité fournisseur, les délais après erreur, les permissions, Pause et Force-off. Il ne lève ni un arrêt d’urgence ni un profil non configuré. Le simple ajout du bouton n’active pas ce mode.

## Mises à jour

Le panneau de production vérifie Git au démarrage et toutes les six heures. Les réglages détaillés proposent aussi une installation sur demande. Les builds sont préparés séparément et chargés à la prochaine ouverture ; les modes debug/dev bloquent les mises à jour. Voir [le protocole et ses limites](../docs/APP-UPDATES.md).

## Documents HTML et Markdown

Le bouton **Redémarrer le moteur**, à côté de l’actualisation du lecteur, recharge le daemon avec le code installé. Il interrompt la session en cours ; la reprise utilise la mémoire persistée. Il conserve le mode d’exécution, Pause et Force-off, sans demander un wake supplémentaire. Le panneau confirme le nouveau PID/date de démarrage ou affiche l’erreur. Sous Windows, l’arrêt vérifie le PID, le nom du processus et sa date de création ; une identité différente est refusée. Le bouton est désactivé pendant l’opération et la commande refuse les redémarrages concurrents. **Redémarrer l’app** reste une action distincte qui recharge seulement le panneau.

Le navigateur de dossiers et le lecteur restent visibles dans un volet droit permanent, à côté de la conversation ou de la vue active. Sur une fenêtre étroite, ils passent en dessous. Le sélecteur choisit le projet Wake ou l’espace live renvoyé par `wake-history`. Les liens relatifs HTML/Markdown, les ancres, précédent/suivant et l’actualisation restent dans ce lecteur. Le Markdown affiche titres, listes, liens, code, citations et tableaux simples.

Les lectures sont limitées aux fichiers HTML/Markdown (2 Mo maximum) à l’intérieur de la racine choisie après résolution des liens symboliques. Les pages HTML sont présentées en lecture seule dans une iframe sans scripts ni accès réseau ; leurs formulaires et ressources externes ne sont pas chargés. L’éditeur interactif des autorisations reste un parcours séparé. La commande `document_browse` est réservée à la fenêtre principale.
