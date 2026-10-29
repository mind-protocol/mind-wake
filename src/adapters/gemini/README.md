# src/adapters/gemini

Adapter Gemini CLI (ADR-005), conforme à `src/contracts/adapter.ts`. Les tests rejouent des sorties par un faux exécutable (`test/fixtures/gemini/fake-gemini.ts`) : synthétiques, sauf `real-*` (sortie réelle expurgée).

## Test de fumée réel (29 octobre 2026)

Opt-in : `MIND_WAKE_REAL_SMOKE=1` (`real-smoke.test.ts`, ignoré par `npm test`). Exécuté **une fois**, après feu vert de l'utilisateur, sur l'hôte, avec sa connexion existante (aucun credential lu), sans mode sans approbation, dossier temporaire vide :

```
node %APPDATA%\npm\node_modules\@google\gemini-cli\bundle\gemini.js --output-format stream-json --model flash --approval-mode default "--prompt=Réponds uniquement par le mot OK. N'utilise aucun outil." --extensions none --allowed-mcp-server-names mindwake-aucun
```

Résultat : code **55**, stdout vide, **aucune requête modèle** (échec à la configuration du compte), donc aucun usage ni quota exposé. Stderr (fixture `real-ineligible-tier.jsonl`) :

- `IneligibleTierError`, `reasonCode: 'UNSUPPORTED_CLIENT'`, `tierId: 'free-tier'`, « Gemini Code Assist for individuals » : ce client n'est plus pris en charge pour ce niveau, l'utilisateur est invité à migrer vers les produits Antigravity ;
- dossier non approuvé : en non interactif, la CLI exige `--skip-trust`, `GEMINI_CLI_TRUST_WORKSPACE=true` ou une approbation interactive. **Corrigé** : l'adapter passe désormais `--skip-trust`.

Conséquence : avec ce compte (niveau gratuit Code Assist pour particuliers), Gemini CLI est **inutilisable** ; le runtime reste bloqué même en lancement manuel. Pas de nouvel essai : l'erreur d'éligibilité se reproduirait. Un compte Google AI Pro/Ultra ou une clé Gemini API n'ont pas été testés.

## Statut

