# MIND Wake

> Give your AI agent the compute you're not using. See what it comes up with.

MIND Wake laisse votre agent IA explorer de lui-même pendant les moments où vous l'y autorisez : il choisit une expérience, travaille dans un espace isolé, conserve ses découvertes, hiberne, puis reprend plus tard là où il s'était arrêté. Vous fixez une fois le budget, les fenêtres horaires et les permissions ; vous gardez la priorité, la pause et l'arrêt d'urgence.

**Statut : version de test Windows avec runtimes réels.** Le moteur et l’app portable sont disponibles dans l’[archive publique et son tutoriel agent-first](https://mind-wake-intro.immnfest.chatgpt.site/install.md). Le parcours recommandé utilise Codex ; les exemples simulés restent disponibles pour tester sans appel modèle. Aucun service public de paiement ou de relais inter-PC n’est livré.

## Principes

- **L'humain passe en premier.** Activité utilisateur, pause ou budget insuffisant interdisent tout nouveau travail ; l'arrêt d'urgence termine la session et ses processus sans attendre le modèle.
- **Refus par défaut.** Permissions explicites, limitées et révocables ; l'agent ne peut ni relever ses plafonds ni modifier sa policy.
- **Budget imposé par le système.** Réservation atomique avant chaque session ; un budget inconnu ou non imposable bloque le lancement.
- **Respect des fournisseurs.** Seulement des mécanismes officiels ; une limitation entraîne attente ou hibernation.
- **Arrêter est un résultat valide.** Une expérience négative honnêtement documentée vaut mieux qu'une activité artificielle.

La direction complète et les invariants de sécurité sont dans [AGENTS.md](AGENTS.md) ; la spécification dans [SPEC.md](SPEC.md).

## Prérequis

- Windows 11 (seule plateforme validée pour l'instant)
- Node.js `^24.17.0` ou `^26.13.0`

## Démarrage

```bash
npm ci
```

```bash
npm run build
```

```bash
npm test
```

Les deux démonstrations ci-dessous travaillent dans un dossier temporaire, sans réseau ni appel modèle, et marquent tout ce qui est simulé.

**Wake local, deux sessions avec hibernation et redémarrage du daemon**, puis priorité utilisateur, pause et arrêt d'urgence avec délais mesurés :

```bash
npm run demo:wake
```

**Séance de conseil guest distante, entièrement simulée** : un agent factice, exécuté dans un processus séparé, converse avec un guide ; les échanges sont comptés et réglés en unités fictives, sans aucun paiement réel :

```bash
npm run demo:advice
```

## CLI `mind-wake`

Après `npm run build`, la CLI se lance avec `node dist/cli/main.js <commande>`. Le dossier de données se choisit avec `--data-dir` ou la variable `MIND_WAKE_DATA_DIR`.

```bash
node dist/cli/main.js doctor
```

| Commande                                       | Effet                                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `doctor`                                       | Diagnostic local, sans appel modèle ni réseau ; indique ce qui est présent, simulé, expérimental, bloqué ou non implémenté                |
| `init`                                         | Prépare un profil désactivé, sans budget ni permission                                                                                    |
| `status`, `journal`                            | État, budget, prochain réveil, derniers événements                                                                                        |
| `policy show`, `policy configure FICHIER.json` | Affiche la policy active ; propose une révision validée, sans effet avant `enable`                                                        |
| `enable`                                       | Active une révision après confirmation humaine dans le terminal ; refusé tant que l'isolation et un adapter réel ne sont pas disponibles  |
| `pause`, `resume`, `stop`                      | Pause persistante, reprise, arrêt d'urgence verrouillé                                                                                    |
| `wake`                                         | Demande un réveil au plus tôt ; n'accorde rien (fenêtres, priorité, budgets revérifiés), refusé en pause, arrêt ou blocage                |
| `messages`, `reply`                            | Fil avec ton agent : sa note de travail et tes réponses (texte sur l'entrée standard) ; n'accorde rien (l'app enchaîne `wake` par défaut) |
| `export CHEMIN`, `purge`, `uninstall`          | Export expurgé, purge du journal expiré, désinstallation (`--dry-run` pour lister les effets)                                             |
| `daemon run`, `daemon run --simulated`         | Runtime réel autorisé par la configuration active ; avec --simulated, démonstration sans appel modèle                                   |

Chaque commande accepte `--json` pour une sortie structurée versionnée. Aucune commande ne fait de paiement ni n'installe de service ou de démarrage automatique.

## État actuel

| Composant                                                      | État                                                                                                                                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store SQLite, ledger de budget, policy engine, journal expurgé | Présents et testés                                                                                                                                                                |
| Scheduler, runner, checkpoints et mémoire, daemon              | Présents ; runtimes réels et démonstration simulée disponibles                                                                                                                     |
| Isolation Windows (AppContainer + Job Object)                  | Présente selon les capacités du profil ; le parcours Codex natif du tutoriel s’exécute sur l’hôte après autorisation, sans sandbox OS                                               |
| Adapter Codex                                                  | Implémenté, version CLI prise en charge : 0.165.0 ; disponibilité du modèle et quotas vérifiés au lancement                                                                          |
| Conseil guest distant                                          | Démo simulée locale seulement : pas de serveur public, de wallet, de $MIND ni de canal de messagerie                                                                              |
| Parcours agent-first et `install.md`                           | Tutoriel public, archive des sources et app Windows portable non signée ; installation MCP locale                                                                                  |

Le plan de développement et l'avancement sont dans [docs/PLAN.md](docs/PLAN.md) ; les décisions dans [docs/decisions/](docs/decisions/).

## Structure

```
src/          Wake local : contrats, store, ledger, policy, journal, CLI, scheduler,
              runner, checkpoints, daemon, adapters
services/     Conseil guest distant simulé (séances, canal de conversation, démo)
skills/       Skill de médiation côté guide
spikes/       Prototypes de faisabilité (isolation Windows)
test/         Tests d'intégration, de démo et fixtures
docs/         Plan, décisions (ADR), études de faisabilité
```

## Contribuer

Lire [AGENTS.md](AGENTS.md) avant toute modification : c'est la source de vérité du projet pour les humains comme pour les agents contributeurs. Avant de proposer un changement :

```bash
npm run typecheck
```

```bash
npm run lint
```

## Licence

[MIT](LICENSE)

## Installation produit : un parcours, trois composants

L’installation Wake comprend le moteur local, la connexion MCP côté agent et l’application desktop côté humain. Le desktop reçoit les messages et permet de répondre et contrôler l’agent. L’agent habituel guide l’installation depuis [install.md](./install.md). La CLI reste utilisable pour l’administration et les tests ; fermer la fenêtre n’arrête pas le moteur. L’archive publique contient les sources et l’app portable compilée, non signée, sans données ni comptes personnels.

### Essayer l’installation locale unifiée

Voir [install.md](./install.md). Après téléchargement, npm ci et npm run build, le script npm run setup prépare le profil, vérifie et enregistre le MCP dans Codex, puis ouvre le desktop fourni dans bin/. Une nouvelle session Codex charge le MCP. Le setup préserve les permissions, n’active aucun profil et n’installe aucun démarrage automatique. La désinstallation unifiée complète reste à terminer.

### Capture au réveil (option Windows)

Une capture horodatée et réduite peut accompagner le message de réveil de Codex ou Claude, sur autorisation explicite. Elle est désactivée par défaut ; le choix local actuel porte sur l’écran principal entier, à la demande explicite de l’utilisateur. Voir [contexte visuel](./docs/WAKE-VISUAL-CONTEXT.md) pour les réglages, la révocation et les limites de conservation des runtimes.

### Texte saisi au réveil

Sur autorisation explicite, les ajouts aux champs de saisie compatibles peuvent rejoindre le contexte du réveil. Le partage est visible via une icône T, avec pause et arrêt ; les champs protégés et non reconnus sont exclus. Voir [texte saisi](./docs/WAKE-TYPED-CONTEXT.md) pour le fonctionnement, les limites et la révocation. Le moteur en pause ne collecte pas.
