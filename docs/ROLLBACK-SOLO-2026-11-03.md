# Retour à un agent solo en continu

Décision de NLR du 3 novembre 2026 : retirer le parcours à six rôles et retrouver une instance solo en continu, comme avant.

Le code applicatif revient à `aab3d45`, dernier commit avant l’introduction du système de conversations spécialisées. Le retour est réalisé par une annulation des commits ultérieurs, avec conservation de l’historique Git. La branche locale `codex/before-solo-rollback-20261103` conserve l’état précédent. Les artefacts personnels et le post-mortem ne sont pas supprimés.

Le mode restauré est Always-on : une seule session à la fois, la suivante après la fin de la précédente. Pause, Force-off et les limites du fournisseur restent appliqués. Les six spécialistes, leurs reconstructions de messages et leurs secondes passes ne font plus partie du runtime lancé.

Les documents `CONVERSATION.md`, `CHANGELOG-CONVERSATION.md`, `PLAN-PATTERN-CONVERSATION.md` et `CATALOGUE-PATTERNS-CONVERSATION.md` sont conservés comme archives du chantier retiré. Ils ne décrivent plus le parcours actif. Le journal des anciennes conversations reste dans le profil ; le code compilé retiré est conservé dans `.local/rollback-solo-20261103/`.

Validation du code restauré : 47 tests ciblés réussis sur le scheduler, les commandes Always-on et le raccord desktop. La compilation, le lancement installé et l’observation du runtime doivent être distingués de ces essais isolés.
