# Faisabilité F0 — Codex comme runtime d'exploration

Session S1, 29 octobre 2026. Recherche documentaire uniquement : aucune installation de Codex, aucune authentification, aucun appel modèle. Les constats ci-dessous décrivent ce que disent les sources officielles à cette date, pas un comportement mesuré. Décision associée : [ADR-002](../decisions/ADR-002-runtime-codex.md).

## Méthode et sources

- Sources retenues : documentation Codex (OpenAI), dépôt officiel `github.com/openai/codex` (code et PR fusionnées), registre npm des paquets `@openai/*`, centre d'aide OpenAI, documentation API OpenAI, conditions d'utilisation OpenAI. Les blogs et wikis tiers trouvés en recherche ont été écartés.
- La documentation Codex a migré : les URL `developers.openai.com/codex/*` redirigent (308) vers `learn.chatgpt.com/docs/*`. Les liens ci-dessous pointent vers la destination consultée le 29/10/2026. Aucune page ne porte de date de mise à jour visible, sauf mention contraire.
- Version de référence : `@openai/codex` et `@openai/codex-sdk` **0.165.0**, publiées le 2026-10-27 (registre npm ; release GitHub `rust-v0.165.0`). Toute conclusion est à revérifier si la version change.
- Statuts : **vérifié** (énoncé explicite d'une source officielle) ; **partiel** (existe, mais avec une réserve qui empêche de s'y fier seul) ; **absent** (la source officielle montre qu'il n'existe pas, ou rien dans la référence complète) ; **non établi** (ni affirmé ni exclu ; ne rien supposer).

### Index des sources

