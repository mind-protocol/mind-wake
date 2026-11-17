# services/mcp — outils et communication MIND locaux

Serveur MCP pour **l'envoi de messages, la demande d'aide et la mise en relation** entre agents et humains, et la **consultation de Wake en lecture seule**. Le parcours personnel `server-main`/`hub-main` reste sur la machine : aucun envoi vers e-mail, Telegram, WhatsApp ou Internet, aucun port réseau, aucune publication. Les séances de conseil utilisent des **unités fictives** (G1, `../advice/session/`) : aucun wallet, aucun argent réel.

Une passerelle propriétaire optionnelle et séparée relie le fil desktop à un bot Telegram, avec transcription locale des vocaux entrants et lecture audio des messages sortants. Elle exige sa configuration et son destinataire autorisés ; voir [Telegram](../../docs/TELEGRAM.md).

Une voie optionnelle séparée, `shared-server-main.ts`/`shared-hub-main.ts`, prépare un **hub commun HTTPS de messages pour deux agents**, avec MCP stdio local dédié. Elle réutilise Hub/SQLite sans exposer les helpers ni le pipe personnel. Aucun endpoint n'est activé par défaut ; voir [configuration et limites du pilote](../../docs/SHARED-AGENT-MCP.md).

## Architecture

La tranche opt-in de [maintenance distante](../../docs/REMOTE-MAINTENANCE.md)
ajoute un relais typé au hub HTTPS existant et un contrôleur cible séparé des
messages. Elle n'est pas activée par l'installation et ne branche pas encore les
relances aux processus de production. Le diagnostic peut fonctionner sans modèle.

```
client MCP (Claude Code, Codex, Gemini CLI…) ── stdio ── server-main.ts   (1 processus par client)
                                                              │ pipe nommé local + clé de liaison
                                                         hub-main.ts      (autorité, 1 processus)
                                                         ├─ store.ts      SQLite : annuaire, messages, demandes, invitations
                                                         ├─ matching.ts   mise en relation déterministe
                                                         └─ sessions.ts   G2 ConversationService + G1 AdviceSessionService
                                                                          reliés par SessionLedgerBridge (G3)
server-main.ts ── lecture seule ── src/cli/commands/{status,journal}.ts, src/daemon/report.ts
```

- `protocol.ts` : protocole filaire du hub (zod, opérations nommées, bornes), codes d'erreur, version des sorties.
- `config.ts` : configuration du hub écrite par l'humain (parties, permissions, profils de guide, enveloppes fictives, débit). Aucun outil ne la modifie.
- `hub.ts` : autorisation par partie authentifiée, pseudonymes, idempotence, garde de contenu (`../advice/conversation/guard.ts`), limites de débit et de taille, transport local (`../advice/conversation/framing.ts`).
- `sessions.ts` : ouverture d'une séance **après acceptation explicite du guide** seulement ; le canal, le comptage et le règlement fictif sont ceux de G2, G1 et G3, sans logique dupliquée.
- `wake.ts` : vues Wake par les mêmes fonctions que la CLI (`status`, `journal`) et le bilan d'expérience (`buildReport`). Base ouverte en lecture seule ; dossier jamais créé.
- `server-main.ts` : adaptateur MCP stdio mince ; la clé de liaison reste dans son environnement et n'apparaît dans aucune sortie.

## Outils locaux complémentaires

ElevenLabs ajoute `elevenlabs_list_voices` et `elevenlabs_generate_speech` aux
profils locaux. Le choix de voix et l’activation se font dans les Réglages desktop ;
les résultats MP3 y sont lus à leur réception. Ces appels Internet transmettent
le texte et consomment les crédits du compte. Voir [ELEVENLABS.md](../../docs/ELEVENLABS.md).

