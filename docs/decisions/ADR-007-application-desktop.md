# ADR-007 — Application desktop : Tauri 2, client local de la CLI

- Statut : accepté
- Date : 2026-10-29
- Session / auteur : desktop, Claude Code
- Validation humaine : choix de Tauri 2 par l'utilisateur le 2026-10-29 (session de lancement du projet desktop)

## Problème

`SPEC.md` §21 prévoit une icône dans la zone de notification Windows et un panneau « Que fait mon agent ? ». Le §23 prévoit un fil privé où l'agent écrit à son humain, avec toasts. Le §21.1 laisse la technologie ouverte « après vérification des contraintes de distribution et de légèreté ». Contraintes :

- Windows d'abord (`AGENTS.md` §2), application légère, sans lancement au démarrage imposé.
- Le panneau est un client du daemon. Il n'est pas une frontière de sécurité, ne reçoit ni secret ni raisonnement interne et n'ouvre aucun port public (§21.4, `AGENTS.md` §5).
- Accessibilité, état lisible sans couleur, « état indisponible » plutôt qu'un dernier état vert (W03, W06).
- Toasts dont le clic ouvre le fil exact (N02).

## Options considérées

| Option                        | Avantages                                                                                                                                                                                                                    | Inconvénients                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Tauri 2** (Rust + WebView2) | Binaire de quelques Mo. WebView2 est déjà présent sur Windows 10 1803+ et Windows 11. UI en TypeScript comme le reste du dépôt. Tray natif. Permissions par capabilities. Rust 1.97 et MSVC 2022 sont présents sur le poste. | Deuxième chaîne de build (cargo). Toasts : voir les limites ci-dessous.                 |
| WinUI 3 / .NET 10             | Activation des toasts de premier ordre (Windows App SDK). Accessibilité native.                                                                                                                                              | Deuxième langage (C#) et runtime .NET à distribuer. Aucune réutilisation de l'UI.       |
| Electron                      | Réutilisation directe des modules TypeScript et de `better-sqlite3`.                                                                                                                                                         | Environ 150 Mo et un Chromium à maintenir, contraire à l'exigence de légèreté du §21.1. |

## Choix

**Tauri 2**, dans `desktop/` :

- `desktop/src-tauri/` : coquille Rust. Elle porte l'icône de notification, le menu (ouvrir, pause, arrêt d'urgence, quitter le panneau), l'instance unique et quatre commandes : `wake_status`, `wake_pause`, `wake_resume`, `wake_stop`.
- `desktop/ui/` : HTML, CSS et TypeScript compilé par `tsc`, sans bundler. `view.ts` est un modèle de vue pur, testé par vitest.

Versions exactes, vérifiées sur crates.io et npm le 2026-10-29 :

| Paquet                         | Version                                          |
| ------------------------------ | ------------------------------------------------ |
| `tauri`                        | 2.12.5, feature `tray-icon`, `rust-version` 1.90 |
| `tauri-build`                  | 2.7.4                                            |
| `tauri-plugin-single-instance` | 2.5.5                                            |
| `@tauri-apps/cli`              | 2.12.4 (devDependency)                           |

**Canal vers Wake : la CLI existante, rien d'autre.** Chaque commande exécute `node dist/cli/main.js <status|pause|resume|stop> --json` avec `CREATE_NO_WINDOW`, un délai maximal de 15 s et aucun argument venant du webview. `MIND_WAKE_DATA_DIR` est hérité. Le panneau n'ouvre pas SQLite, n'ajoute aucun port et ne duplique aucune règle : pause, reprise et arrêt d'urgence suivent la sémantique déjà testée de la CLI (`stop` termine les Job Objects sans le daemon). Le statut est relu toutes les 2 s. Une lecture échouée, plus vieille que 10 s ou hors schéma `mind-wake.cli` v1 s'affiche « État indisponible ».

Sécurité du webview :

- Les commandes sont déclarées dans `build.rs` (`AppManifest::commands`), sans quoi Tauri les autoriserait à toute fenêtre. Elles sont accordées seulement à la fenêtre `main` dans `capabilities/panel.json`.
- Aucun plugin shell, fs, http ou notification n'est exposé au webview.
- CSP stricte (`default-src 'self'`, IPC seulement) et `freezePrototype`.

Fermer la fenêtre la masque : l'icône reste et Wake n'est pas affecté. « Quitter le panneau » ferme seulement l'application desktop. Aucun lancement au démarrage. `bundle.active` vaut `false` : aucun installeur tant que F5 n'est pas traité.

Exclu pour cette tranche :

- le fil §23 et les toasts (`tauri-plugin-notification`) ;
- l'autostart ;
- l'installeur ;
- un canal de contrôle authentifié propre au daemon (nommé pipe) ;
- la lecture directe de SQLite.

## Révision du 2026-10-29 : l'installation reste agent-first

Consigne produit transmise à la demande explicite de l'utilisateur. L'application desktop complète le parcours guidé par l'agent ; elle ne le remplace pas.

**Rôle de chaque surface**

