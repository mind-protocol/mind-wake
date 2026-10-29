# src/adapters/codex

Adapter Codex conforme à `src/contracts/adapter.ts` (ADR-002, ADR-004, ADR-005). Aucun appel modèle réel n'a été fait : les tests utilisent un faux exécutable `codex` (`test/fixtures/codex/fake-codex.ts`) qui rejoue des flux enregistrés (`test/fixtures/codex/flows/*.json`). Ils ne prouvent pas l'intégration réelle (AGENTS §5).

## Interface retenue : `codex app-server`, version figée 0.165.0

Une session Wake = un processus `codex app-server --listen stdio://` (JSON-RPC 2.0 sans champ `jsonrpc`, une ligne JSON par message), un fil Codex et un tour.

`app-server` est préféré à `codex exec --json` parce que seul `app-server` expose :

- la jauge officielle de quota (`account/rateLimits/read`, notification `account/rateLimits/updated`) ;
- l'interruption d'un tour (`turn/interrupt`) ;
- l'usage par réponse (`thread/tokenUsage/updated`) ;
- des codes d'erreur typés (`codexErrorInfo`).

Le flux de `codex exec --json` ne contient aucune information de limite.

En contrepartie, OpenAI classe `codex app-server` comme « Experimental » dans la référence CLI. La version est donc figée : `probe` lit `codex --version` et toute autre version que `CODEX_SUPPORTED_VERSION` rend l'adapter indisponible. `start` refuse aussi de lancer une version non validée.

### Sources vérifiées le 29 octobre 2026

- Registre npm `@openai/codex` : dernière version **0.165.0**.
- Schémas JSON officiels au tag `rust-v0.165.0` (`codex-rs/app-server-protocol/schema/json/`) : `InitializeParams`, `ThreadStartParams`, `ThreadStartResponse`, `ThreadResumeParams`, `TurnStartParams`, `TurnCompletedNotification`, `ItemCompletedNotification`, `ThreadTokenUsageUpdatedNotification`, `ErrorNotification` (`CodexErrorInfo`), `GetAccountRateLimitsResponse`, `AccountRateLimitsUpdatedNotification`.
- Pages de la documentation Codex (`learn.chatgpt.com/docs/…`) :
  - `app-server` : transport, handshake `initialize` / `initialized`, `turn/interrupt`, `account/read`, modes d'authentification ;
  - `non-interactive-mode` ;
  - `cli/reference` : drapeaux globaux, `codex app-server` « Experimental », `--dangerously-bypass-approvals-and-sandbox` « Only use inside an externally hardened environment ».

Le binaire installé sur le poste de développement est `codex-cli 0.147.0` (seul `codex --version` a été exécuté) : `probe` le déclare **indisponible**.

## Options retenues

| Sujet                 | Choix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration         | `CODEX_HOME` dédié à Wake, refusé s'il est le `~/.codex` de l'utilisateur ou s'il est dedans. `--ignore-user-config` n'existe que pour `codex exec` : avec `app-server`, ne lire que le `config.toml` de ce dossier dédié revient au même. Surcharges `-c` fixées par Wake et non écrasables : `shell_environment_policy.inherit="none"`, `request_max_retries=1`, `stream_max_retries=1`.                                                                                                                                                                                                  |
| Modèle et effort      | `model` (`thread/start`, `thread/resume`, `turn/start`) et `effort` (`turn/start`) sont configurables.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Environnement         | Explicite : `CODEX_HOME` et les variables du relais. Tout nom de secret (`KEY`, `TOKEN`, `SECRET`, `PASSW`, `CREDENTIAL`, `AUTH`, `COOKIE`) est refusé, comme dans `src/sandbox/spec.ts`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Approbations          | Toujours `approvalPolicy: "never"` : personne n'est là pour répondre. Les requêtes du serveur (demandes d'approbation…) reçoivent une erreur `-32601`.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Mode sans approbation | `sandbox: "danger-full-access"` dans `thread/start` / `thread/resume`, l'équivalent `app-server` de `--dangerously-bypass-approvals-and-sandbox`. Il n'est accordé que si le lanceur atteste un AppContainer opérationnel **et** un autotest de refus réussi pour l'empreinte du lanceur en service (`appContainerLauncher`). Sinon, en mode `autonomous` (défaut), `start` lève `CodexAdapterError("isolation_required")`. En mode `manual`, Codex garde sa propre sandbox `workspace-write`. Le drapeau CLI lui-même n'est pas passé : la référence ne dit pas qu'`app-server` l'accepte. |
| Transport             | Port injectable `ProviderTransport.open(sessionId) → ProviderChannel` : `broker`, surcharges `-c`, variables non secrètes et `close()`. Il est fourni par le relais fournisseur et n'est pas implémenté ici. Il est obligatoire sous AppContainer (`transport_required`).                                                                                                                                                                                                                                                                                                                   |
| Lanceurs              | `appContainerLauncher` (S10, seul lanceur autonome) et `hostLauncher(AdapterHost)` (Job Object du runner, mode manuel).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Authentification      | `account/read` avant tout fil. Si aucun compte n'est connecté alors que l'authentification est requise : `auth_failed` sans fil ni tour. L'adapter ne lit ni ne copie aucun credential.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Continuité            | Le `thread.id` est persisté par clé, le profil par défaut (`FileThreadStore`, écriture atomique, un fichier altéré est ignoré). Le fil est repris par `thread/resume`. Le prompt système part en `developerInstructions` au premier fil, puis seulement quand son empreinte SHA-256 change. Un fil refusé ouvre un nouveau fil.                                                                                                                                                                                                                                                             |