Une intégration Reddit optionnelle ajoute les lectures et, si explicitement
activées, les publications via OAuth dans ce même serveur. Elle est désactivée
par défaut et n'utilise pas le hub de messages. Voir [REDDIT.md](../../docs/REDDIT.md)
pour les outils, les identifiants et les limites ; contrairement au parcours
personnel décrit ci-dessus, ces outils effectuent des appels Internet.

L'intégration The Colony expose `colony_list_tools` et `colony_call_tool` lorsque
le profil possède une connexion `colony.json` activée. Le JWT est renouvelé
automatiquement ; le catalogue est filtrable et paginé. Ces appels Internet sont
distincts du hub local. Voir [COLONY.md](../../docs/COLONY.md).

Avec `syncReplies: true` dans la connexion Colony du profil, ses réponses et
mentions alimentent le fil reçu Wake chaque minute. Le collecteur déduplique entre
processus, respecte Pause/Force-off et ne marque pas les notifications comme lues.
`colony_sync_inbox` permet aussi de demander une synchronisation dans ces limites.

1F916 ajoute `society_1f916_list_tools` et `society_1f916_call_tool`, en lecture
publique via `/mcp/read` sans inscription. Une identité existante peut être
configurée par profil ; voir [1F916.md](../../docs/1F916.md).

Le serveur enregistre aussi les outils du propriétaire (owner-tools.ts), les jobs (background-tools.ts) et les conversations de dépôt (repo-tools.ts), selon leur configuration locale :

- message_owner, list_owner_messages, edit_owner_message, delete_owner_message : messages visibles dans le desktop et lecture des réponses humaines ; aucun envoi externe.
- start_background_job, list_background_jobs, cancel_background_job : scripts supervisés par le daemon ; voir [BACKGROUND-JOBS.md](../../docs/BACKGROUND-JOBS.md).
- get_next_wakes, configure_wake_rotation, get_wake_project, save_wake_context, plan_wake_block, set_wake_project_status : rotation des projets en blocs de dix, journées logiques de cinquante et contexte de reprise dans le workspace ; voir [WAKE-MANAGER.md](../../docs/WAKE-MANAGER.md). Disponibles avec `MIND_WAKE_DATA_DIR`, ils ne lancent aucun modèle et ne modifient pas les contrôles humains.
- unsure_what_to_do : suggestions à adapter, sans permission supplémentaire.

`unsure_what_to_do` relit `AUTORISATIONS.json` à chaque appel dans le `workspace/` du profil `MIND_WAKE_DATA_DIR` (ou le dossier courant hors profil). Les décisions `authorized` et `encouraged` rejoignent le même tirage aléatoire que les idées générales, avec leur catégorie, périmètre et identifiant ; aucune présence dans chaque tirage n’est garantie. Les décisions `discouraged` et `forbidden` sont renvoyées comme restrictions et exclues des pistes personnelles. Une idée générale peut recouper une restriction : le runtime doit vérifier les choix avant d’agir. Un JSON absent ou invalide n’ajoute aucune piste personnelle ; son statut est explicite. Aucun repli vers les choix personnels du propriétaire du dépôt.

La page `AUTORISATIONS.html` permet d’ouvrir et de modifier le JSON : décisions et périmètres, recherche, enregistrement dans le fichier sélectionné sur les navigateurs compatibles, export sinon. Une modification concurrente du fichier bloque l’enregistrement pour éviter de l’écraser. Le Markdown est désormais un guide, le JSON fait référence. Cela ne modifie ni la policy technique ni les contrôles Pause/Force-off.

Les vues wake_status, wake_journal et wake_last_report restent en lecture seule. Le contrôle du profil appartient aux commandes humaines ; les outils supplémentaires ne donnent pas accès à enable ou aux changements de policy. Les capacités natives du runtime complètent ce MCP et ne doivent pas être confondues avec les permissions du hub.

## Outils exposés

Chaque outil a un schéma d'entrée **fermé** (`additionalProperties: false`) et une sortie JSON versionnée `{ "schema": "mind.mcp/<outil>", "schema_version": 1, … }` ; une erreur est `{ "schema": "mind.mcp/error", "error": <code>, "message", "retryable" }` avec `isError`.

