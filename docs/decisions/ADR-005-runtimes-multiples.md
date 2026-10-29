# ADR-005 — Runtimes multiples, mode sans approbation sous sandbox et déclenchement avant remise à zéro

- Statut : accepté ; condition « seulement sous sandbox » remplacée par ADR-006
- Date : 2026-10-29
- Session / auteur : session principale, à la demande de l'utilisateur
- Validation humaine : décision de l'utilisateur dans le chat (« codex claude gemini », « on dangerously skip permissions », « pas de budget for now », « on déclenche quand il reste du budget et que le reset est dans quelques heures », puis « okay lance en // »)
- Révise : `AGENTS.md` §2 (runtimes v0.1), principe 6 (isolation), §5 « Budgets et disponibilité » ; `CLAUDE.md` ; complète ADR-002 et ADR-004

## Problème

La v0.1 prévoyait Codex seul, avec des plafonds de tokens propres à Wake imposés avant chaque session. L'utilisateur veut :

1. trois runtimes : Codex, Claude Code et Gemini CLI ;
2. des sessions sans demandes d'approbation (`--dangerously-skip-permissions` et équivalents) ;
3. pas de budget propre à Wake pour l'instant ;
4. un déclenchement quand il reste de la capacité d'abonnement et que la fenêtre du fournisseur se remet à zéro dans quelques heures : ce quota serait perdu de toute façon.

Il a aussi demandé de reprendre l'implémentation des dépêches et réveils du dépôt `le-conseil2` (`mind-protocol/the-council`), un ancien dépôt MIND.

## Options considérées

| Option                                                                                                        | Avantages                                                                               | Inconvénients                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Garder Codex seul et des plafonds Wake                                                                        | Périmètre réduit, bornes déjà conçues                                                   | Ne répond pas à la demande                                                                                  |
| Trois runtimes, modes sans approbation partout                                                                | Simple, comme `le-conseil2`                                                             | Agent sans aucune frontière sur le poste : contraire au principe 6                                          |
| Trois runtimes, modes sans approbation **seulement dans la sandbox AppContainer**, garde de quota comme borne | Autonomie réelle, frontière imposée par le système, quota utilisé quand il serait perdu | Accès réseau des CLI via le broker à construire ; lecture officielle de la jauge à vérifier par fournisseur |

## Choix

**Troisième option.**

