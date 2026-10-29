# desktop — panneau « Que fait mon agent ? »

Application Tauri 2 pour Windows (`SPEC.md` §21, décision `docs/decisions/ADR-007-application-desktop.md`) : icône dans la zone de notification, panneau d'état, pause, reprise et arrêt d'urgence. Client de la CLI `mind-wake` : aucun port, aucune lecture directe de SQLite, aucune donnée hors de ce que `status --json` expose.

L'application est un complément optionnel de l'installation agent-first (`SPEC.md` §3.1, révision d'ADR-007) :

- L'agent installe et configure par `install.md` et la CLI.
- Toute action proposée ici a un équivalent CLI `--json`, et l'application appelle cet équivalent.
- Aucune configuration n'existe uniquement dans les menus.
- Wake, la CLI et le MCP fonctionnent sans l'application.

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
- Fermer la fenêtre la masque. L'application ne se lance pas au démarrage de Windows.
- Le statut est relu toutes les 2 s. En cas d'échec, de lecture de plus de 10 s ou de format inattendu, le panneau affiche « État indisponible ».
- Dans le panneau, Force-off demande un second clic dans les 5 s. Dans le menu de l'icône, il est immédiat. Après un arrêt d'urgence, On et Réveil sont désactivés et la CLI refuse la reprise.
- Un daemon simulé est signalé par « SIMULÉ ». Le budget disponible reste « inconnu » tant que la CLI ne le mesure pas.

## Tests

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
