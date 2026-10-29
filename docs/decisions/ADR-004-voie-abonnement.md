# ADR-004 — Voie abonnement expérimentale

- Statut : proposé
- Date : 2026-10-29
- Session / auteur : session principale, à la demande de l'utilisateur
- Validation humaine : en attente (révision d'un invariant d'`AGENTS.md`)
- Révise : `AGENTS.md` §1 (règle d'abonnement), tableau §5 (adapter Codex), critère §8 « Compatibilité réelle » ; nuance le verdict abonnement d'ADR-002

## Problème

`AGENTS.md` §1 n'autorisait une capacité d'abonnement que par une intégration qui autorise **explicitement** l'usage automatisé. ADR-002 constate qu'aucune source officielle OpenAI n'autorise explicitement des sessions Codex planifiées avec un forfait ChatGPT personnel, et a donc bloqué cette voie. L'utilisateur relève qu'aucune source ne l'interdit non plus et souhaite pouvoir l'employer : c'est la voie la plus fidèle à la promesse « le compute que vous n'utilisez pas ».

Signaux défavorables relevés par S1 (`docs/feasibility/codex.md`) : usage ChatGPT en CI présenté comme « advanced » et réservé à une infrastructure privée de confiance, jetons d'automatisation réservés à Enterprise, usage du forfait par des apps tierces via programme partenaire, conditions d'utilisation interdisant l'extraction automatisée de sorties sans trancher ce cas.

## Options considérées

| Option                                | Avantages                                                            | Inconvénients                                                            |
| ------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Garder la règle (clé API seule)       | Aucun risque de compte ; plafond imposable par passerelle locale     | Dépense API ; écart avec la promesse produit                             |
| Autoriser l'abonnement sans condition | Fidèle au pitch, aucun coût direct                                   | Risque de suspension du compte ; affaiblit le principe 4 et les plafonds |
| Voie expérimentale conditionnelle     | Fidèle au pitch, risque assumé et visible, autres invariants intacts | Risque de compte accepté par l'utilisateur ; plafond encore à démontrer  |

## Choix

Voie abonnement expérimentale conditionnelle, décrite dans `AGENTS.md` §5 « Voie abonnement expérimentale » : désactivée par défaut, consentement distinct mentionnant le risque de compte, compte personnel et client officiel seulement, principe 4 intégral, aucune exigence de budget, priorité, annulation ou isolation allégée, fermeture immédiate sur interdiction ou avertissement, présentation explicite comme expérimentale.

Exclu : extraction de jetons ou cookies de session, rotation de comptes, endpoint privé, automatisation d'interface, repli automatique vers une clé API ou un autre compte.

## Conséquences

- La voie abonnement n'est plus bloquée par principe, mais **reste bloquée en pratique** tant qu'une borne de consommation imposée n'est pas démontrée. Avec une connexion ChatGPT, la passerelle locale prévue par ADR-002 ne détient pas de clé et ne peut pas borner les requêtes de la même façon ; `features.rollout_budget` est expérimental et ne coupe qu'après dépassement. Une session F3 doit établir si une borne conservatrice démontrable existe pour cette voie.
- Le policy engine doit modéliser ce consentement distinct et le motif de fermeture.
- `doctor` et `status` affichent « abonnement : expérimental » ou « bloqué : <motif> ».
- ADR-002 reste valable pour la voie clé API.

## Complément : borne par jauge de quota (29 octobre 2026)

Le plafond de tokens n'étant pas imposable avec une connexion ChatGPT, la voie abonnement se borne par la jauge officielle de quota exposée par `codex app-server` : `account/rateLimits/read` et `account/rateLimits/updated` (`usedPercent`, `windowDurationMins`, `resetsAt`, voir `docs/feasibility/codex.md`). Lire l'interface de l'application ou un endpoint interne reste exclu (principe 4).

Contrats ajoutés dans `src/contracts/` :

- unité `provider_quota_bp` (points de base d'une fenêtre fournisseur, 10 000 = 100 %), jamais convertie en tokens ou en monnaie ;
- `ProviderQuotaSnapshot` : lecture horodatée d'une fenêtre, `measured` seulement si officielle ;
- `SubscriptionQuotaGuard` (`BudgetGroup.subscriptionQuota`, absent = désactivé) : seuil de lancement, seuil d'arrêt, réserve humaine, dépassement maximal mesuré, âge maximal de la lecture ;
- capacité d'adapter `tokenCapEnforcement: "provider_quota_guard"` et `providerQuotaReading`.

Règle de borne : `seuil d'arrêt + dépassement mesuré ≤ 10 000 − réserve humaine`. Le dépassement (retard de la jauge, réponse en cours, tour qui continue après la limite) n'est documenté nulle part : tant qu'il n'est pas mesuré par des essais réels autorisés (vague 3), `overshootBoundBasisPoints` vaut `null` et le lancement reste bloqué.

Réserves : `app-server` est déclaré expérimental ; la jauge inclut l'usage de l'humain et s'exprime en pourcentage, sans tokens ; l'achat automatique de crédits du forfait doit être désactivé par l'utilisateur, ce que `doctor` doit rappeler ou vérifier.

## Critères de révision

- Texte officiel OpenAI autorisant explicitement cet usage (la voie devient standard) ou l'interdisant (la voie est supprimée).
- Avertissement, limitation ou suspension constatés sur un compte utilisant Wake.
- Démonstration ou impossibilité démontrée d'une borne de consommation imposable avec une connexion ChatGPT.

## Sources consultées

Celles de `docs/feasibility/codex.md` (session S1, 29 octobre 2026). Aucune nouvelle source consultée pour cette révision.