- **Deux lancements (ADR-006).** `sandboxLaunchPort` : AppContainer + Job Object, réseau par le relais (suspendu). `hostLaunchPort` : poste hôte, **non isolé**, réseau de l'hôte, toujours dans le Job Object du runner pour que l'arrêt d'urgence termine toute l'arborescence. Un lancement sur l'hôte est marqué « non isolé » dans `probe` (`executionMechanism`) et par une première activité `mode NON ISOLÉ : …` dans les événements, que le runner journalise.
- **Consentement au mode non isolé.** Sur l'hôte, `--approval-mode yolo` et le mode autonome exigent le consentement distinct de la policy, lu par l'option injectée `hostUnsandboxedAcknowledged(policy)` (nom retenu d'après ADR-006, en attendant le champ de la session Câblage) ; sinon `GeminiLaunchRefused("unsandboxed_consent_missing")`. Dans la sandbox, `yolo` exige l'autotest de refus réussi (`approval_outside_sandbox`). Sans `yolo`, la CLI non interactive traite `ask_user` comme `deny`.
- **Mode autonome : toujours bloqué.** Gemini CLI n'expose aucune lecture officielle du quota (`providerQuotaReading: "none"`) et la garde de quota reste obligatoire (ADR-006) : `no_quota_reading`, même avec le consentement. Seul le lancement manuel par l'humain est possible.
- **Capacités déclarées :** comptage `exact` (statistiques officielles de `result`, absentes si la sortie est coupée), `tokenCapEnforcement: "none"`, annulation `forced_only` (arrêt du Job Object), `residualUsageBound: null`, `isolationCompatible: false` (Gemini CLI n'a jamais tourné dans l'AppContainer), reprise `fresh_process_from_memory` (+ `native_resume` si `resumeFrom` est configuré).

## Vérifié dans la documentation officielle (29 octobre 2026, CLI 0.52.0 installée)

Sources : `google-gemini/gemini-cli`, `docs/cli/headless.md`, `docs/cli/cli-reference.md`, `docs/cli/session-management.md`, `docs/reference/configuration.md`, `docs/reference/policy-engine.md`, `docs/reference/commands.md`, `docs/resources/quota-and-pricing.md`, `docs/resources/tos-privacy.md` ; source officielle `packages/core/src/output/types.ts`, `packages/core/src/utils/errors.ts`, `packages/core/src/utils/googleQuotaErrors.ts`, `packages/cli/src/utils/readStdin.ts`.

| Point                | Constat                                                                                                                                                                                                                                                                              | Retenu                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Non interactif       | `-p` / `--prompt` force le mode non interactif ; le texte s'ajoute à stdin. Stdin sans données est abandonné après 500 ms (source).                                                                                                                                                  | `--prompt=<contexte>` (≤ 24 000 caractères, limite de ligne de commande Windows)              |
| Sortie               | `--output-format text\|json\|stream-json`. Flux JSONL : `init` (`session_id`, `model`), `message`, `tool_use`, `tool_result`, `error` (`severity`), `result` (`status`, `error`, `stats`).                                                                                           | `stream-json`                                                                                 |
| Codes de sortie      | Documentés : 0, 1, 42 (entrée), 53 (tours). Source : 41 authentification, 44 sandbox, 52 configuration, 54 outil, 55 espace non approuvé, 130 annulation.                                                                                                                            | `classifyExitCode`                                                                            |
| Modèle               | `--model` (`auto`, `pro`, `flash`, `flash-lite` ou nom exact), `model.name`, `GEMINI_MODEL`.                                                                                                                                                                                         | `--model` + `model.name` ; défaut `policy.groups.runtime.model`                               |
| Reprise              | `--resume latest\|<index>\|<UUID>` ; sessions dans `.gemini/tmp/<hash du projet>/chats/`. La doc ne dit pas si `--resume` fonctionne avec `--prompt`.                                                                                                                                | Optionnelle (`resumeFrom`), UUID de l'événement `init` ; reprise par mémoire par défaut       |
| Sans approbation     | `--approval-mode default\|auto_edit\|yolo\|plan` ; `--yolo` déprécié.                                                                                                                                                                                                                | `--approval-mode yolo` : sandbox vérifiée, ou hôte avec consentement (ADR-006)                |
| Outils autorisés     | `--allowed-tools` déprécié au profit du policy engine (TOML, `[[rule]]`, `toolName`, `decision`, `priority`), `tools.core`, `tools.exclude`. Une règle utilisateur l'emporte sur les règles par défaut.                                                                              | `tools.core` optionnel, `tools.exclude` + règles `deny` pour `google_web_search`, `web_fetch` |
| Configuration isolée | `GEMINI_CLI_HOME` : racine de la configuration utilisateur et du stockage.                                                                                                                                                                                                           | Dossier propre à Wake, réécrit à chaque lancement ; `~/.gemini` jamais lu ¹                   |
| Télémétrie           | `privacy.usageStatisticsEnabled` (défaut `true`), `telemetry.enabled`.                                                                                                                                                                                                               | Les deux à `false`                                                                            |
| Bornes               | Aucune option de plafond de tokens ni de budget. `model.maxSessionTurns` (défaut illimité) : borne de tours, pas de tokens.                                                                                                                                                          | `maxSessionTurns` = 50 par défaut ; `tokenCapEnforcement: "none"`                             |
| Quota                | Quotas par jour et par utilisateur (Code Assist individuel 1 000, Google AI Pro 1 500, Ultra 2 000 requêtes). Seule lecture : `/stats model`, commande **interactive**, contenu non spécifié ; aucune API ni sortie non interactive du quota restant ou de l'heure de remise à zéro. | `providerQuotaReading: "none"`                                                                |
| Limitation           | 429 classés `TerminalQuotaError` (jour) ou `RetryableQuotaError` (minute), messages « You have exhausted your daily quota… », « Suggested retry after Ns. » (source, pas un contrat).                                                                                                | `rate_limited` avec délai extrait du message                                                  |

¹ La connexion se fait donc une fois par le parcours officiel de la CLI avec ce `GEMINI_CLI_HOME` (lancement interactif `gemini` par l'humain) ; Wake ne copie jamais les credentials de `~/.gemini`. Sur l'hôte non isolé, l'agent peut néanmoins lire tout le profil (ADR-006).

## Conditions d'usage automatisé de l'abonnement

- Les conditions dépendent du mode d'authentification : compte Google (Code Assist pour particuliers : conditions Google et avis de confidentialité Code Assist ; Google AI Pro/Ultra : conditions Google et Google One), clé Gemini API (Gemini API Terms), Vertex AI (Google Cloud).
- La page de conditions ne traite ni l'usage scripté, ni planifié, ni sans humain : **rien ne l'autorise explicitement**. Le mode non interactif est documenté pour l'automatisation, sans distinction d'abonnement.
- **Interdiction explicite** (`docs/resources/tos-privacy.md`) : accéder directement aux services qui alimentent Gemini CLI (par exemple Code Assist) avec un logiciel tiers, l'exemple donné étant l'emploi de l'OAuth de Gemini CLI dans un autre outil, est une violation pouvant entraîner suspension ou résiliation du compte. Conséquence : Wake peut piloter la **CLI officielle**, mais le relais fournisseur **ne doit ni détenir ni réinjecter le jeton OAuth « Login with Google »** dans ses propres requêtes. Avec un compte Google, le credential doit rester dans la CLI ; le relais ne peut que relayer des octets (proxy) et appliquer l'allowlist. Voir le complément d'ADR-005.

## Architecture

| Fichier             | Rôle                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol.ts`       | Lecture du flux `stream-json`, répartition des tokens, classement des erreurs, codes de sortie.                                           |
| `config.ts`         | Arguments, `settings.json`, politique TOML ; validation des noms de modèle et d'outils (pas d'injection).                                 |
| `launch.ts`         | Ports : `GeminiLaunchPort` (`sandboxLaunchPort`, `hostLaunchPort`), `ProviderTransportPort` (fourni par le relais), règle `decideLaunch`. |
| `gemini-adapter.ts` | `GeminiAdapter` : `probe`, `capabilities`, `start`, `events`, `cancel` (borné par `timeoutMs` + 250 ms), `reconcile`, index des sessions. |

- **Environnement :** `GEMINI_CLI_HOME`, `NO_COLOR`, plus les variables du transport (sandbox) ou une courte liste de l'hôte sans nom de secret (`HOST_PASSTHROUGH_ENV` : `PATH`, `TEMP`, `APPDATA`, `USERPROFILE`…). Rien d'autre n'est hérité ; la sandbox refuse tout nom de secret.
- **Racines :** espace d'exploration et `GEMINI_CLI_HOME` en écriture (la CLI y écrit son historique) ; runtime (copie de Node, paquet de la CLI) en lecture. L'agent peut modifier `GEMINI_CLI_HOME` pendant une session : réglages et politique sont **réécrits** à chaque lancement et tout autre `.toml` de `policies/` est retiré. L'index des sessions (`stateDir`) doit rester hors des racines (vérifié).
- **Rapprochement :** confirmé `measured` seulement si la session est terminée et que `result.stats` a été publié ; persisté dans `stateDir/gemini-sessions.json` pour survivre à un redémarrage. Sortie coupée ou arrêt forcé : `uncertain`.

## Changements de contrat

Aucun. `GeminiProcess` reprend la forme commune à `ContainedProcess` et `SandboxedProcess` ; les ports sont locaux à l'adapter.

## Reste à tester en réel (avec le feu vert de l'utilisateur)

1. Gemini CLI dans l'AppContainer : Node confiné (`--preserve-symlinks`), relance de la CLI dans un processus enfant, écriture dans `GEMINI_CLI_HOME`, `realpath`.
2. Sandbox seulement (relais suspendu par ADR-006) : faire emprunter le pipe du broker à la CLI sans que le relais touche au jeton OAuth.
3. `--resume <UUID>` combiné à `--prompt`.
4. Avec `--skip-trust`, la CLI lit le `.gemini/settings.json` de l'espace, modifiable par l'agent : vérifier qu'il ne lève pas les exclusions d'outils et que la politique utilisateur de Wake garde le dernier mot (les politiques d'espace sont sans effet d'après la doc).
5. Primauté effective d'une règle utilisateur `deny` sur l'accord général de `yolo`.
6. Forme réelle des erreurs d'authentification et de quota en `stream-json` (événement `result` en échec ou seulement stderr), bascule de modèle éventuelle et nouvelles tentatives internes de la CLI après un 429.
7. Écart entre `total_tokens` et entrée + sortie (rangé en `unexposed`).
8. Mode non isolé sur l'hôte : un lancement réel avec un compte éligible (connexion faite dans le `GEMINI_CLI_HOME` de Wake), `yolo`, puis arrêt d'urgence de toute l'arborescence par le Job Object.