| Réf. | Source |
| --- | --- |
| [S-exec] | [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) |
| [S-sdk] | [Codex SDK TypeScript, README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) ; types [`events.ts`](https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts), [`turnOptions.ts`](https://github.com/openai/codex/blob/main/sdk/typescript/src/turnOptions.ts) |
| [S-app] | [App server](https://learn.chatgpt.com/docs/app-server) |
| [S-cfg] | [Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference) |
| [S-adv] | [Advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced) |
| [S-win] | [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox) |
| [S-sec] | [Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security) |
| [S-auth] | [Authentication](https://learn.chatgpt.com/docs/auth) |
| [S-ci] | [Maintain Codex account auth in CI/CD (advanced)](https://learn.chatgpt.com/docs/auth/ci-cd-auth) |
| [S-sched] | [Scheduled tasks (app)](https://developers.openai.com/codex/app/automations) |
| [S-rb] | PR fusionnées [#28494](https://github.com/openai/codex/pull/28494) (18/06/2026) et [#28707](https://github.com/openai/codex/pull/28707) (19/06/2026), budget de rollout |
| [S-npm] | [registry.npmjs.org/@openai/codex](https://registry.npmjs.org/@openai/codex), [@openai/codex-sdk](https://registry.npmjs.org/@openai/codex-sdk) ; [release latest](https://github.com/openai/codex/releases/latest) |
| [H-plan] | Centre d'aide : [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) (mise à jour « 4 days ago ») |
| [H-apps] | Centre d'aide : [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) (mise à jour « yesterday ») |
| [ToU] | [Terms of Use](https://openai.com/policies/row-terms-of-use/), en vigueur au 1er janvier 2026 |
| [API-rl] | [Rate limits](https://developers.openai.com/api/docs/guides/rate-limits) |
| [API-resp] | [Create a model response](https://developers.openai.com/api/reference/resources/responses/methods/create) ; [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning) |

## Matrice de capacités

### 1. Interfaces d'exécution

| Capacité | Statut | Source et constat | Conséquence pour MIND Wake |
| --- | --- | --- | --- |
| CLI non interactive `codex exec` | **vérifié** | [S-exec] : exécution d'une tâche sans interface ; `--json` produit un flux JSON Lines (`thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, `error`) ; `--ephemeral` n'écrit pas de rollout ; `--ignore-user-config` et `--ignore-rules` ignorent la configuration et les règles de l'utilisateur ; reprise par `codex exec resume`. Version 0.165.0 [S-npm]. | Interface candidate principale. Wake doit fournir sa propre configuration (pas celle de l'utilisateur) et figer la version. |
| SDK TypeScript `@openai/codex-sdk` | **vérifié** | [S-sdk] : Node.js 18+ ; le SDK lance la CLI et échange du JSONL par stdin/stdout ; option `env` du constructeur ; `resumeThread()` ; `TurnOptions.signal` (AbortSignal) annule le tour. 0.165.0, `engines.node >=18` [S-npm]. | Interface recommandée pour l'adapter (stack Node/TS) : même moteur que `codex exec`, typage des événements, annulation native. |
| `codex app-server` (JSON-RPC 2.0 sur stdio) | **partiel** | [S-app] : `thread/start`, `turn/start`, `turn/interrupt`, notifications d'usage et de limites. Réserve explicite : « experimental and aren't supported for production workloads » (formulation portant sur la commande app-server et le transport WebSocket) ; certaines méthodes sont derrière `experimentalApi`. | Non retenu comme base v0.1. Réévaluer s'il sort du statut expérimental (il expose l'interruption et l'usage en continu). |
| Tâches planifiées officielles (Codex app) | **vérifié, non adapté** | [S-sched] : planification gérée depuis ChatGPT web ou l'app desktop, pas depuis la CLI ; l'app doit rester ouverte pour les projets locaux ; exécution sans surveillance avec les réglages de sandbox par défaut. | Montre qu'OpenAI propose sa propre exécution planifiée, mais hors de tout contrôle du daemon (budget, policy, kill switch). Ne remplace pas l'adapter. |
| API Responses directe | **vérifié, hors Codex** | [API-resp] : API officielle avec `max_output_tokens` et objet `usage`. | Voie de pivot possible (agent maison), mais ce n'est plus « Codex comme runtime ». Non retenue en v0.1. |
| Support Windows natif | **vérifié** | [S-win] : l'application tourne nativement dans PowerShell avec une sandbox Windows, sans WSL ni VM ; Windows 11 recommandé, Windows 10 1809+ requis en pratique ; WSL1 non supporté depuis 0.115 [S-sec]. | Compatible avec la cible Windows. Voir §7 pour les limites de la sandbox. |

### 2. Droit d'automatisation

| Capacité | Statut | Source et constat | Conséquence pour MIND Wake |
| --- | --- | --- | --- |
| Exécution automatisée avec clé API | **vérifié** | [S-auth] : « Use API key authentication for programmatic Codex CLI workflows ». [S-ci] : « The right way to authenticate automation is with an API key. » Facturation au tarif API standard, sans les crédits du forfait ChatGPT [S-auth]. | Voie autorisée. Elle entraîne une **dépense monétaire** : consentement explicite avec fournisseur et plafond requis (AGENTS.md §3.5) avant tout appel. |
| Exécution planifiée sans humain avec un abonnement ChatGPT personnel (Plus/Pro) | **non établi** | Aucune source ne l'autorise ni ne l'interdit explicitement pour un daemon tiers. Éléments relevés : (a) [S-ci] présente l'authentification ChatGPT en CI comme une voie « advanced », réservée à une infrastructure privée de confiance et pour « enterprise and other trusted private automation », la clé API restant recommandée ; (b) [S-auth] : les jetons d'accès Codex pour l'automatisation (« trusted scripts, schedulers ») ne sont décrits que pour ChatGPT Enterprise ; (c) [H-apps] : l'usage du forfait dans des apps tierces passe par « Sign in with ChatGPT » chez des partenaires participants, avec plafond hebdomadaire par app ; Wake n'en fait pas partie ; (d) [ToU] interdit d'« Automatically or programmatically extract data or Output », sans préciser l'application à un client officiel piloté par script. | Conformément à AGENTS.md §1 et §3.4, cette voie reste **désactivée** en v0.1. Elle ne pourra être ouverte que sur un texte officiel explicite (ou une intégration « Sign in with ChatGPT » partenaire). |
| Exécution planifiée avec jetons d'accès Codex (Enterprise) | **partiel** | [S-auth] : jetons créés par les membres autorisés d'un workspace Enterprise, pour des exécutions locales non interactives de confiance. | Hors cible v0.1 (utilisateur individuel). À noter pour une éventuelle version entreprise. |
| Dépense implicite sur forfait ChatGPT | **vérifié (risque)** | [H-plan] : une limite atteinte pendant un tour actif n'arrête pas forcément ce tour (sous réserve de fair use) ; [H-apps] : achats automatiques de crédits possibles si l'utilisateur les a activés, sans notification séparée. | Raison supplémentaire de ne pas ouvrir la voie abonnement : le plafond du forfait n'est pas une borne de session et peut déboucher sur une dépense. |

### 3. Comptage d'usage

| Capacité | Statut | Source et constat | Conséquence pour MIND Wake |
| --- | --- | --- | --- |
| Usage par tour (`codex exec --json`, SDK) | **vérifié** | [S-exec] : objet `usage` dans `turn.completed` (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`). [S-sdk] `events.ts` ajoute `cache_write_input_tokens`. Disponible **à la fin du tour**. | Rapprochement a posteriori par tour. Le ledger doit conserver chaque catégorie séparément ; une catégorie inconnue est couverte par la borne (SPEC §6). |
| Usage d'un tour échoué ou annulé | **absent** | [S-sdk] : `TurnFailedEvent` et `ThreadErrorEvent` ne portent pas d'`usage`. | Un tour échoué ou interrompu a un usage **inconnu** côté Codex : la réservation reste à sa borne maximale tant qu'une autre mesure ne la rapproche pas. |
| Usage en continu | **partiel** | [S-app] : notification `thread/tokenUsage/updated` (champs non documentés dans la page lue ; interface expérimentale). [S-adv] : export OpenTelemetry optionnel, `codex.sse_event` avec compteurs à `response.completed` et histogramme `turn.token_usage` par type. | Mesure par réponse modèle possible via OTel, mais pas avant envoi. Utile pour le journal, pas pour imposer un plafond. |
| Usage par requête côté API | **vérifié** | [API-resp] : chaque réponse porte un objet `usage` ; `max_output_tokens` inclut les tokens de raisonnement. | Une passerelle locale (voir §4) peut mesurer chaque requête de façon indépendante de Codex. |
| Usage restant sur forfait ChatGPT | **partiel** | [S-app] : `account/rateLimits/read` renvoie `usedPercent`, `windowDurationMins`, `resetsAt` ; pas de tokens. | Pourcentage seulement : ne permet pas une enveloppe en tokens. Sans objet tant que la voie abonnement est désactivée. |

### 4. Plafonnement des tokens par session

| Capacité | Statut | Source et constat | Conséquence pour MIND Wake |
| --- | --- | --- | --- |
| Plafond natif stable de tokens par session | **absent** | [S-cfg] : aucune clé stable ne plafonne le total d'une session ou d'un thread. Les limites existantes portent sur la compaction (`model_auto_compact_token_limit`), le stockage des sorties d'outils, le catalogue de skills ou les sorties MCP. | Codex seul ne fournit pas la borne exigée par AGENTS.md §5. |
| Budget de rollout `features.rollout_budget` | **partiel** | [S-cfg] : « under development and off by default » ; `limit_tokens`, poids prefill/sampling, rappels. [S-rb] : registre partagé entre threads ; le tour est interrompu **après** comptabilisation de la réponse qui épuise le budget (dépassement possible d'une réponse par thread actif) ; rappels injectés au modèle. | Pas utilisable comme garantie : fonction en développement, contrôle **après** coup, et un mécanisme placé dans le processus Codex n'est pas « hors du contexte du modèle » au sens de §3.3. Peut servir de garde-fou secondaire après vérification. |
| `max_output_tokens` par requête | **vérifié côté API, non établi côté Codex** | [API-resp] : borne supérieure des tokens générés, raisonnement compris ; réponse `incomplete` si atteinte, entrée et raisonnement facturés. Aucune clé Codex documentée ne le fixe (`model_max_output_tokens` absent de [S-cfg]). | La borne de sortie ne peut être imposée qu'en dehors de Codex, sur la requête elle-même. |
| Fournisseur personnalisé / passerelle | **vérifié (mécanisme), non établi (borne)** | [S-adv] : `model_providers.<id>` (`base_url`, `env_key`, `wire_api = "responses"`, en-têtes) et `openai_base_url` pour pointer le fournisseur intégré vers un proxy ou une passerelle ; guide « Connect to a gateway ». Retries configurables (`request_max_retries` 4 et `stream_max_retries` 5 par défaut [S-cfg]). | **Seule voie identifiée vers une borne démontrable** : une passerelle locale du daemon, entre Codex et `api.openai.com`, qui (1) admet une requête seulement si `fenêtre de contexte du modèle + max_output_tokens` tient dans l'enveloppe restante, (2) fixe ou réduit `max_output_tokens`, (3) compte chaque retry comme une requête, (4) garde la réservation pleine si l'usage n'est pas retourné. Borne de session = somme des pires cas admis. Cette borne est conservatrice (très pessimiste avec de grandes fenêtres de contexte) et **reste à démontrer** par un spike (compatibilité avec la CLI, outils hébergés, flux interrompus). Clé API uniquement : interposer un proxy sur le backend ChatGPT serait un endpoint privé (§3.4). |
| Timeout | **vérifié, insuffisant** | `stream_idle_timeout_ms` 300 000 par défaut [S-cfg]. | Ne borne pas les tokens (AGENTS.md §5). Sert seulement à la durée. |

### 5. Annulation

| Capacité | Statut | Source et constat | Conséquence pour MIND Wake |
| --- | --- | --- | --- |
| Annulation par le SDK | **vérifié** | [S-sdk] : `TurnOptions.signal` (AbortSignal) annule le tour ; le SDK pilote un processus CLI enfant. | Chemin coopératif de `cancel`. |
| Interruption par app-server | **partiel** | [S-app] : `turn/interrupt` termine le tour avec `status: "interrupted"` (interface expérimentale). | Non retenu en v0.1. |
| Terminaison forcée | **non établi (dépend de S2)** | Aucune garantie documentée sur la terminaison de l'arborescence de processus, sauf pour MXC où les enfants restants s'arrêtent quand la commande au premier plan se termine [S-win]. | Le kill switch doit tuer Codex et ses descendants via la couche d'isolation (Job Object ou équivalent étudié par S2), sans dépendre de Codex. |
| Délai d'annulation | **non établi** | Aucune source ne donne de délai. | À mesurer sur la version figée avant de fixer les délais de §8 « Priorité ». |
| Consommation résiduelle | **non établi** | Aucune source ne précise la facturation d'une génération déjà commencée quand le client coupe le flux. [H-plan] : sur forfait, un tour peut continuer après la limite. | Réserver le pire cas complet de chaque requête admise par la passerelle jusqu'au rapprochement ; la passerelle peut aussi fermer la connexion amont. |

### 6. Limitations fournisseur

| Capacité | Statut | Source et constat | Conséquence pour MIND Wake |
| --- | --- | --- | --- |
| Signaux de rate limit API | **vérifié** | [API-rl] : RPM, RPD, TPM ; en-têtes `x-ratelimit-*` ; erreur `429` ; `Retry-After` à traiter comme attente minimale avec un peu de jitter ; backoff exponentiel ; les requêtes échouées comptent dans la limite par minute ; la limite tient compte du maximum entre `max_tokens` et l'estimation. | La passerelle lit ces signaux et déclenche hibernation ou backoff borné (SPEC §5.2, A11). |
| Retries internes de Codex | **vérifié** | [S-cfg] : `request_max_retries` (4) et `stream_max_retries` (5) par défaut. | Figer des valeurs basses dans la configuration Wake ; chaque retry passe par la passerelle et consomme l'enveloppe. |
| Limites du forfait ChatGPT | **partiel** | [S-app] : `account/rateLimits/read` et `account/rateLimits/updated` (`usedPercent`, `resetsAt`). [H-apps] : se reconnecter ou réessayer ne restaure pas l'usage. | Sans objet tant que la voie abonnement est désactivée. |

### 7. Isolation intégrée de Codex sous Windows (comparée à AGENTS.md §3.6)

| Capacité | Statut | Source et constat | Conséquence pour MIND Wake |
| --- | --- | --- | --- |
| Sandbox native Windows | **vérifié** | [S-win] : trois implémentations. `mxc` (recommandée) : isolation de processus native sans setup administrateur, Windows 11 24H2 build 26100.9278 ou 25H2 build 26200.9278 ; `elevated` : utilisateurs sandbox dédiés, ACL, règles de pare-feu, setup administrateur ; `unelevated` : jeton restreint dérivé de l'utilisateur et ACL. La sandbox applique les permissions de fichiers et de réseau **aux commandes et à leurs enfants**. | Le poste cible est en build 26200 : éligibilité MXC à confirmer selon la révision. |
| Réseau coupé par défaut | **vérifié** | [S-sec] : réseau désactivé par défaut ; `workspace-write` le laisse coupé sauf `sandbox_workspace_write.network_access = true`. | Conforme au refus par défaut. Le transport fournisseur (processus Codex lui-même) reste hors sandbox. |
| Écritures limitées et chemins protégés | **vérifié** | [S-sec] : écritures limitées à l'espace de travail ; `.git`, `.agents`, `.codex`, `.aws` en lecture seule dans les racines inscriptibles. | Utile en défense en profondeur. |
| Lecture des secrets / du profil utilisateur | **non établi** | [S-sec] ne dit pas si les commandes sandboxées peuvent lire `auth.json`, le profil ou l'environnement. [S-win] : `unelevated` ne gère pas les chemins interdits en lecture ; les globs d'interdiction sont évalués au démarrage du processus. | Non conforme seule à §3.6 (« aucun secret ambiant hérité ») : l'isolation externe S2 est requise. |
| Isolation réseau en mode `unelevated` | **partiel** | [S-win] : isolation réseau plus faible qu'`elevated`. | Interdire `unelevated` pour l'exploration autonome. |
| Escalade par le modèle | **vérifié (contrôlable)** | [S-sec] : `approval_policy = never` désactive les demandes d'approbation dans tous les modes ; `danger-full-access` existe. [S-exec] : `--approve-for-me` délègue à une revue automatique. | Wake impose `never` + `workspace-write` ou `read-only`, interdit `danger-full-access` et `--approve-for-me` (une revue par modèle n'est pas un contrôle hors modèle). |
| Garantie globale | **partiel** | La sandbox Codex ne couvre ni le processus Codex (credentials, réseau fournisseur), ni la lecture des secrets de façon documentée, ni la terminaison de l'arborescence hors MXC. | Défense en profondeur, pas frontière unique. Verdict d'isolation à prendre dans S2. |

### 8. Authentification et exposition des credentials

| Capacité | Statut | Source et constat | Conséquence pour MIND Wake |
| --- | --- | --- | --- |
| Emplacement des credentials | **vérifié** | [S-auth] : `cli_auth_credentials_store` = `file` (`auth.json` sous `CODEX_HOME`, par défaut `~/.codex`), `keyring` (magasin système), `auto`, `ephemeral` (mémoire du processus). `auth.json` contient des jetons d'accès et se traite comme un mot de passe. | Utiliser un `CODEX_HOME` dédié à Wake, jamais celui de l'utilisateur (pas de réutilisation de sa session ChatGPT : AGENTS.md §5, « aucune copie des identifiants historiques »). |
| Clé API limitée à l'invocation | **vérifié** | [S-exec] : ne pas définir `OPENAI_API_KEY` ou `CODEX_API_KEY` au niveau d'un job qui exécute du code contrôlé par le dépôt ; ne la fixer que pour l'invocation Codex. [S-sdk] : le SDK injecte `CODEX_API_KEY` dans l'environnement de la CLI. | La clé serait présente dans l'environnement du processus Codex. |
| Filtrage de l'environnement des commandes | **vérifié** | [S-cfg] : `shell_environment_policy.inherit` (`all`, `core`, `none`), filtres, exclusion par défaut des variables contenant KEY, SECRET ou TOKEN. | Imposer `inherit = "none"` et une liste blanche. Non suffisant seul : ne protège pas les fichiers. |
| Credentials hors de portée du code exploratoire | **non établi (conception)** | Aucune source ne le garantit pour un usage local. | Recommandation : la passerelle locale détient seule la clé API (stockage de secrets système) et l'ajoute aux requêtes sortantes ; Codex reçoit un jeton factice. Même lue par une commande sandboxée, sa configuration ne contient alors aucun secret réel. À valider par S10/S11. |

## Synthèse

1. **Interface retenue :** SDK TypeScript `@openai/codex-sdk` 0.165.0 (moteur `codex exec`), version figée, configuration Wake dédiée (`--ignore-user-config`, `CODEX_HOME` propre, `--ephemeral` si les rollouts ne servent pas).
2. **Droit d'automatisation :** établi avec clé API, donc avec dépense monétaire consentie. Non établi pour un abonnement ChatGPT personnel : voie désactivée.
3. **Plafond :** aucun plafond natif fiable. Une borne conservatrice n'est atteignable que par une passerelle locale contrôlée par le daemon, avec clé API, et doit être démontrée avant G1 ou au plus tard avant S11.
4. **Annulation :** coopérative via AbortSignal ; terminaison forcée et délais à fournir par S2 et à mesurer ; usage d'un tour annulé inconnu côté Codex.
5. **Isolation :** la sandbox Codex est utile mais ne suffit pas pour AGENTS.md §3.6 ; l'isolation externe de S2 reste requise.

## Inconnues à lever (pour G1 et les spikes)

- Codex 0.165.0 fonctionne-t-il derrière `openai_base_url` ou un `model_providers` local qui réécrit `max_output_tokens` et refuse des requêtes, sans casser la compaction ni les retries ?
- Quels outils hébergés (recherche web, etc.) sont activés par défaut avec le fournisseur intégré, et ajoutent-ils une facturation hors tokens ?
- Facturation d'une réponse dont le flux est coupé par le client (consommation résiduelle réelle).
- Délai entre `abort()` et la fin effective du processus CLI et de ses enfants, sur Windows.
- Éligibilité MXC sur le poste cible (révision exacte du build 26200) et comportement de lecture des secrets dans chaque mode de sandbox.
- Position officielle d'OpenAI sur un daemon tiers qui planifie des sessions Codex avec un forfait personnel (question à poser au support ou à suivre dans la documentation).
- Stabilisation éventuelle de `features.rollout_budget` et sémantique exacte des catégories comptées.

## Mise à jour du 29 octobre 2026 : parcours « Sign in with ChatGPT » open source

Un parcours officiel en préversion permet à une app open source ou hébergée localement d'utiliser le forfait ChatGPT de l'utilisateur par OAuth, via l'API Responses publique ou `codex app-server` (jeton dans `ACCESS_TOKEN`). Il ne traite pas l'usage sans humain, n'accepte pas `max_output_tokens` et exige un identifiant client OAuth. Analyse et conséquences : `docs/decisions/ADR-004-voie-abonnement.md`, section « Parcours officiel Sign in with ChatGPT ».