## Événements (`events`)

| Codex                                                                                          | Wake                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn/started` ou réponse de `turn/start`                                                      | `started`                                                                                                                                                                                                                                                  |
| `item/started` `commandExecution`                                                              | `activity` (commande, 200 caractères au plus)                                                                                                                                                                                                              |
| `item/completed` `agentMessage`, `fileChange`, `mcpToolCall`, `webSearch`, `contextCompaction` | `activity`. Le raisonnement n'est jamais journalisé.                                                                                                                                                                                                       |
| `thread/tokenUsage/updated` du tour courant                                                    | `usage` `measured` : différence entre deux cumuls, ou `last` au premier relevé du tour. Les catégories `input`, `cached_input`, `output` et `reasoning` sont séparées (convention Responses : `input` inclut le cache, `output` le raisonnement).          |
| `account/rateLimits/updated`                                                                   | callback `onQuota` (lecture `measured`)                                                                                                                                                                                                                    |
| `error` avec `willRetry: true`                                                                 | `activity`                                                                                                                                                                                                                                                 |
| `turn/completed` `failed`                                                                      | `rate_limited` (`usageLimitExceeded`, `rateLimitExceeded`, HTTP 429). `retryAfterMs` vaut la remise à zéro officielle d'une fenêtre pleine, sinon `null`. Sinon `error` : `auth_failed` (`unauthorized`, 401/403), `transient`, `incompatible` ou `fatal`. |
| sortie fermée avant la fin du tour                                                             | `error` `transient`                                                                                                                                                                                                                                        |
| fin                                                                                            | `ended` (`completed`, `interrupted`, `failed`, `stream_cut`, `auth_required`…), puis arrêt du serveur                                                                                                                                                      |

## Annulation, rapprochement, quota

- `cancel` : `turn/interrupt` pendant la moitié du délai, puis `terminateTree` par le lanceur dans le reste du délai. Résultat `cancelled` si le tour s'est terminé, `forced` sinon, `unconfirmed` si la terminaison n'est pas confirmée.
- `reconcile` : `confirmed` (tokens `measured`) seulement pour un tour `completed`, mesuré par cette instance, processus terminé. Un tour échoué, interrompu ou coupé reste `uncertain` : la dernière requête a pu ne rien rapporter.
- `readProviderQuota()` : `account/rateLimits/read` sur un serveur sans fil ni tour, donc sans requête modèle. Seules les fenêtres complètes (`usedPercent`, `windowDurationMins`, `resetsAt`) deviennent des `ProviderQuotaSnapshot` `measured` ; les autres sont listées dans `incomplete`.
- Capacités déclarées : `tokenCounting: "exact"`, `tokenCapEnforcement: "provider_quota_guard"`, `providerQuotaReading: "official"`, `cancellation: "graceful"`, `residualUsageBound: null` (non documenté), `resumeModes` `fresh_process_from_memory` et `native_resume`.

## Reste à vérifier en réel (porte humaine : quota d'abonnement)

1. Codex 0.165.0 installé dans une racine `ReadAndExecute`, lancé dans l'AppContainer. À vérifier : pipes stdio, `realpath`, profil `LOCALAPPDATA` redirigé.
2. Transport par le relais : `model_provider` / `openai_base_url` vers le broker, et `account/rateLimits/read` à travers lui (cette lecture exige une connexion ChatGPT dans le `CODEX_HOME` Wake, ou l'équivalent côté relais).
3. Formes réelles des notifications : ordre de `thread/tokenUsage/updated` par rapport à `turn/started`, relevé émis à la reprise d'un fil, `rateLimitsByLimitId`, `resetsAt` nul.
4. Délai `turn/interrupt` → `turn/completed` et consommation résiduelle après interruption (d'où `residualUsageBound: null`).
5. Dépassement de la jauge après le seuil d'arrêt (`overshootBoundBasisPoints`, ADR-004).
6. Effet réel de `sandbox: "danger-full-access"` sous AppContainer, et besoin éventuel de `externalSandbox` (`SandboxPolicy` de `turn/start`, conçu pour un confinement externe).
7. `account/read` avec le relais : `requiresOpenaiAuth` quand le fournisseur est le relais.

Mention de la doc à garder en vue : « App-server authentication has never been permitted for commercial or hosted services ». Wake est local et open source, mais la voie reste expérimentale (ADR-004).

## Test de fumée réel (opt-in)

`src/adapters/codex/codex-real.smoke.test.ts`, ignoré par `npm test`, activé par `MIND_WAKE_REAL_SMOKE=1`. Bornes : connexion déjà configurée de l'utilisateur (jamais lue ni copiée), hôte, mode `manual`, sandbox Codex `read-only`, `approvalPolicy: "never"`, aucun mode sans approbation, fil éphémère, prompt « Réponds seulement OK ». Serveurs MCP, plugins, hooks, mémoires, navigateur, `computer_use`, génération d'images, multi-agent, objectifs et recherche web sont désactivés par `-c`. Les serveurs MCP sont listés après la désactivation des plugins : surcharger un serveur fourni par un plugin crée une entrée invalide qui empêche le démarrage.

Exécution du 29 octobre 2026 avec `codex-cli 0.147.0` (version non validée, admise en mode manuel seulement) et un compte ChatGPT Pro. Trois appels au total :

1. Tour avec le modèle par défaut de l'utilisateur (`gpt-6.1-sol`) : refusé, HTTP 400 `model_not_found` (« not supported when using Codex with a ChatGPT account »), `codexErrorInfo: "other"`. Le classement lit désormais ce code et renvoie `incompatible`.
2. `account/rateLimits/read` : une fenêtre `codex:primary`, `usedPercent` 28, `windowDurationMins` 10080 (hebdomadaire), `resetsAt` 1793774321 (2026-11-04T06:38:41Z), `secondary` nul.
3. Tour avec `gpt-5.6-luna`, effort `low` : réponse `OK`. Usage mesuré : 8 196 tokens (8 191 en entrée, 0 en cache, 5 en sortie, 0 de raisonnement), rapprochement `confirmed`. `account/rateLimits/updated` est reçu pendant le tour, avec la même fenêtre.

Les flux expurgés (email, solde, nom du poste, identifiant d'installation, chemins du profil) sont rejoués par les tests ordinaires : `test/fixtures/codex/flows/real-0.147.0-ok.json` et `real-0.147.0-model-not-found.json`.

Constats :

- Ordre réel : `thread/tokenUsage/updated` arrive après `turn/started`, puis `account/rateLimits/updated`, puis `turn/completed`.
- Le compte n'expose qu'une fenêtre hebdomadaire.
- Près de 8 200 tokens d'entrée pour un prompt de trois mots : instructions de base de Codex et outils.
- `thread/start` renvoie `sandbox` sous forme d'objet (`{ "type": "readOnly", "networkAccess": false }`).

## Codex réel dans l'AppContainer (opt-in)

`src/adapters/codex/codex-sandbox.smoke.test.ts`, activé par `MIND_WAKE_SANDBOX_CODEX=1` (Windows). Le test :

- exécute l'autotest de refus S10 ;
- copie `codex.exe` dans une racine temporaire en lecture seule ;
- lance `codex app-server` par `appContainerLauncher` : profil éphémère, `CODEX_HOME` dédié et vide, transport sans broker, donc aucun réseau.

Résultat du 29 octobre 2026, avec `codex-cli 0.147.0` :

- Codex démarre confiné et répond à `initialize` par les pipes du lanceur ;
- `account/read` signale l'absence de compte, et l'adapter s'arrête sur `auth_failed` / `auth_required` avant tout fil ;
- Codex écrit son état dans le `CODEX_HOME` dédié ;
- le profil et les dossiers sont supprimés à la fin.

Durée totale ≈ 9 s, autotest compris. Ce test ne couvre pas un tour réel confiné : il faut pour cela le relais fournisseur (broker) et une connexion dans le `CODEX_HOME` Wake.

## Alignement ADR-006 et câblage des runtimes

- **Mode sans approbation non isolé (ADR-006).** Sur l'hôte, sans AppContainer, il n'est accordé que si `hostUnattendedConsent(policy)` répond `true`. Ce prédicat est fourni par la fabrique, qui connaît le champ de consentement de la policy ; celui-ci n'existe pas encore dans `src/contracts/policy.ts`. Sans ce consentement, le lancement autonome est refusé (`isolation_required`). Un mode accordé :
  - est signalé au journal par une activité « mode sans approbation NON ISOLÉ… » en début de session ;
  - passe `unattended: true` au runner, qui garde le dernier mot (`unattended_outside_sandbox` côté câblage).
- **Lancement par le runner.** `hostLauncher(host)` lance Codex par `host.spawnContained`, ce qui couvre l'arrêt d'urgence et le Job Object. Il lit `host.isolation(sessionId)` quand le runner câblé l'expose : `sandbox` vaut confinement vérifié, tout autre état vaut hôte non isolé.
- **Jauge (`QuotaReadable`).** `readQuota()` rend les fenêtres officielles complètes, ou `[]` si la lecture échoue (quota inconnu, donc lancement bloqué). Le scheduler la lit hors session : passer `quotaLauncher: supervisorLauncher(supervisor, profileId)`, un Job Object sans approbation puisqu'il n'y a aucun tour.
- **Enregistrement.** `codexRegistration(config)` produit la forme `AdapterRegistration` du câblage :
  - `runtime` : `openai`, modèle configuré, `authMode: "chatgpt"` ;
  - `billing` : `subscription_quota` ;
  - `runtimeRoots` : dossier du binaire ;
  - `create` : branche `ctx.host` et `ctx.workspaceDir`.

  Il reste à l'ajouter à `defaultRegistry()` quand le câblage sera dans `main`.

### Branchement effectif (fusion de `claude/cablage-runtimes-43e636`)

- **Registre :** Codex figure dans `defaultRegistry()` via `codexRegistrationFromEnv()`. Variables du daemon, aucune n'est un secret :
  - `MIND_WAKE_CODEX_BIN` : binaire ; sinon `where codex`, résolu au premier besoin ;
  - `MIND_WAKE_CODEX_MODEL` : modèle ; défaut `gpt-5.6-luna`, comparé à `policy.runtime.model` ;
  - `MIND_WAKE_CODEX_EFFORT` : effort de raisonnement.
- **Dossiers par défaut :** `CODEX_HOME` vaut `<données>/codex-home` (l'humain y fait `codex login`) et les fils sont dans `<données>/codex-threads`.
- **Consentement ADR-006 :** il est lu par défaut dans `policy.groups.runtime.hostUnsandboxedAcknowledged === true`. Le runner le constate de son côté (`host.isolation(sessionId) === "host_unsandboxed"`).
  - Sur l'hôte, le lanceur ajoute les variables du profil Windows (`PATH`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`…) ; dans la sandbox, l'environnement reste minimal.
- **Jauge :** le runner n'admet qu'un processus par session. Les lectures de jauge passent donc par un Job Object séparé (`supervisorLauncher`). Pendant une session, `readQuota()` réutilise la jauge reçue en fin de tour si elle date de moins de 60 s.
- **Prompt :** le prompt de réveil composé par le daemon (`StartRequest.context`) est transmis tel quel. `systemPrompt` est facultatif.
- **Effets visibles :** `doctor` et `status` déclarent désormais `runtime_adapter: experimental`. La sonde refuse tant que Codex installé n'est pas en 0.165.0, ou si le binaire est introuvable : le daemon répond alors `adapter_unavailable`, sans repli.
