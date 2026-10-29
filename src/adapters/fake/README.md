# src/adapters/fake

Session S7. Adapter factice **SIMULÉ** conforme à `RuntimeAdapter` (`src/contracts/adapter.ts`) : `probe().simulated = true`, toute consommation `simulated`, aucun appel modèle ni accès réseau. Il sert au développement du runner et du scheduler, jamais de preuve d'intégration réelle (AGENTS §5).

Chaque session lance un vrai processus enfant (`agent-process.ts`, modules `node:` seulement) par `AdapterHost.spawnContained` : le processus et toute sa descendance sont dans le Job Object de la session et le runner peut les terminer sans coopération. Le processus joue un scénario d'étapes déterministe ; chaque action contrôlée est soumise au runner (`AdapterHost.authorize`) et l'agent attend le verdict avant de continuer.

## Scénarios (`fakeScenario(name, { pidFile?, iterations? })`)

| Nom            | Comportement                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `success`      | action `file_write`, 150 tokens, un checkpoint candidat, fin déclarée                                                                   |
| `slow`         | un descendant détaché (+ petit-enfant), puis toutes les 100 ms une action `file_read` et 10 tokens ; coopère aux demandes de checkpoint |
| `rate_limited` | 20 tokens, limitation fournisseur (`retryAfterMs` 60 000), puis attente                                                                 |
| `auth_error`   | erreur `auth_failed`, sortie code 1                                                                                                     |
| `stubborn`     | 2 enfants détachés qui lancent chacun un petit-enfant détaché ; ignore les demandes de checkpoint et la fin de son entrée               |
| `crash`        | un descendant, 50 tokens, puis sortie brutale code 70 sans fin déclarée                                                                 |

`pidFile` reçoit les PID de l'agent et de toute sa descendance (tests de terminaison).

## Capacités déclarées

`tokenCounting: "exact"` et `tokenCapEnforcement: "native"` valent pour la simulation seulement (consommation scriptée, borne imposée par le runner) ; `cancellation: "forced_only"` ; `residualUsageBound` 0 token ; `providerQuotaReading: "none"`. `reconcile` ne confirme l'usage que d'une session menée par la même instance et terminée ; après un redémarrage, il répond `uncertain`.
