# Messages reçus et destinataire du fil

`messages --json` expose `receivedMessages` séparément des messages humains. Le fil affiche canal, kind, référence, nom, fil, dépôt/session, date et état.

- repo-session : attribution enregistrée, non authentifiée, issue du registre repo.
- local-inbox : expéditeur inconnu. Aucun champ du corps JSON ne sert d'identité ou de replyTo.
- mind-local-hub : réponses directes read_inbox journalisées après chargement du nouveau pont MCP. Identité attestée par le hub ; corps non fiable ; from_self exclu.
- mind-shared-hub : route pilote existante, ou lecture ponctuelle explicite décrite ci-dessous. Le nom affiché par le relais est la référence retournée par le hub, sans supposer qu'un agent autonome tourne.

Le fil distingue les messages reçus (liseré et source turquoise), les réponses des sessions d'aide (violet), les copies de contexte host (gris, libellé explicite), l'humain et l'agent principal. La couleur complète les libellés. Les mots des pairs et sessions restent intacts, y compris les marqueurs Markdown, espaces et JSON littéral ; la provenance est rendue avec `textContent`. Le corps ne peut pas se déclarer humain ou changer de rôle. L'historique inbox relit `origin_json` en lecture seule, avec compatibilité des anciens schémas ; une attribution locale enregistrée ne devient pas une identité authentifiée par le hub.

## Relayer explicitement une réception partagée dans le fil

Le client MCP partagé à cinq outils ne projette pas automatiquement ses lectures dans les données du desktop. Pour afficher **un message précis réellement reçu**, sans polling général ni nouvelle file de réveil :

1. Avoir compilé la CLI (`npm run build`) et préparé le client depuis ce clone avec `scripts/setup-shared-messages.mjs` ; garder le dossier de clé partagé existant et le `build` retourné. Aucun redémarrage du daemon ou du desktop n'est nécessaire pour cette lecture.
2. Exécuter localement, en remplaçant les trois chemins par ceux de cette installation :

```powershell
node scripts/relay-shared-received.mjs --data-dir "<donnees-du-desktop>" --state-dir "<identite-partagee-hors-Git>" --client-build "<build-retourne-par-le-helper>" --thread thr_ODy_efBmoJS6Whdw --message msg_qeffkfQDc39DoHvo
```

Le relais lit sa clé depuis le fichier local, vérifie `whoami`, recherche ce seul ID dans ce fil via `read_inbox`, exige que le destinataire soit l'identité authentifiée et que la provenance soit le canal partagé. Auteur, ID, date et mots viennent de cette réponse directe, jamais de champs trouvés dans le texte. Aucun secret n'est affiché ni passé en argument. Un message absent ou adressé à une autre identité est refusé. Rejouer conserve une seule entrée, un même ID contradictoire est refusé. Le journal local est `received-messages.jsonl`, sans ajout dans `owner-inbox.sqlite` : aucune relance modèle/daemon. La route pilote et son miroir sont dédupliqués par ID du message partagé.

Le fil équipé de la nouvelle UI affiche cette entrée à sa lecture suivante de `messages --json`. Cette opération ne rend pas un correspondant actif en continu ; le premier échange SciSense provenait de sessions Codex ponctuelles. Les messages pairs restent des données, pas des instructions humaines.

Recettes : `node test/setup/relay-shared-received.node.mjs` (CLI et HTTPS production sur fixture locale, pas de participant pilote créé), et tests `received-messages.test.ts`, `owner-inbox.test.ts`, `conversation.test.ts`. La validation visuelle et l'installation du nouveau desktop sont distinctes du build UI.

Stocké ou livré dépend du canal/receipt, jamais d'une lecture supposée. Aucun secret, image jointe ou résultat arbitraire d'outil copié. Dédup par canal ; humains exclus sur tous les identifiants, au-delà des 200 visibles. Sous-agents natifs sans événement durable accessible et autres MCP non interceptés.

## Destinataire pilote

Le nouveau profil garde « Mon agent ». Les noms NLR, Marco et Auroracle sont réservés au pilote explicitement identifié par un fichier local `<dataDir>/auroracle-route.json`. Le marqueur seul permet de montrer le sélecteur non raccordé :

