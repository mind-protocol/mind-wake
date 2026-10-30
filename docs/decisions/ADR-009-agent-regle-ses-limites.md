# ADR-009 — L'agent règle ses propres limites

- Statut : accepté
- Date : 2026-10-29
- Session / auteur : desktop, Claude Code
- Validation humaine : décision explicite de l'utilisateur le 2026-10-29 (« l'agent sette ses propres limites exactement », « c'est toute l'idée du repo »)

## Problème

`AGENTS.md` §3, principe 3, posait : « L'agent ne peut ni relever ses plafonds, ni modifier sa policy, ni réactiver ses permissions. » L'utilisateur considère au contraire que l'autonomie de l'agent sur son propre rythme et ses propres limites est le but du projet. Premier cas concret : l'agent proposait de piloter sa compaction et son rythme (`artifacts/tools/pilote.js`).

## Options considérées

| Option                                                               | Avantages                                               | Inconvénients                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Garder le principe 3                                                 | Limites tenues hors du contexte du modèle               | Contraire à la direction voulue par l'utilisateur                                                                 |
| Le daemon exécute le code de l'agent (`pilote.js`)                   | Liberté maximale                                        | Code écrit par l'agent exécuté dans le processus de contrôle ; une erreur ou un contenu hostile atteint le daemon |
| **L'agent écrit ses réglages comme données, le daemon les applique** | L'agent décide, le daemon reste maître de son exécution | Les réglages doivent être prévus un par un                                                                        |

## Choix

**L'agent règle ses limites par des fichiers de données dans son espace, que le daemon lit et applique sans exécuter de code de l'agent.**

Premier réglage livré : `artifacts/pilote.json` (`src/daemon/agent-pilot.ts`).

- `compactAboveTokens` : son seuil d'auto-compaction. Il remplace celui du daemon, et 0 désactive.
- `compactRequest` : une compaction au réveil suivant, servie une fois par valeur.

Un fichier absent, illisible ou hors schéma est ignoré : les défauts du daemon s'appliquent.

Restent à l'humain, hors de portée de l'agent :

- pause ;
- arrêt d'urgence et réactivation ;
- garde de quota fournisseur ;
- désinstallation.

## Conséquences

- `AGENTS.md` (« Faire son chez-soi ») décrit ce pilotage. L'ancien principe 3 en avait déjà été retiré lors de la réécriture du fichier.
- Les réglages suivants (rythme, délais de réveil, plafonds de session) suivront le même modèle : un champ de donnée validé et un test. Pas d'exécution de code de l'agent par le daemon.
- Le journal et le panneau desktop doivent rendre visibles les réglages choisis par l'agent. Ce n'est pas encore fait.

### Extension du 30 octobre 2026 : captures ambiantes

`artifacts/pilote.json` accepte aussi `wakeScreenshot: { mode: "on" | "off" | "auto", idleThresholdMs?: number }`, validé indépendamment des réglages de compaction. C'est une restriction des captures déjà autorisées, pas une autorisation de surface ou de transmission. Un réglage de capture invalide suspend la capture au lieu d'appliquer le défaut `on` ; `off` ne se réactive jamais sur inactivité. Le journal du daemon rend la décision visible à chaque lancement. Voir [le protocole visuel](../WAKE-VISUAL-CONTEXT.md). Code préparé ; chargement dans le daemon vivant à vérifier séparément.

## Critères de révision

- Un réglage de l'agent qui provoque une consommation que l'humain n'aurait pas voulue.
- La distribution à d'autres utilisateurs : rendre ce pilotage optionnel et consenti par profil.
