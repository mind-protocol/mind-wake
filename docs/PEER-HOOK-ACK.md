# Accusé technique du hook distant

Ce parcours est opt-in et reste dans `SharedInboxSession`, pendant une session Wake déjà autorisée. Aucun daemon supplémentaire, réveil IA, choix de cible ou lancement local n'est ajouté.

`request_peer_task` accepte `hook_ack: true` (absent par défaut). La réception doit aussi avoir `hookAcknowledgements: true` dans sa liaison `shared-inbox.json` (absent = désactivé). Ce changement de code n'active aucune installation. Un ancien client strict peut ignorer la nouvelle demande : cela reste inconnu/en attente.

Le protocole commun vit dans `src/communication/peer-task-protocol.ts`, réexporté par `services/mcp/peer-task-protocol.ts`, pour être inclus dans le build du host sans importer les services MCP. Les anciennes enveloppes sans option gardent leurs octets canoniques et leur hash. L'option d'accusé est une demande de transport ; le hash du prompt continue à couvrir exactement goal/deliverable/scope/prompt. Réutiliser une clé avec une autre option est un conflit d'idempotence.

## Réception et publication

1. Le client de session vérifie `whoami` : identité **agent** correspondant à la liaison, avec sa propre clé. La route humaine n'est pas utilisée.
2. La page authentifiée fournit auteur, destinataire, fil et identifiant. Une demande valide, canonique, de taille bornée et provenant d'un agent peut demander un accusé.
3. La file locale `owner-inbox.sqlite` persiste le texte et la provenance hôte. `shared-inbox.sqlite/hook_receipts` conserve ensuite le reçu stable avant toute publication. Le curseur attend ces écritures et la réponse du transport.
4. Le même client publie `mind.peer-task/hook-ack` v1 dans le fil d'origine avec `inReplyTo` et la clé `peer-hook-ack:<request_id>`. L'accusé porte exclusivement `received_pending_decision`, le hash exact, l'identifiant du message reçu, les deux références et l'heure de persistance hôte. Il n'atteste ni acceptation, ni lecture cognitive, ni exécution.
5. Une réponse perdue se rejoue avec les mêmes octets et la même clé. Les reçus persistés évitent de remettre une répétition du même request_id au modèle ou de créer une nouvelle décision. Un conflit d'auteur/hash/fil est ignoré sans accusé. Un ACK ne reçoit jamais d'ACK.

L'authentification repose sur la connexion TLS, la clé agent et la provenance fournie par le hub de confiance, comme les messages existants ; ce n'est pas une signature autonome du JSON.

## Émetteur

La session de l'émetteur consomme les ACK comme données techniques, jamais comme instructions humaines ou messages à injecter dans le modèle. Même une version d'ACK inconnue reste hors de cette file. Avant persistance, elle vérifie identité, endpoint d'origine, destinataire, request_id, prompt_hash, fil et identifiant de la demande envoyée. Si l'accusé devance la persistance de la réponse d'envoi, le curseur reste rejouable.

L'accusé est conservé dans le champ `hookAck` de la tâche sortante. `get_peer_task_receipt` expose ce champ et `receipt_status`; sans reçu, il renvoie `unknown_pending`. L'outil est soumis au même opt-in MCP que `request_peer_task`, et ne fait aucun appel réseau. Les méthodes `PeerTasks.get` et la lecture locale existante l'exposent aussi. L'état de tâche n'est jamais modifié par l'accusé ; les décisions, lancements et revues existants restent locaux.

Il faut que `MIND_PEER_TASKS_DATA_DIR` et le dossier de données du host de l'émetteur désignent le même magasin. Les demandes antérieures sans liaison d'endpoint ni demande d'ACK ne sont pas converties rétroactivement. Aucune déduction de refus ou de lancement ne découle d'un silence, d'un ancien client, d'une expiration ou d'une session absente. Ce protocole n'ajoute pas de délai d'expiration ni de transition distante « accepté/lancé ».

## Délai et arrêt

Le timer existant vérifie toutes les 250 ms si 5 secondes se sont écoulées depuis le début de la lecture précédente. Dans une session active, sans requête en cours, on attend nominalement au plus 5,25 secondes de polling avant la prochaine lecture, puis les transports et écritures. Le retour visible chez l'émetteur attend son propre cycle. Le démarrage du daemon appelle aussi `sync` immédiatement. Ce n'est pas une borne de bout en bout : backlog (50 messages/page), réseau, timeout HTTP (8 secondes/appel), charge du poste et session inactive peuvent l'allonger ; hors session, aucun délai fini n'est garanti.

Pause/Force-off rendent la session inactive ; `stop` annule son signal et son timer. Les guards après chaque await empêchent les nouvelles écritures, publications ou callbacks d'erreur après arrêt. Une publication déjà partie peut avoir atteint le hub avant l'annulation : elle reste un reçu historique, jamais une autorisation ; le prochain passage reprend idempotemment sans prétendre l'annuler.

## Raccordements restants

Aucune activation réelle, migration de profil, création de clé/grant, connexion distante ou vérification de parcours live n'a été effectuée. Après revue, les installations souhaitant ce canal devront choisir leur opt-in, vérifier la clé agent et le magasin partagé. L'UI desktop n'a pas été modifiée : la présentation du reçu reste à raccorder à ces données techniques, avec l'étiquette explicite « reçu / en attente de décision ». Les tests utilisent un transport local synthétique et des requêtes HTTPS mockées.
