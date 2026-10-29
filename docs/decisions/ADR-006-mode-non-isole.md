# ADR-006 — Mode sans approbation non isolé, sur le poste hôte

- Statut : accepté
- Date : 2026-10-29
- Session / auteur : session principale, à la demande de l'utilisateur
- Validation humaine : « pas de sandbox », puis confirmation explicite « Bypass total » après exposé des risques
- Révise : `AGENTS.md` principe 6 ; remplace la condition « seulement sous sandbox » d'ADR-005

## Problème

ADR-005 n'autorisait les modes sans approbation des runtimes que dans la sandbox AppContainer. Faire tourner un CLI dans cette sandbox exige un relais fournisseur passant par le seul pipe du broker, chantier incertain. L'utilisateur veut des réveils réels rapidement et a choisi de lancer les runtimes sans sandbox, avec leurs options sans approbation.

## Options considérées

| Option                                                  | Avantages                                | Inconvénients                                                                                                                      |
| ------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox AppContainer + relais (ADR-005)                 | Frontière imposée par le système         | Relais non démontré ; délai                                                                                                        |
| Protections propres aux CLI, sans options `dangerously` | Autonomie sans relais, écritures bornées | Confinement partiel (lecture des secrets non protégée)                                                                             |
| Options `dangerously` sur l'hôte, sans isolation        | Le plus simple, réveils réels immédiats  | L'agent a tous les droits du compte Windows ; une injection depuis un contenu lu peut supprimer, envoyer ou modifier sans contrôle |

## Choix

**Troisième option, choisie par l'utilisateur en connaissance des risques.**

- `--dangerously-skip-permissions` (Claude Code), `--dangerously-bypass-approvals-and-sandbox` (Codex) et `--yolo` (Gemini CLI) peuvent être passés sur le poste hôte.
- Condition : un **consentement distinct** consigné dans la policy (`hostUnsandboxedAcknowledged` ou équivalent), saisi par l'humain sur le canal de confiance, mentionnant l'accès complet au compte et le risque d'injection. Sans lui, les adapters refusent ce mode.
- `doctor`, `status`, le journal et les bilans affichent « non isolé ».
- Restent obligatoires : arrêt d'urgence (Job Object, terminaison de l'arborescence), priorité humaine, pause, garde de quota (ADR-004/ADR-005), journal expurgé, refus d'activation si un champ de limite manque.
- La sandbox de `src/sandbox/` reste dans le code et utilisable ; le relais fournisseur est suspendu.

## Conséquences

- L'agent peut lire tous les fichiers et secrets du compte, joindre n'importe quelle destination et agir sur les comptes ouverts. La consigne « préparer sans envoyer » des prompts de réveil n'est plus qu'une demande faite au modèle.
- Les recettes d'isolation A09 et A10 ne sont pas satisfaites dans ce mode ; la v0.1 ne peut pas être déclarée conforme à AGENTS.md §8 tant qu'il est le seul mode utilisé.
- Mitigation recommandée, non imposée : un compte Windows dédié à Wake, sans accès aux données personnelles.

## Critères de révision

- Relais fournisseur démontré : revenir au mode sous sandbox par défaut.
- Incident ou action non souhaitée constatée pendant un réveil.
- Distribution à d'autres utilisateurs : ce mode ne peut pas être le défaut d'une installation publique.

## Sources consultées

Échange avec l'utilisateur dans le chat ; `src/sandbox/README.md` ; ADR-005.
