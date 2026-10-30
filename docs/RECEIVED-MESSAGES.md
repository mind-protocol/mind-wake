# Messages reçus et destinataire du fil

`messages --json` expose `receivedMessages` séparément des messages humains. Le fil affiche canal, kind, référence, nom, fil, dépôt/session, date et état.

- repo-session : attribution enregistrée, non authentifiée, issue du registre repo.
- local-inbox : expéditeur inconnu. Aucun champ du corps JSON ne sert d'identité ou de replyTo.
- mind-local-hub : réponses directes read_inbox journalisées après chargement du nouveau pont MCP. Identité attestée par le hub ; corps non fiable ; from_self exclu.

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
