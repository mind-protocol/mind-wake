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

## Complément : parcours officiel « Sign in with ChatGPT » pour apps open source (29 octobre 2026)

Relecture des sources signalées par la revue de coordination (`docs/REVIEW-2026-10-29.md`). OpenAI documente un parcours, en préversion, qui permet à une app **open source ou hébergée localement** d'utiliser le forfait ChatGPT de l'utilisateur :

- **Éligibilité :** les pages indiquent que l'usage du forfait est ouvert aux partenaires open source ; une app payante ou hébergée à distance passe par un formulaire d'intérêt ; un identifiant client OAuth se demande via « Request a client ID ». Les critères exacts d'éligibilité ne sont pas détaillés.
- **Mécanisme :** connexion OAuth avec consentement dans le navigateur au premier lancement, puis requêtes vers l'API Responses publique (`POST /v1/responses`) avec le jeton OAuth en `Bearer`, `store: false`, `stream: true`. Les endpoints `backend-api` de ChatGPT sont explicitement à éviter. Le jeton ne donne accès ni aux conversations ni à la clé API de l'utilisateur.
- **Codex :** `codex app-server` peut être lancé comme processus enfant avec le jeton dans `ACCESS_TOKEN` et un fournisseur Responses ; l'app renouvelle le jeton puis reprend le fil (`thread/resume`).
- **Hôtes :** un poste portable ou une VM autohébergée est un hôte valide, chacun avec un `ext_agent_host_id` stable.
- **Limites de la préversion :** `max_output_tokens`, `max_tool_calls`, `background` et plusieurs autres champs ne sont **pas acceptés** ; outils hébergés (recherche de fichiers, Code Interpreter, MCP hébergé…) non supportés. Une limite d'usage peut survenir en plein flux (`response.failed` avec `subscription_sharing_usage_limit_exceeded` ou `subscription_sharing_usage_unavailable`).
- **Non traité par ces pages :** usage automatisé, planifié ou sans humain (ni autorisé ni interdit explicitement), lecture du quota restant, objet `usage` par requête, annulation.

Conséquences :

1. La voie abonnement dispose d'un **mécanisme officiel**, ce qui remplace avantageusement la connexion ChatGPT de l'utilisateur dans Codex : Wake obtiendrait son propre jeton OAuth, scopé, révocable dans les paramètres ChatGPT. Le statut reste **expérimental** tant que l'usage sans humain n'est pas explicitement couvert et que l'éligibilité de MIND n'est pas confirmée.
2. Comme Wake détient le jeton et que les requêtes passent en HTTP vers l'API Responses, **la passerelle locale d'ADR-002 redevient possible** pour cette voie : elle détient seule le jeton, connaît l'entrée avant envoi, compte la sortie sur le flux et coupe la connexion au-delà de l'enveloppe. Sans `max_output_tokens`, la borne de sortie repose sur cette coupure : le résidu entre seuil et coupure effective reste **à mesurer**, comme le dépassement de la jauge de quota. Ni la télémétrie ni la coupure ne sont des bornes démontrées avant mesure.
3. **Action externe requise, réservée à l'utilisateur :** demander un identifiant client OAuth (et, si besoin, confirmer l'éligibilité de MIND). Aucune demande n'a été faite.

Pages consultées le 29 octobre 2026 : `https://developers.openai.com/siwc/quickstart`, `/siwc/website`, `/siwc/token-sharing-open-source`, `/siwc/token-sharing-open-source/models-and-inference`, `/siwc/token-sharing-open-source/codex-app-server`, `/siwc/token-sharing-open-source/preview-limitations`. Non encore lues : `token-reference`, `errors-and-recovery`, `profiles-and-sessions`, `self-hosted-vms`.

## Critères de révision

- Texte officiel OpenAI autorisant explicitement cet usage (la voie devient standard) ou l'interdisant (la voie est supprimée).
- Avertissement, limitation ou suspension constatés sur un compte utilisant Wake.
- Démonstration ou impossibilité démontrée d'une borne de consommation imposable avec une connexion ChatGPT.

## Sources consultées

Celles de `docs/feasibility/codex.md` (session S1, 29 octobre 2026), plus les pages « Sign in with ChatGPT » listées dans le complément ci-dessus.