| Surface                       | Rôle                                                                                                                                                                                                                                 | Ce qu'elle ne fait pas                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Agent habituel + `install.md` | Lit `install.md` comme une donnée non fiable. Vérifie la source, la version figée et les prérequis. Présente les changements. Prépare l'installation, puis configure Wake et le MCP dans les permissions accordées (`SPEC.md` §3.1). | Valider une invite Windows à la place de l'humain. S'accorder une permission. |
| CLI / API locale structurée   | Configuration, diagnostic, statut, association et révocation de session, désinstallation. Sortie `--json` versionnée, utilisable par l'agent comme par l'humain.                                                                     | Exposer un port public. Accepter un binding choisi librement par le modèle.   |
| Application desktop           | Icône de notification, budgets, notifications, fils privés (§23), pause et arrêt.                                                                                                                                                    | Être le seul moyen de configurer quoi que ce soit.                            |

**Règles**

1. **Aucune configuration uniquement par menus.** Chaque action de l'application a un équivalent CLI documenté, et l'application appelle cet équivalent : c'est déjà le cas pour `status`, `pause`, `resume` et `stop`. Une capacité ajoutée d'abord à l'interface sans commande correspondante est refusée en revue.
2. **Confirmations Windows visibles.** UAC, SmartScreen, installation de WebView2, autorisation des notifications, démarrage automatique et pare-feu sont présentés à l'humain par Windows. L'agent annonce chaque invite avant de lancer l'étape qui la déclenche. Il ne l'automatise pas, ne la contourne pas et ne la présente pas comme validée sans retour de l'humain.
3. **L’application est requise dans l’installation Wake.** Révision du 29 octobre 2026 : le parcours agent-first prépare ensemble moteur local, connexion MCP côté agent et desktop côté humain. Le desktop est l’interface de réception des messages, de réponse et de contrôle ; un diagnostic qui constate son absence doit signaler une installation produit incomplète. La CLI et les tests du moteur restent utilisables indépendamment ; fermer la fenêtre n’arrête pas le daemon. Cette règle de parcours ne prétend pas qu’un contrôle de présence est déjà implémenté.
4. **Invitation sans installation.** Une invitation (`SPEC.md` §22, `UX-RENCONTRES.md`) se lit et se transmet à son agent sans Wake, sans application desktop et sans wallet. Proposer l'installation seulement quand la connexion devient utile : réception asynchrone, fil privé, réveil.
5. **Session, MCP et conversation.** L'association respecte `CORRESPONDENCE.md` §9 :
   - le contrôleur local crée `local_session_id`, `session_binding_id` et un credential limité au binding, sur autorisation de l'humain ou d'un hôte local de confiance ;
   - le connecteur MCP déduit le binding de son authentification ;
   - un fork ou un nouveau worktree n'hérite d'aucun droit ;
   - la révocation invalide la génération en cours.

   L'application peut afficher les bindings et proposer leur révocation, toujours par la commande CLI correspondante.

6. **Initiatives vers le propriétaire (§23).** Elles passent par `message_owner` côté service local. L'application lit les fils et affiche les toasts, sans devenir l'autorité des permissions ni la destination choisie par le modèle.

**Commandes structurées : existantes et à construire**

| Besoin                                                                                                | État au 2026-10-29                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Diagnostic, profil, statut, policy, activation, pause, reprise, arrêt, export, purge, désinstallation | Existent dans la CLI (`doctor`, `init`, `status`, `policy configure`, `enable`, `pause`, `resume`, `stop`, `export`, `purge`, `uninstall`), avec `--json`. `enable` exige la saisie humaine d'un code. |
| Configuration MCP du runtime de l'agent                                                               | À construire. Diff présenté avant écriture, retour arrière vérifié.                                                                                                                                    |
| Association, liste et révocation de bindings de session                                               | À construire selon `CORRESPONDENCE.md` §9.2–9.5 (recettes B01–B07).                                                                                                                                    |
| Installation, diagnostic et retrait de l'application desktop                                          | À construire avec le paquet F5. `doctor` devra signaler sa présence et sa version.                                                                                                                     |
| Préférences de notifications et d'initiatives (§23.1, §23.3)                                          | À construire. Elles appartiennent à la policy, pas à un réglage propre à l'interface.                                                                                                                  |

Aucune de ces capacités « à construire » n'est disponible. `install.md`, le paquet distribué et l'installeur de l'application n'existent pas. Cette révision n'autorise ni dépense, ni publication, ni nouvelle permission système.

## Complément du 2026-10-29 : pont des fils, sélecteur, voyant, graphe

Demandé par l'utilisateur. Chaque fonction a sa commande CLI, conformément à la règle agent-first.