1. **Runtimes.** Codex (`codex exec` ou `codex app-server`), Claude Code (`claude -p`, sortie `stream-json`, `--session-id` / `--resume`) et Gemini CLI (mode non interactif), chacun derrière le contrat `src/contracts/adapter.ts`, dans `src/adapters/<runtime>/`. Seulement les interfaces et options documentées officiellement, vérifiées au moment de l'implémentation ; aucun endpoint privé ni récupération de jetons de session.
2. **Mode sans approbation.** Les options `--dangerously-skip-permissions` (Claude), `--dangerously-bypass-approvals-and-sandbox` (Codex), `--yolo` (Gemini) ou leurs équivalents ne sont passées **que** si le processus du runtime est lancé dans la sandbox AppContainer + Job Object de `src/sandbox/` et que l'autotest de refus a réussi. Hors sandbox, l'adapter refuse de démarrer en mode autonome. Une liste d'outils autorisés reste préférée quand le runtime en offre une.
3. **Budget.** Aucun plafond de tokens propre à Wake n'est exigé pour l'instant. La borne de la voie abonnement est la garde de quota (ADR-004, `SubscriptionQuotaGuard`), étendue d'une condition de remise à zéro : lancement seulement si une **lecture officielle** de la jauge du fournisseur montre une capacité restante au-dessus du seuil fixé par l'humain **et** que la remise à zéro tombe dans un délai fixé par l'humain ; arrêt au seuil d'arrêt. Sans lecture officielle de la jauge pour un runtime, ce runtime reste bloqué en mode autonome (utilisable seulement en lancement manuel par l'humain).
4. **`le-conseil2`.** Il a servi de référence fonctionnelle (options des CLI, continuité de session, empreinte du prompt pour savoir quand le réinjecter, verrous de concurrence). **Aucun code n'est copié** : `AGENTS.md` §2 reste en vigueur et Wake est en TypeScript. Les adapters sont réécrits à partir des documentations officielles.

Exclu : modes sans approbation sur le poste hôte, repli automatique d'un runtime ou d'un compte vers un autre, conversion d'un pourcentage de quota en tokens.

## Conséquences

- Les CLI doivent joindre leur fournisseur depuis la sandbox, dont la seule sortie est le pipe du broker (`src/sandbox/broker.ts`). Un relais fournisseur hors conteneur est nécessaire : il détient les credentials, applique l'allowlist des destinations et lit les signaux de limitation. C'est le chantier le plus risqué.
- Chaque adapter déclare `providerQuotaReading` ; seul `official` permet l'autonomie.
- Le dépassement après le seuil d'arrêt reste à mesurer (ADR-004). En attendant, l'humain fixe le seuil d'arrêt avec une marge.
- Les premiers appels réels consomment le quota d'abonnement de l'utilisateur : ils restent soumis à son feu vert explicite.

## Complément : Claude Code (29 octobre 2026)

Vérification de la documentation officielle par la session d'adapter (détail dans `src/adapters/claude/README.md`) :

- **Lecture officielle de la jauge : oui.** `/usage` envoyé comme prompt à `claude -p --output-format stream-json` renvoie `usage_report.rate_limits.limits[]` (`kind`, `percent`, `resets_at`), type déclaré expérimental, présent seulement avec une connexion claude.ai. L'adapter déclare `providerQuotaReading: "official"`. En session, `rate_limit_event` signale avertissement et refus avec `resetsAt`.
- **Conditions d'usage.** Les limites Pro/Max supposent un usage « ordinaire et individuel » ; un tiers ne peut ni intermédier, ni collecter, ni stocker des identifiants ou jetons claude.ai. Un utilisateur peut se connecter lui-même au binaire officiel non modifié. Aucun texte ne traite des sessions planifiées sans humain : voie expérimentale (AGENTS §5).
- **Fumée réelle (2.1.308, feu vert de l'utilisateur).** `--session-id` puis `--resume` : continuité vérifiée. `/usage` en `-p` a d'abord renvoyé `rate_limits: null` sous `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` ; sans cette variable, la jauge officielle est **démontrée** (session 13 %, hebdomadaire 45 %, dates de remise à zéro). `readQuota()` ne pose donc plus cette variable. `rate_limit_event` expose à chaque appel `unifiedWindows` (fenêtres 5 h et 7 j, utilisation 0-1, remise à zéro), champ non documenté : signal utile, pas une lecture officielle.
- **Conséquence pour le relais fournisseur.** Pour Claude avec abonnement, le relais ne doit **pas** détenir ni injecter le jeton : l'humain se connecte par `/login` dans un `CLAUDE_CONFIG_DIR` dédié, le CLI confiné s'authentifie lui-même, le relais ne fait que transporter vers les destinations autorisées. L'hypothèse « le broker détient seul le credential » reste valable pour une clé API.

## Complément : pilotage vers 99 % d'usage (29 octobre 2026)

Demande de l'utilisateur : « l'idée, c'est d'arriver juste au dessus de 99% d'usage. Il faut qu'il ait suffisamment de temps pour les utiliser en tournant en continu, il faut faire une petite estimation, et ajuster les délais de réveil si on passe sous la ligne ». Le délai fixe `launchWhenResetWithinMs` est remplacé par un pilotage (contrat `SubscriptionQuotaGuard`, changement signalé) :

- **Cible** `targetUsageBasisPoints` (9 900 par défaut, ≤ `stopAtBasisPoints`) sur la fenêtre qui se remet à zéro le plus tôt. La réserve humaine peut être à 0 : c'est le choix de l'utilisateur, puisque le quota non utilisé avant la remise à zéro est perdu.
- **Débit** en points de base par heure de session continue : mesuré par le daemon entre le début et la fin de chaque session (fenêtre inchangée, au moins 5 min), moyenne glissante (poids 0,3) persistée par runtime et par fenêtre (migration `quota_pacing`) ; avant toute mesure, `initialRateBasisPointsPerHour`, valeur prudente de la policy. La jauge inclut l'usage de l'humain : le débit mesuré est surestimé, donc prudent. Jamais converti en tokens.
- **Réveil** quand `temps avant remise à zéro ≤ (cible − usage) / débit × (1 + marge)` (`pacingMarginRatio`, 0,25 par défaut). En attente, le scheduler réévalue au plus tard toutes les 15 min : un débit plus lent, une interruption ou un usage humain avancent le réveil. Les autres fenêtres doivent rester sous `startBelowBasisPoints` au lancement et sous `stopAtBasisPoints` en session.
- **Continu** : sous la garde, aucun délai minimal entre sessions ; arrêt dès que la fenêtre pilotée atteint la cible (`min(stopAt, cible)`). Une limitation du fournisseur (100 %) entraîne un backoff, pas un blocage.
- **Ajustement** : à chaque changement de fenêtre, usage final sous la cible (tolérance 50 bp) → marge × 1,5 (au plus 3) ; cible atteinte plus d'une heure avant la remise à zéro → marge × 0,8 (au moins 0,05). Chaque mesure de débit et chaque ajustement sont journalisés avec la projection d'usage à la remise à zéro.
- Fenêtres horaires, priorité humaine, pause et arrêt d'urgence restent vérifiés avant le pilotage.

Non mesuré à ce jour : le débit réel des runtimes et le dépassement après la cible (`overshootBoundBasisPoints`) ; les premiers essais réels restent soumis au feu vert de l'utilisateur.

## Critères de révision

- Un fournisseur interdit l'usage automatisé de son CLI avec un abonnement, ou n'expose aucune lecture officielle de quota.
- La sandbox ne permet pas de faire tourner un CLI de manière fiable.
- Un dépassement mesuré qui mange la réserve de l'humain.
- L'utilisateur décide de rétablir des plafonds propres à Wake.

## Complément : Gemini CLI (29 octobre 2026)

Vérification de la session d'adapter Gemini (`src/adapters/gemini/README.md`, CLI 0.52.0) :

- **Aucune lecture officielle du quota** restant ni de l'heure de remise à zéro : seule la commande interactive `/stats model` en parle, sans contenu spécifié. Gemini CLI est donc `providerQuotaReading: "none"` et **bloqué en mode autonome** ; lancement manuel seulement.
- **Options retenues :** `--prompt`, `--output-format stream-json`, `--model`, `--approval-mode yolo` (le drapeau `--yolo` est déprécié), `GEMINI_CLI_HOME` propre à Wake, outils restreints par `tools.core`, `tools.exclude` et une politique utilisateur (`--allowed-tools` est déprécié).
- **Conditions :** la page de conditions de Gemini CLI qualifie de violation, pouvant entraîner la suspension du compte, l'accès direct aux services qui alimentent la CLI par un logiciel tiers, en citant l'emploi de l'OAuth de Gemini CLI dans un autre outil. Pour un compte Google, le relais fournisseur **ne détient ni ne réinjecte** ce jeton : il reste dans la CLI officielle et le relais ne fait que relayer et filtrer. Une clé Gemini API relève des conditions de l'API, pas de l'abonnement. L'usage automatisé n'est ni autorisé ni interdit explicitement.
- **Essai réel (feu vert de l'utilisateur, un seul lancement sans mode sans approbation) :** refus `IneligibleTierError` / `UNSUPPORTED_CLIENT`. Google ne prend plus en charge ce client pour « Gemini Code Assist for individuals » (niveau gratuit) et renvoie vers Antigravity. Avec ce compte, Gemini CLI est **inutilisable**, même en lancement manuel. Aucune requête modèle, donc aucun usage mesuré. Un compte Google AI Pro/Ultra ou une clé API ne sont pas testés.

## Sources consultées

`docs/feasibility/codex.md`, `docs/feasibility/isolation-windows.md`, `src/sandbox/README.md`. Lecture du lanceur de `le-conseil2` (`scripts/agents/runtime.py`) comme référence, sans reprise de code. Les documentations officielles de Claude Code et de Gemini CLI restent à vérifier par les sessions d'adapter.
