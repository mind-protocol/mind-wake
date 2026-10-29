# ADR-008 — Activation d'une policy sans code de confirmation

- Statut : accepté
- Date : 2026-10-29
- Session / auteur : desktop, Claude Code
- Validation humaine : décision explicite de l'utilisateur le 2026-10-29 (« supprime cette règle »), après exposé du conflit avec `AGENTS.md` §3

## Problème

`mind-wake enable` exigeait de recopier un code (début de l'empreinte de la révision), dans le terminal ou par `--confirm CODE`, comme preuve que l'activation venait de l'humain. L'utilisateur ne veut aucune manipulation de ce genre : le test réel du 29 octobre a demandé trois saisies de code successives.

Conflit signalé avant la décision :

- `AGENTS.md` §3, principe 2 : « L'autorisation précède l'exécution » ;
- principe 3 : l'agent ne peut ni modifier sa policy ni réactiver ses permissions.

Le code était la seule preuve, côté CLI, qu'une activation venait de l'humain. Ses limites étaient déjà connues : la CLI ne distingue pas un humain d'un agent qui dispose d'un shell, et le code est affiché par `policy configure`.

## Options considérées

| Option                                              | Avantages                             | Inconvénients                                                                             |
| --------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| Garder le code                                      | Preuve d'une action humaine délibérée | Friction refusée par l'utilisateur                                                        |
| Bouton « Activer » dans l'app desktop, code interne | Un clic, consentement conservé        | Reste une action à faire ; refusée                                                        |
| **Supprimer le code**                               | Aucune manipulation                   | Tout processus du compte peut activer une révision proposée, y compris un agent non isolé |

## Choix

**Suppression du code de confirmation.** `enable` vaut confirmation :

- canal journalisé `direct` ;
- `--confirm CODE` reste accepté et vérifié s'il est passé, un code erroné est toujours refusé ;
- le résumé de la révision et l'avertissement du mode non isolé restent affichés en mode interactif.

Restent inchangés :

- la validation de la révision (limites obligatoires, composants requis, stockage) ;
- le consentement enregistré, avec l'empreinte de la révision ;
- les refus d'état, en particulier un arrêt d'urgence verrouillé ;
- `uninstall`, dont le choix reste réservé à l'humain.

## Conséquences

- Les principes 2 et 3 d'`AGENTS.md` ne sont plus garantis par la CLI. Un agent qui atteint la CLI (mode non isolé, ADR-006) peut proposer puis activer une révision qui élargit ses plafonds ou ses permissions. Seuls l'isolation, quand elle est active, et le journal, qui trace chaque révision et activation, en limitent l'effet.
- `AGENTS.md` §3 consigne cette exception, comme pour ADR-006.
- Les textes qui présentaient le code comme réservé à l'humain sont mis à jour : aide de la CLI, en-tête d'`enable.ts`, tests.

## Critères de révision

- Retour de l'isolation par défaut ou distribution à d'autres utilisateurs : réintroduire une confirmation humaine, au moins un clic dans l'app desktop.
- Activation observée qui n'a pas été voulue par l'humain.
- Mise en place d'un canal de confiance local hors d'atteinte de l'agent : nommé pipe à ACL, ou application desktop seule autorisée.