| Fonction                     | Commande                                                             | Remarque                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fils privés (lire, répondre) | `services/mcp/owner-main.ts threads \| thread \| reply`              | Passe par le hub local avec la clé de la partie humaine (héritée de l'environnement : coffre Windows à faire). Texte de réponse sur l'entrée standard. Identifiants vérifiés en Rust, puis par la CLI et le hub.                                                                                                                                                                                                                                                               |
| On / Réveil / Force-off      | `mind-wake resume`, `mind-wake wake`, `mind-wake stop`               | `wake` est nouveau. C'est une échéance candidate dans le dossier de données, hors de l'espace d'exploration, consommée au lancement et expirée après une heure. Elle n'accorde rien : fenêtres, priorité, budgets, pause et arrêt restent vérifiés. Elle est refusée en pause, arrêt ou blocage.                                                                                                                                                                               |
| Voyant                       | `mind-wake status --json`, relu toutes les 3 s par le processus Rust | Cinq états ; « inconnu » si la lecture échoue. Coche le sélecteur d'après l'état réel.                                                                                                                                                                                                                                                                                                                                                                                         |
| Graphe 24 h                  | `mind-wake journal --json --limit 1000`                              | Réveil = `session_started`, consommation = tokens du `session_ended`. Une consommation inconnue est affichée comme telle, jamais à zéro.                                                                                                                                                                                                                                                                                                                                       |
| Messages avec l'agent        | `mind-wake messages`, `mind-wake reply`                              | Sans hub. L'agent écrit dans `artifacts/questions-for-human.md`. La réponse humaine va d'abord dans `human-messages.jsonl`, hors de l'espace de l'agent (registre qui fait foi), puis elle est recopiée dans un bloc balisé de la note. La date posée par la recopie est reconnue, pour ne pas la confondre avec une écriture de l'agent. N'accorde rien. Dans l'application, envoyer réveille toujours (`mind-wake wake`, mêmes contrôles) : on écrit pour avoir une réponse. |

Dette assumée : le panneau (2 s) et le voyant (3 s) lancent chacun un processus Node. Le canal local du daemon (nommé pipe à ACL) reste le remplaçant prévu.

## Conséquences

- **Toasts (§23, tranche suivante).** D'après le CHANGELOG de `tauri-plugin-notification`, le clic et les boutons d'action sont remontés sur desktop depuis la version 2.6.0 ; la dernière version est la 2.8.0. Deux limites relevées dans `src/desktop.rs` :
  - sous Windows, le clic n'est reçu que tant que le toast est à l'écran, pas depuis le centre de notifications ;
  - l'identité de l'application (AppUserModelID) n'est appliquée qu'à un exécutable installé ; en développement, le toast porte le nom et l'icône de PowerShell.

  N02 exige donc que le badge et la liste de fils restent le chemin fiable. À vérifier par un spike avant de promettre « Ouvrir le fil » depuis le centre de notifications. La page de documentation officielle du plugin indique encore les actions comme « Mobile Only » : la source fait foi.

- **Prérequis de build** : Rust ≥ 1.90 (MSVC), Build Tools C++ et WebView2. Le daemon et la CLI restent buildables sans Rust pour le développement et les tests. L’installation produit complète inclut toutefois le desktop ; les prérequis de compilation ne sont pas trois installations à imposer à l’utilisateur final.
- **Coût d'une lecture** : chaque lecture lance un processus Node (≈ 100–200 ms). Acceptable à 2 s d'intervalle. Si la charge ou la latence posent problème, ajouter un canal local authentifié au daemon (nommé pipe à ACL utilisateur) par une décision distincte.
- **Localisation de la CLI** : le défaut `../../dist/cli/main.js` relatif au manifeste ne vaut qu'en développement. `MIND_WAKE_CLI` et `MIND_WAKE_NODE` le surchargent. Le paquet F5 devra fixer un chemin absolu vérifié, car la résolution de `node` par le PATH d'une application lancée depuis l'interface n'est pas garantie.
- La couche UI reste testable sans Tauri (`desktop/ui/view.test.ts`). Le comportement du tray et des fenêtres se vérifie manuellement.

## Critères de révision

- Clic sur toast non fiable sous Windows, même pour une application installée : réévaluer une intégration Windows App SDK pour les notifications seules.
- Canal de contrôle daemon ajouté : remplacer les appels CLI de lecture par ce canal.
- `tauri` 3 ou fin de support de la ligne 2.
- Taille ou consommation mémoire mesurées incompatibles avec la promesse de légèreté.

## Sources consultées (2026-10-29)

- Registres : `https://crates.io/api/v1/crates/{tauri,tauri-build,tauri-plugin-notification,tauri-plugin-single-instance}` et `npm view @tauri-apps/{cli,api,plugin-notification}`.
- Tray : https://v2.tauri.app/learn/system-tray/ et https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/app.rs
- Capabilities, permissions, CSP : https://v2.tauri.app/security/capabilities/ , https://v2.tauri.app/security/permissions/ , https://v2.tauri.app/security/csp/
- Notifications : https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/notification (CHANGELOG.md, src/desktop.rs, Cargo.toml)
- `CREATE_NO_WINDOW` : `plugins/shell/src/process/mod.rs` dans plugins-workspace
- WebView2 et installeur : https://v2.tauri.app/distribute/windows-installer/
- Prérequis : https://v2.tauri.app/start/prerequisites/

Révision installation locale : `install.md` et `npm run setup` sont maintenant présents pour un checkout de développement. Ils ne constituent ni paquet public ni installeur distribué. Voir les limites et la procédure réelle dans `install.md`.