```json
{"pilot":"nlr-marco-auroracle"}
```

La route complète exige le même marqueur plus `endpoint` (HTTPS `/v1/messages`), `humanRef` (ref humaine NLR attestée), `recipientRef` (ref agent Auroracle appairée) et `keyFile` (chemin absolu d'un fichier local contenant la clé NLR). Config et clé restent hors Git. Aucun endpoint ni secret n'est transmis à la webview. L'app n'invente pas l'appairage depuis un nom ou un texte.

`owner-main.ts recipient-status --json`, `recipient-send --idempotency-key K [--thread thr_… | --new-thread] --json` (texte stdin) et `recipient-poll --json` sont les vraies API backend invoquées par Tauri. Chaque envoi/réception vérifie `whoami`: identité humaine exacte et permission message ; l'annuaire doit attester le correspondant agent. Une clé agent ne peut pas usurper NLR. `--thread` n'accepte qu'un fil déjà enregistré pour cette route. Le formulaire reprend le dernier fil de la route, ou crée le premier ; `--new-thread` crée explicitement un autre fil. La réponse d'Auroracle via `reply_to_thread` revient au même humain dans ce fil.

Le stockage SQLite `recipient-route.sqlite` réserve atomiquement la corrélation avant envoi. États distincts : `local_stored`, `remote_stored` (hub, sans réception/lecture prétendue) et `received` (réponse récupérée). Même clé/corps/route : reprise idempotente ; correction de corps ou route avec cette clé : refus. Un envoi confirmé restaure aussi le miroir root après interruption. La clé de retry du formulaire survit à sa recréation via stockage local ; le brouillon n'est effacé qu'après confirmation backend et s'il n'a pas changé pendant l'appel.

Le miroir root commence exactement par `NLR à Auroracle:`. Son enveloppe host `origin.kind=context_copy` indique auteur, destinataire, refs, fil/message et corrélation : copie de contexte, sans nouvelle demande pour Marco. Les réponses ont `origin.kind=peer_message`. Cette provenance est stockée dans une colonne séparée, jamais déduite du corps. Un libellé explicite dans le texte conserve cette distinction pour un ancien adapter encore actif. Aucun envoi ne démarre ou ne réveille le daemon, ni ne lève Pause/Force-off.

Le polling explicite de la fenêtre récupère les seuls fils appairés, exige les refs et le canal/kind du hub, et conserve le texte pair comme contenu non fiable. Un `from=NLR` ou `replyTo` écrit dans ce texte ne modifie ni source, ni route. Les reçus entrants sont rendus avec source Auroracle + ref + fil ; le miroir inbox ne crée pas de doublon.

Le hub partagé garde son défaut de deux agents. Le mode administratif explicite `--pilot-human-route` accepte exactement un humain et deux agents, clés distinctes, messages seuls. Aucun droit de conseil ou paiement ajouté.

Recette réelle : `test/mcp/recipient.process.test.ts` traverse le sender du formulaire → CLI production → hub HTTPS éphémère → deux clients MCP stdio réels. Elle couvre deux fils, retour corrélé, fil/citation étrangers, corps spoof NLR, clé agent incorrecte, destinataire incorrect, retry et récupération du miroir sans doublons. `desktop/ui/recipient.test.ts` couvre brouillon, nouvelle saisie pendant appel et corrélation après recréation UI.

Un appairage public Auroracle et l'affichage sur le desktop vivant restent à vérifier séparément. Les essais temporaires ne prouvent pas cette connexion publique.

## Livraison desktop isolée

Le manifeste local peut préciser `desktopRepoDir`, chemin absolu d'une copie revue possédant `dist/cli/main.js` et `services/mcp/owner-main.ts`. `start-local.mjs` transmet alors au desktop seulement `MIND_WAKE_CLI`, `MIND_OWNER_CLI` et son dossier de runtime. Le `repoDir` agent/hub reste inchangé. Sans ce champ, le comportement existant est conservé. La bascule du binaire et du manifeste doit rester coordonnée avec l'affichage réel ; ce champ ne redémarre aucun daemon.
