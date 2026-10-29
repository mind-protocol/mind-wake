# src/broker — relais fournisseur

> **Suspendu (29 octobre 2026).** L'utilisateur a choisi de lancer les runtimes sans sandbox (ADR-006). Ce module n'est câblé nulle part : ni adapter, ni runner, ni daemon ne l'utilisent. Il reste ici pour une reprise si l'exécution confinée (ADR-003, ADR-005) revient. Aucun contrat existant n'a été modifié ; `src/sandbox/` est intact.

Problème traité : un CLI (Codex, Claude Code, Gemini CLI) lancé dans l'AppContainer de `src/sandbox/` doit joindre l'API de son fournisseur en HTTPS, alors que sa seule sortie réseau est le pipe nommé du broker, relayé par le lanceur vers `127.0.0.1:<port>` sur l'hôte.

## Piste retenue

```
CLI (conteneur) ──HTTPS_PROXY──▶ shim 127.0.0.1:<port libre> (conteneur)
        └─ pipe \\.\pipe\mindwake-broker-… ─▶ lanceur (hôte) ─▶ ProviderRelay 127.0.0.1:<port> ─▶ fournisseur:443
```

1. **Shim dans le conteneur** (`shim-source.ts`, JavaScript autonome écrit par `installShim` dans une racine en lecture seule). Il écoute sur le loopback **interne** au conteneur, relaie chaque connexion vers le pipe du broker, puis lance le CLI avec `HTTPS_PROXY`/`HTTP_PROXY=http://127.0.0.1:<port>` et `NO_PROXY=localhost,127.0.0.1,::1`, en lui faisant hériter ses poignées standard. Il rend ensuite le code de sortie du CLI. Ce n'est pas une frontière : l'agent peut ouvrir le pipe lui-même, mais il retombe alors sur le relais.
2. **Relais sur l'hôte** (`relay.ts`, `ProviderRelay implements ProviderBroker`). C'est un proxy HTTP qui n'accepte que la méthode `CONNECT`. Pour chaque tunnel :
   - il exige un nom exact de l'allowlist du runtime, sur le port 443 ; une IP littérale est refusée ;
   - il résout le nom côté hôte et refuse le loopback, le réseau privé, le CGNAT, le lien local et les métadonnées (`169.254.169.254`), ainsi que les adresses IPv6 locales, projetées, NAT64 et 6to4 ;
   - il lit le SNI du ClientHello, sans terminer TLS, et l'exige égal à la cible ;
   - il ouvre enfin la connexion vers l'adresse vérifiée.

   Toute requête ordinaire reçoit 405. Journal expurgé : le nom refusé est remplacé par une empreinte et une longueur, sans en-tête ni octet du flux. `stats()` donne les tunnels, les volumes, les refus par motif et les erreurs amont.

3. **Port pour les adapters** (`transport.ts`). `ProviderTransport.open({ executable, args })` démarre un relais et rend un `ProviderLaunch` :
   - `broker` : le `BrokerEndpoint` à passer à `SandboxLaunchSpec.broker` ;
   - `executable` et `args` : `node.exe` (copie accessible au conteneur), les drapeaux `--preserve-symlinks*`, le shim, `--pipe`, `--`, puis la commande du CLI ;
   - `env` : variables non secrètes (`NODE_USE_ENV_PROXY=1`, trafic non essentiel coupé pour Claude) ;
   - `readOnlyRoots` : le dossier du shim.

   `close()` rend le bilan.

