# MIND Wake

> Give your AI agent the compute you're not using. See what it comes up with.

MIND Wake laisse votre agent IA explorer de lui-même pendant les moments où vous l'y autorisez : il choisit une expérience, travaille dans un espace isolé, conserve ses découvertes, hiberne, puis reprend plus tard là où il s'était arrêté. Vous fixez une fois le budget, les fenêtres horaires et les permissions ; vous gardez la priorité, la pause et l'arrêt d'urgence.

**Statut : prototype en développement, aucun service public opérationnel.** Le daemon tourne aujourd'hui uniquement avec un agent **factice** : aucun appel à un modèle réel, aucune dépense, aucun paiement. Voir [État actuel](#état-actuel).

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
| `daemon run --simulated`                       | Daemon au premier plan avec l'adapter factice ; refusé sans `--simulated`                                                                 |

Chaque commande accepte `--json` pour une sortie structurée versionnée. Aucune commande ne fait de paiement ni n'installe de service ou de démarrage automatique.

## État actuel

| Composant                                                      | État                                                                                                                                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store SQLite, ledger de budget, policy engine, journal expurgé | Présents et testés                                                                                                                                                                |
| Scheduler, runner, checkpoints et mémoire, daemon              | Présents, exécutés avec l'adapter factice uniquement                                                                                                                              |
| Isolation Windows (AppContainer + Job Object)                  | En cours d'intégration ; prototype dans `spikes/isolation/`                                                                                                                       |
| Adapter Codex                                                  | Non implémenté. Voie abonnement ChatGPT expérimentale retenue ([ADR-004](docs/decisions/ADR-004-voie-abonnement.md)), bloquée tant qu'une borne de consommation n'est pas mesurée |
| Conseil guest distant                                          | Démo simulée locale seulement : pas de serveur public, de wallet, de $MIND ni de canal de messagerie                                                                              |
| Skill agent et `install.md`                                    | Non livrés                                                                                                                                                                        |

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

L’installation Wake comprend le moteur local, la connexion MCP côté agent et l’application desktop côté humain. Le desktop est requis pour le parcours produit : recevoir les messages, répondre et contrôler l’agent. L’agent habituel guide l’installation de l’ensemble depuis `install.md` ; l’humain autorise les changements et les confirmations Windows nécessaires. La CLI reste utilisable pour l’administration et les tests, et fermer la fenêtre n’arrête pas le moteur. Ce parcours unifié est une cible : aucun paquet ou installeur public n’est livré à ce jour.

### Essayer l’installation locale unifiée

Voir [install.md](./install.md). `npm run setup -- --apply --data-dir "C:\Users\reyno\AppData\Local\mind-wake-essai"` prépare le moteur et ses migrations, vérifie et enregistre le MCP dans Codex, puis ouvre le desktop sur ce profil. Le desktop doit avoir été compilé. Une nouvelle session Codex charge le MCP. Le setup préserve les permissions, n’active aucun profil et n’installe aucun démarrage automatique. Pas encore de paquet public ni de désinstallation unifiée complète.

### Capture au réveil (option Windows)

Une capture horodatée et réduite peut accompagner le message de réveil de Codex ou Claude, sur autorisation explicite. Elle est désactivée par défaut ; le choix local actuel porte sur l’écran principal entier, à la demande explicite de l’utilisateur. Voir [contexte visuel](./docs/WAKE-VISUAL-CONTEXT.md) pour les réglages, la révocation et les limites de conservation des runtimes.

### Texte saisi au réveil

Sur autorisation explicite, les ajouts aux champs de saisie compatibles peuvent rejoindre le contexte du réveil. Le partage est visible via une icône T, avec pause et arrêt ; les champs protégés et non reconnus sont exclus. Voir [texte saisi](./docs/WAKE-TYPED-CONTEXT.md) pour le fonctionnement, les limites et la révocation. Le moteur en pause ne collecte pas.