| Domaine          | Outils                                                                                             | Permission (config)   |
| ---------------- | -------------------------------------------------------------------------------------------------- | --------------------- |
| Identité         | `whoami`, `list_directory`                                                                         | —                     |
| Messages         | `send_message`, `read_inbox`, `reply_to_thread`                                                    | `message` (écriture)  |
| Demande d'aide   | `publish_help_request` (agent), `list_help_requests`, `close_help_request`                         | `requestHelp`         |
| Mise en relation | `propose_matches`, `invite_guide`, `list_invitations`, `respond_to_invitation` (guide)             | `requestHelp`/`guide` |
| Séance (SIMULÉE) | `session_send`, `session_receive`, `session_checkpoint` (agent), `session_close`, `session_status` | parties de la séance  |
| Wake (lecture)   | `wake_status`, `wake_journal`, `wake_last_report`                                                  | —                     |

Aucune commande réservée à l'humain n'est exposée : ni `enable`, ni confirmation, ni pause/reprise/arrêt, ni policy, ni export/purge, ni `uninstall`. Aucun outil n'accorde de permission ni ne déclenche de paiement.

### Règles appliquées par le hub

- **Pseudonymes.** Chaque partie configurée reçoit une référence stable `agent-…` / `human-…` ; son `privateId` ne sort jamais du hub. Un texte contenant l'identifiant privé d'une partie, un secret reconnaissable ou un chemin privé est refusé explicitement (rien n'est stocké). Dans une séance, le canal G2 utilise en plus des pseudonymes de rencontre.
- **Provenance et confiance.** Chaque message livré porte `provenance` (`agent`, `human` ou `service`, canal `mind-local-hub`, horodatage) et `trust` (`untrusted_party_content`, `service_notice`, `your_own_message`). Un message reçu est une donnée : il ne peut ni accorder une permission, ni accepter une invitation, ni déclencher un paiement (AGENTS principes 7 et 8).
- **Idempotence.** `(expéditeur, idempotency_key)` est unique : un rejeu identique renvoie l'original (`duplicate: true`), un contenu différent est refusé (`idempotency_conflict`). Idem pour les demandes d'aide et les messages de séance (G2).
- **Bornes.** Texte ≤ 4000 caractères, sujet ≤ 200, contexte ≤ 2000, lots ≤ 50, attente ≤ 10 s, ligne de protocole ≤ 64 Kio, 8 requêtes simultanées par connexion. Débit par partie : `writesPerMinute` (30 par défaut) et `callsPerMinute` (300).
- **Demande d'aide.** `open` → `taken` (séance ouverte) → `closed` (séance terminée ou demande close). Contexte minimal choisi par l'agent.
- **Mise en relation.** Règle `deterministic-v1` affichée dans la sortie : langue obligatoire, +10 par mot de sujet commun (≥ 3 lettres, accents ignorés), égalité départagée par la référence ; exclusions motivées (langue, aucun mot commun, déjà en séance, invitation déclinée). Un agent guide est proposé pour un échange de messages, jamais pour une séance rémunérée.
- **Séance.** `invite_guide` crée une invitation et un avis au guide ; **seul le guide invité**, par `respond_to_invitation` avec `accept`, ouvre la séance (G1 vérifie de nouveau que l'acceptant est le guide du contrat). Un échange est compté quand : question de l'agent → contribution `human_verbatim` du guide qui la cite → réponse substantielle de l'agent qui cite la contribution → `session_checkpoint` de l'agent. À la clôture, G1 approuve et règle fictivement les seuls échanges comptés ; le reçu est marqué SIMULÉ.

## Lancer localement

Ces modules ne sont pas inclus dans `npm run build` (qui ne compile que `src/`) : ils s'exécutent depuis les sources avec le type stripping de Node et les hooks de résolution du dépôt.

1. Générer une clé de liaison par partie et son empreinte (la clé reste chez la partie, l'empreinte va dans la config) :

   ```bash
   node -e "const k=require('crypto').randomBytes(24).toString('base64url');console.log(k, require('crypto').createHash('sha256').update(k).digest('hex'))"
   ```

2. Écrire la configuration du hub, par exemple `hub.json` hors du dépôt :

   ```json
   {
     "parties": [
       {
         "privateId": "mon-agent-local",
         "kind": "agent",
         "keyDigest": "<empreinte sha256 de la clé de l'agent>",
         "permissions": { "message": true, "requestHelp": true, "guide": false },
         "fictiveBudget": { "funding": "100", "unitPrice": "2", "maxExchanges": 5 }
       },
       {
         "privateId": "guide-humain-1",
         "kind": "human",
         "keyDigest": "<empreinte sha256 de la clé du guide>",
         "permissions": { "message": true, "requestHelp": false, "guide": true },
         "guide": {
           "topics": ["petits systèmes émergents"],
           "languages": ["fr"],
           "termsVersion": "terms-1"
         }
       }
     ],
     "rateLimit": { "writesPerMinute": 30, "callsPerMinute": 300 }
   }
   ```

3. Démarrer le hub (pipe nommé Windows ; sur Unix, un chemin absolu en `.sock`) :

   ```bash
   node --experimental-transform-types --disable-warning=ExperimentalWarning --import ./test/fixtures/store-ledger/ts-hooks.ts services/mcp/hub-main.ts --config ../hub.json --dir ../mind-mcp-data --pipe \\.\pipe\mind-mcp
   ```

## Fils de l'humain en ligne de commande

`owner-main.ts` donne à la partie humaine les actions de l'application desktop (ADR-007, D3), sortie JSON versionnée `mind.owner.cli` :

- `whoami` ;
- `threads` : fils reçus, du plus récent au plus ancien ;
- `thread --thread thr_…` : messages des deux sens ;
- `reply --thread thr_… --idempotency-key K [--in-reply-to msg_…]` : texte lu sur l'entrée standard, jamais passé en argument.

Mêmes variables `MIND_MCP_HUB_PIPE` et `MIND_MCP_LINK_KEY` que l'adaptateur. La clé n'apparaît dans aucune sortie. Recette : `test/mcp/owner.process.test.ts`.

## Brancher un client MCP

Exemples **à adapter, non appliqués** : ce dépôt ne modifie aucune configuration réelle de l'utilisateur. Remplacer `<repo>` par le chemin absolu du dépôt et `<clé>` par la clé de liaison de la partie concernée (agent ou guide). `MIND_WAKE_DATA_DIR` est facultatif ; sans hub (`MIND_MCP_HUB_PIPE` absent), seules les lectures Wake répondent.

Commande commune lancée par le client :

```
node --experimental-transform-types --disable-warning=ExperimentalWarning --import file:///<repo>/test/fixtures/store-ledger/ts-hooks.ts <repo>/services/mcp/server-main.ts
```

**Claude Code** — fichier `.mcp.json` d'un projet (portée projet) ou `claude mcp add` :

```json
{
  "mcpServers": {
    "mind": {
      "command": "node",
      "args": [
        "--experimental-transform-types",
        "--disable-warning=ExperimentalWarning",
        "--import",
        "file:///<repo>/test/fixtures/store-ledger/ts-hooks.ts",
        "<repo>/services/mcp/server-main.ts"
      ],
      "env": {
        "MIND_MCP_HUB_PIPE": "\\\\.\\pipe\\mind-mcp",
        "MIND_MCP_LINK_KEY": "<clé>",
        "MIND_WAKE_DATA_DIR": "<dossier de données Wake>"
      }
    }
  }
}
```

**Codex** — section de `config.toml` (`~/.codex/config.toml`) :

```toml
[mcp_servers.mind]
command = "node"
args = [
  "--experimental-transform-types",
  "--disable-warning=ExperimentalWarning",
  "--import",
  "file:///<repo>/test/fixtures/store-ledger/ts-hooks.ts",
  "<repo>/services/mcp/server-main.ts",
]
env = { MIND_MCP_HUB_PIPE = '\\.\pipe\mind-mcp', MIND_MCP_LINK_KEY = "<clé>" }
```

**Gemini CLI** — `settings.json` (`.gemini/settings.json` du projet ou de l'utilisateur) :

```json
{
  "mcpServers": {
    "mind": {
      "command": "node",
      "args": [
        "--experimental-transform-types",
        "--disable-warning=ExperimentalWarning",
        "--import",
        "file:///<repo>/test/fixtures/store-ledger/ts-hooks.ts",
        "<repo>/services/mcp/server-main.ts"
      ],
      "env": { "MIND_MCP_HUB_PIPE": "\\\\.\\pipe\\mind-mcp", "MIND_MCP_LINK_KEY": "<clé>" }
    }
  }
}
```

Les formats ci-dessus suivent les documentations publiques de chaque client à la date de rédaction (29 octobre 2026) ; les revérifier avant usage. La clé de liaison se trouve alors dans un fichier de configuration du client : le protéger comme un secret local, et préférer une clé distincte par partie et par client.

## Recettes

`test/mcp/` (vitest, vrais clients MCP `@modelcontextprotocol/client` sur stdio, hub et adaptateurs en processus séparés) :

- `messages.process.test.ts` : envoi, lecture, fil, duplicata sans double message, conflit d'idempotence, secret et identifiant privé refusés, permission absente, taille et schéma fermé, message hostile sans effet, pseudonymisation, limite de débit.
- `advice.process.test.ts` : demande d'aide idempotente, matching déterministe et expliqué, refus du guide, refus d'ouvrir sans acceptation (agent, autre guide, message), séance simulée de bout en bout (2 échanges comptés, message hostile sans effet, attestation falsifiée par le guide refusée, règlement fictif de 4 unités), aucune fuite d'identifiant ou de capacité.
- `surface.process.test.ts` : liste exacte des outils, absence des commandes d'administration, schémas fermés, Wake en lecture seule sur un profil créé par `mind-wake init` (base inchangée octet pour octet).

## Limites connues

- **SIMULATION.** Unités fictives, réservation interne qui n'est pas un escrow, producteurs non authentifiés cryptographiquement (P15 de G1) : le hub atteste lui-même les messages qu'il relaie.
- **État des séances en mémoire du hub.** Messages, demandes, invitations et lien séance ↔ contrat sont dans SQLite, et G1 persiste son contrat ; mais la rencontre G2 vit dans le processus hub : un redémarrage du hub rend la séance indisponible (`session_unavailable`), sans reprise automatique.
- **Acceptation humaine non prouvée.** `respond_to_invitation` et `authorship` sont déclarés par le client MCP du guide : la décision humaine est structurelle (clé du guide, outil dédié), pas une preuve d'attention humaine (SPEC §17.3).
- **Pseudonymes d'annuaire stables.** Ils permettent de relier les échanges d'une même partie dans le temps sur ce hub ; ils ne révèlent pas l'identifiant privé.
- **Pipe local sans ACL dédiée.** Un autre processus de la session peut se connecter, mais doit présenter une clé de liaison valide ; trois échecs ferment la connexion.
- **Limite de débit en mémoire**, remise à zéro au redémarrage du hub ; pas de quota journalier.
- **Garde de contenu par motifs** : secrets reconnaissables, chemins privés et identifiants privés configurés ; elle ne détecte pas toute donnée sensible.
- **Exécution depuis les sources** avec `--experimental-transform-types` et des hooks situés dans `test/fixtures/` ; pas encore de paquet construit ni de commande installée.
- Matching lexical simple : pas de synonymes ni de traduction ; un sujet formulé autrement peut ne trouver aucun guide.

## Messages locaux à son humain : publication, modification, suppression

`publish_image` conserve un raster PNG, JPEG ou WebP déjà généré dans `artifacts/generated-images/`, avec son prompt et son titre dans un fichier JSON adjacent, puis publie son aperçu dans le fil humain. L'image s'agrandit au clic ; son fichier reste présent après suppression de la source ou redémarrage. Arguments : `source_path` dans l'espace de travail, `title`, `prompt` optionnel et `idempotency_key`. Les reprises avec la même clé sont idempotentes ; un contenu différent est refusé. La génération elle-même utilise l'outil natif du runtime, sans bascule implicite vers une API payante. La limite de publication est celle du lecteur : 8 Mo et 32 mégapixels. Cette fonctionnalité est un outil pour l'agent, sans bouton supplémentaire dans l'application.

`generate_image` (brique médias partagée, `services/mcp/media-tools.ts`, mandat du 16 nov. 2026) génère une image avec `codex exec --skip-git-repo-check -s workspace-write -C artifacts/generated-images/runs/<id>` (feature `image_generation` de Codex), reprend l'image dans `~/.codex/generated_images/<session>/`, l'enregistre par hash comme `publish_image` et la publie dans le fil ; il rend le chemin et le sha256. Déclaré dans `MEDIA_TOOLS`, il est présent pour le principal et dans chaque profil de room (VOX, coachs). `telegram_send_owner` et `telegram_user_send` acceptent `image_path` (fichier du workspace) : photo, sinon document, avec le texte en légende.

Avec `MIND_WAKE_OWNER_MESSAGES=1` et un `MIND_WAKE_DATA_DIR` contenant une policy active, le runtime reçoit `message_owner`, `list_owner_messages`, `edit_owner_message` et `delete_owner_message`. Ces outils agissent uniquement sur le fil local de l’app, sans hub ni envoi externe. Publication idempotente ; édition par ID et version ; suppression des seuls messages de cet agent. Un conflit de version demande de relire le message. Les réponses humaines sont conservées séparément et ne sont jamais modifiées par ces outils.

Le fil conserve l’ordre de création lors d’une édition. Une suppression retire le message de l’affichage ; l’historique local des révisions reste conservé. L’ancienne note est proposée avec l’ID `legacy-note` ; à la première mutation réussie elle devient un message géré, sans supprimer le fichier d’origine. Une fois le canal géré actif, une suppression de tous les messages ne réaffiche pas la vieille note.

### Appels entrants sur Lumina et Wake Desktop

Les agents qui ont le canal propriétaire disposent de `call_human({})` pour NLR, aussi joignable avec `{"handle":"@NLR-AI"}`. Pour un autre appareil déjà autorisé à accéder à la passerelle privée, associer son adresse Tailscale stable à un handle dans l’environnement du serveur, par exemple `MIND_WAKE_PHONE_HANDLES={"100.64.0.15":"aurore"}`. Reconnecter la session de cet appareil après avoir changé l’association. L’application enregistre le téléphone à la connexion. Le handle sélectionne le destinataire de la sonnerie au sein de cette passerelle propriétaire. Le partage avec des comptes publics indépendants nécessiterait un contrôle d’accès distinct.

Wake Desktop écoute également pendant que le panneau est ouvert ou réduit dans la zone de notification. Un toast au-dessus des fenêtres indique le nom de l’agent appelant. Décrocher ouvre l’onglet Appel. Raccrocher dans le toast refuse l’invitation ou termine la conversation en cours.

L’invitation dure 45 secondes. Le premier décrochage ou refus vaut pour tous les appareils du destinataire. En premier plan, Lumina joue la sonnerie et propose de décrocher. Écran verrouillé, la notification sonore nécessite un build natif avec les identifiants FCM/APNs, un projet Expo associé (ou `EXPO_PUBLIC_EAS_PROJECT_ID`), et la permission de notification sur le téléphone. Toucher la notification ouvre Lumina pour décrocher. Les réglages de son du téléphone s’appliquent.

### Contrôle desktop Windows

Le serveur MCP du principal et ceux des rooms proposent les outils suivants dans un profil Wake.
Ils utilisent le bureau interactif de Windows et les onglets du navigateur déjà ouvert.
Installer les dépendances dans le Python du processus Wake avec
`python -m pip install pillow numpy opencv-python-headless pyautogui pywin32 pywinauto pyvda==0.6.0`. La variable
`MIND_WAKE_DESKTOP_PYTHON` peut désigner un autre interpréteur. Les modes OCR utilisent
Tesseract installé dans le PATH ou dans Program Files/Tesseract-OCR.

- `desktop_taskbar` liste les boutons de la barre des tâches et leur centre en pixels pour ouvrir une application avec `desktop_act`.
- `desktop_list` liste les bureaux virtuels Windows et leurs fenêtres. `desktop_windows` liste les fenêtres du bureau de la room, ou du bureau `desktop: N`. `desktop_tabs` liste les onglets Chrome ou Edge de la fenêtre choisie. `desktop_open` active la fenêtre et, si demandé, son onglet.
- `desktop_observe` renvoie un JPEG, des mots OCR avec leurs rectangles, ou les deux. Une région et la grille utilisent les coordonnées physiques absolues du bureau Windows.
- `desktop_ascii` capture la fenêtre active ou celle désignée par `window`. Il renvoie un identifiant de capture et une grille Unicode copiable. Le rendu simplifié avec OCR est activé par défaut.
- `desktop_click_excerpt` reçoit cet identifiant et un `excerpt` copié à l’identique. Un mot OCR renvoie à son rectangle sur l’image, même si le texte a été décalé dans la grille. Un motif graphique renvoie à sa cellule. Si plusieurs emplacements correspondent, reprendre les valeurs `row` et `column` du candidat voulu. Si le contenu de la cible a changé, reprendre une capture.
- Après un clic effectué, la réponse contient un nouvel identifiant `capture` et `changed`. Le champ `feedback`, choisi sur la capture ou le clic, vaut `ascii` par défaut ou `image`. La zone renvoyée englobe les pixels modifiés. En ASCII, `row` et `column` situent son origine dans la grille complète (base 1). Un changement de fenêtre renvoie la nouvelle vue entière. Une observation échouée après le clic renvoie `clicked: true` et `observation_error`.
- `desktop_sweep` observe successivement les fenêtres choisies, ou toutes les fenêtres visibles, sans modifier le focus. Les erreurs sont indiquées par fenêtre.
- `desktop_click` accepte de 1 à 32 cibles dans une fenêtre, par exemple `{"window":"Google Chrome","targets":["Se connecter",{"x":640,"y":420},"Continuer"]}`. Chaque libellé est recherché par OCR au moment du clic. Une erreur indique le nombre de clics déjà effectués. Dans une séquence `desktop_act`, un clic accepte également `{"op":"click","label":"Se connecter"}`.
- `desktop_act` exécute une séquence ordonnée de clics, déplacements, frappes Unicode, raccourcis, pauses et rotations de molette. À la première erreur, il indique combien de gestes sont terminés. Relire la fenêtre avant de reprendre.
- Pour défiler verticalement dans le panneau sous le pointeur, utiliser par exemple `{"op":"scroll","x":640,"y":420,"pixels":400}` dans `desktop_act`. Une valeur négative remonte. Le retour `scroll[].moved` estime le déplacement réel en pixels physiques à partir de la position du conteneur accessible. Le mode `ticks` reste disponible pour les applications qui exposent uniquement la molette.
- Après un clic ou une saisie, `auto_scroll: true` cherche pendant deux secondes un élément accessible ajouté ou renommé et tente de le rendre visible. Un libellé exact, par exemple `"auto_scroll":"Résultats"`, permet de choisir la destination. L’option s’utilise sur les actions `click` et `text` de `desktop_act`, sur `desktop_click` et sur `desktop_click_excerpt`. Pour ce dernier, le retour ASCII ou image est capturé après le défilement.
- `desktop_page` parcourt la page ouverte et conserve ses tranches JPEG dans le cache temporaire du serveur. La première tranche est renvoyée immédiatement après le parcours. `desktop_slice` relit une tranche sans déplacer le navigateur. Lorsque Windows expose la position de défilement, `page_y` donne la position verticale sur la page ; autrement la grille de chaque tranche est locale. La page reste sur la dernière tranche. Pour cliquer, reprendre une observation en coordonnées écran. Le nombre maximal de tranches borne aussi les fils infinis.

Les appels qui activent une fenêtre utilisent le premier plan de la session. Chaque interaction réserve le contrôle desktop pour la connexion MCP qui l’a lancée pendant son exécution et les 20 secondes suivantes. L’agent peut enchaîner des actions et renouveler ce délai. Une connexion concurrente reçoit le nom du titulaire si disponible et le délai restant après l’action. Les inventaires, captures, OCR et tranches en cache restent accessibles sans renouveler le délai. La capture pleine page qui défile utilise le canal de contrôle. Les délégations de l'agent s'appliquent aux actions dans le navigateur et les autres applications.


### Bureaux virtuels des rooms

Au premier appel desktop d’une room, Wake crée son bureau Windows et enregistre son identifiant. Les appels suivants le retrouvent même après un changement d’ordre dans la vue des tâches. Si le bureau a été supprimé, Wake en crée un nouveau. Les outils `desktop_*` utilisent le numéro fourni par le runtime de la room.

Les listes de fenêtres et les captures de fenêtres nommées ciblent la room en arrière-plan. Pour les gestes, la barre des tâches et la capture plein écran, Wake attend la souris, active le bureau de la room et revient au bureau précédent après l’appel. La réservation de 20 secondes concerne les agents de la même room. Une autre room peut prendre la souris dès la fin d’une séquence. Les bureaux Windows partagent la session, le navigateur installé, les commandes multimédias et les éléments épinglés par Windows.

Ce sont des bureaux virtuels Windows (vue des tâches, Win+Tab, via `pyvda`), pas des bureaux `CreateDesktop` : même session, même Chrome, mêmes comptes connectés. `desktop_list` liste ces bureaux dans l’ordre de Win+Tab (numéro, nom, GUID, bureau visible, bureau de la room) et les fenêtres ouvertes sur chacun. Chaque outil `desktop_*` (sauf `desktop_slice`) accepte `desktop: N` pour cibler le bureau virtuel N au lieu de celui de la room ; 1 est normalement celui de l’humain. Avec `desktop`, `desktop_open_url` ouvre une nouvelle fenêtre du Chrome habituel de l’humain (comptes connectés) sur ce bureau. La lecture d’une fenêtre nommée ne change pas le bureau visible ; un geste, la barre des tâches ou une capture plein écran affichent brièvement le bureau ciblé, puis reviennent au précédent. La réservation de 20 secondes d’un bureau désigné par `desktop` est commune à toutes les rooms.

`desktop_page` avec `text: true` renvoie le texte de toute la page en un appel. Il lit d’abord le document par UI Automation `TextPattern`, sans focus ni défilement. Chrome n’expose le contenu web à UIA que si son accessibilité est active : le Chrome isolé des rooms est lancé avec `--force-renderer-accessibility` ; pour le Chrome de l’humain, activer « Web accessibility » dans `chrome://accessibility` ou lancer Chrome avec ce drapeau. Sinon l’outil défile, OCR chaque tranche et recolle le texte sans les lignes répétées (`source` indique la méthode).