4. **Allowlist** (`destinations.ts`), noms exacts relevés le 29 octobre 2026. La policy (`network.providerTransportDestinations`) peut restreindre cette liste, pas l'élargir.
   - Codex : `api.openai.com`, `chatgpt.com`, `auth.openai.com` (code source `openai/codex`).
   - Claude Code : `api.anthropic.com`, `claude.ai`, `platform.claude.com` ([doc réseau officielle](https://code.claude.com/docs/en/network-config)).
   - Gemini CLI : `cloudcode-pa.googleapis.com`, `generativelanguage.googleapis.com`, `oauth2.googleapis.com`, `www.googleapis.com` (code source `google-gemini/gemini-cli`).

Lecture du proxy par chaque CLI :

| CLI         | Lecture de `HTTPS_PROXY`                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Claude Code | documentée officiellement                                                                            |
| Gemini CLI  | constatée dans le code (`packages/cli/src/config/config.ts`), pas dans la doc                        |
| Codex       | constatée dans le code (reqwest, `OutboundProxyPolicy::ReqwestDefault`), absente de la doc consultée |

## Démontré (Windows 11 Famille 10.0.26200, Node 24.17.0, sans admin ni règle pare-feu)

Mesures exploratoires dans le conteneur :

- écoute et connexion sur `127.0.0.1` et `::1` : permises dans un même processus ;
- entre deux processus du même conteneur : permises ;
- loopback de l'hôte : expire (`ETIMEDOUT`) ;
- `net.connect({ path: pipe })` vers le broker : fonctionne (une première ouverture a échoué une fois en `ENOENT`, d'où les reprises du shim).

`container.test.ts`, conteneur réel : un client Node confiné derrière le shim utilise le `fetch` natif avec `HTTPS_PROXY`. Le serveur HTTPS **local** de test a un certificat généré en mémoire (`test/support/self-signed-cert.ts`) ; aucune clé n'est versionnée et aucun fournisseur n'est appelé. Le test dure environ 4 s.

| Tentative depuis le conteneur                                  | Résultat                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `https://provider.mindwake.test/ping` (autorisé)               | 200 `pong`, 1 tunnel, ≈ 1,9 Kio montants / 2,6 Kio descendants          |
| `https://evil.mindwake.test/` (hors allowlist)                 | refusé par le relais (`destination_not_allowed`), nom absent du journal |
| TCP direct vers le serveur local `127.0.0.1:<port>`            | `ETIMEDOUT`, 0 requête servie                                           |
| TCP direct `1.1.1.1:443`                                       | `EACCES`                                                                |
| Port du shim joint depuis l'hôte                               | injoignable                                                             |
| Nettoyage : profil, clé de registre, dossier, ACE, temporaires | retirés et vérifiés                                                     |

`relay.test.ts` (36 tests, toute plateforme) couvre les refus suivants :

- tunnel TLS de bout en bout ;
- hôte hors liste, port, IPv4 et IPv6 littérales, cible mal formée ;
- requête HTTP ordinaire ;
- SNI différent de la cible ;
- flux non TLS ;
- nom autorisé résolu vers des adresses interdites.

Ces tests vérifient aussi l'expurgation du journal (nom refusé, `Proxy-Authorization`), la classification des adresses et la restriction par la policy.

## Non démontré

- **Aucun vrai CLI** (Codex, Claude Code, Gemini CLI) n'a tourné derrière le shim. Restent à vérifier :
  - le respect effectif de `HTTPS_PROXY` par le binaire Codex réel ;
  - le chemin du Node confiné pour Claude Code et Gemini, à lancer par `node.exe` et leur script d'entrée, pas un `.cmd` ;
  - le comportement de leurs sous-processus dans le conteneur.
- **Credentials.** Les trois CLI lisent et envoient eux-mêmes leur credential, dans leur propre flux TLS. Un relais `CONNECT` sans terminaison TLS ne peut ni l'injecter ni le cacher. `spec.ts` refuse en outre les variables au nom de secret. Le credential devrait donc être un **fichier lisible dans le conteneur** : `auth.json` de Codex, `.credentials.json` de Claude, `oauth_creds.json` de Gemini.
  - Conséquence : un agent sans approbation peut le lire. Il ne peut l'envoyer qu'aux domaines du fournisseur, mais peut aussi l'écrire dans ses artefacts. Cela contredit ADR-002, où la passerelle détient seule le credential.
  - Seule alternative : une clé API avec une URL de base vers le relais, qui ajouterait alors l'en-tête (`ANTHROPIC_BASE_URL`, `openai_base_url`, `GOOGLE_GEMINI_BASE_URL`). Elle est inapplicable à la voie abonnement. Rien n'a été lu ni copié des credentials réels.
- **Signaux de limitation.** Les en-têtes HTTP 429/quota sont illisibles sans terminer TLS. Le relais ne voit que les volumes, les durées et les erreurs amont. Ces signaux devront venir de la sortie des CLI.
- **Domain fronting.** Le SNI est contrôlé, pas l'en-tête `Host` chiffré : un hôte servi par un CDN partagé (`chatgpt.com`, `www.googleapis.com`) pourrait relayer vers un autre site du même CDN.
- **Accès au relais.** Le relais écoute sur `127.0.0.1` sans authentification : un processus de l'hôte peut l'utiliser, sans gagner plus d'accès qu'il n'en a déjà.
- **Gemini CLI.** Sa documentation annonce son remplacement par Antigravity CLI pour les comptes gratuits et Google One, à revérifier à la reprise.

## Reprise

1. Faire tourner chaque CLI réel derrière le shim, avec son credential officiel dans une racine du conteneur et l'accord explicite de l'utilisateur pour les appels payants ou de quota. Relever les hôtes refusés dans le journal.
2. Consigner la décision « credential dans le conteneur » (révision d'ADR-002) ou choisir la voie clé API avec injection d'en-tête par le relais.
3. Brancher `ProviderTransport` dans les adapters et le runner. Ajouter éventuellement un événement `broker-upstream-failed` au lanceur, qui avale aujourd'hui l'échec de connexion vers le relais.
