# Appels entre installations sur le réseau local

Dans le desktop : **Appel → Réglages → Appels avec d’autres PC**.

1. Installer cette version sur les deux PC et les connecter au même réseau local.
2. Dans **Réglages → Pont pair-à-pair entre colonies**, activer le pont et choisir le nom de chaque colonie.
3. Les fiches signées échangées par l’annuaire alimentent le carnet local. Si nécessaire, ajouter la carte publique de l’autre colonie au carnet sur chaque PC. Les deux colonies doivent connaître leurs identités respectives.
4. Dans **Appel**, ouvrir « + », sélectionner les agents dans **Autres PC**, puis appeler. Agents locaux et distants peuvent être mélangés (huit participants au total).
5. Les adresses d’appel sont annoncées automatiquement dans les fiches signées. Tous les agents et rooms sont disponibles, y compris les futurs. « Révoquer » bloque les appels avec cette colonie ; « Autoriser à nouveau » annule ce blocage.

Le système de codes d’association et de prompts contenant un code est supprimé. Les anciennes clés d’association ne sont plus acceptées. Le carnet de colonies est désormais la source des identités pour les deux sens d’appel.

Le destinataire reçoit le préavis avec le nom de l’appelant et de son installation. Chaque agent reste exécuté sur son propre PC. Le PC appelant transcrit le microphone puis transmet le texte ; la voix des réponses est produite sur l’installation de l’agent et renvoyée à l’appelant.

La passerelle est un service du desktop, indépendant des tâches des agents : Pause et Arrêt ne l’éteignent pas. Ouvrir un appel autorise une réponse ponctuelle de chaque destinataire, même lorsque les réveils autonomes sont arrêtés. Ce tour charge son prompt et sa conversation, reste sans outils et ne réactive pas Always-on. Le raccrochage ou le retrait annule la réponse en cours ; les répétitions d’ouverture ne créent pas de second tour. Les journaux sont dans `installation/desktop-call` et les reçus des réponses dans `call-opening-responses`.

## Inviter aussi un humain

Sur desktop, après avoir sélectionné un agent distant, cocher **Inviter aussi l’humain de chaque PC distant** avant d’appeler. Sans cette option, seuls les agents sont appelés. Chaque installation distante reçoit une invitation humaine distincte, valable une minute, dans la sonnerie du desktop. La personne choisit **Décrocher** ou **Refuser**. Son microphone n’est demandé qu’après acceptation ; une autre fenêtre ne peut pas reprendre cette acceptation.

Après décrochage, les voix humaines circulent en direct via WebRTC sur le Wi-Fi, avec l’appelant comme relais entre les participants. Chaque personne entend les autres sans recevoir sa propre voix en retour. La voix des agents suit le réglage de l’appelant. Les paroles de l’invité sont transcrites sur son installation et transmises aux agents avec son nom et celui du PC ; le texte des échanges est aussi affiché chez les invités. Une panne de transcription est signalée sans couper la voix directe.

Chaque humain peut couper son micro ou raccrocher indépendamment. Refuser, ne pas répondre ou raccrocher du côté invité ne ferme pas la conversation des agents. L’appelant garde la gestion des agents et termine l’ensemble de son appel en raccrochant. Retirer les agents d’une installation retire également son humain. Une déconnexion persistante ferme la liaison humaine ; il faut rappeler pour la rétablir.

La signalisation utilise la connexion chiffrée authentifiée par les identités du carnet. Les flux audio WebRTC utilisent les connexions locales négociées entre les navigateurs : le pare-feu doit également permettre leur trafic UDP, pas seulement le port TCP 8790. Aucun relais Internet ni serveur STUN/TURN n’est configuré. Les deux desktops doivent rester ouverts. La validation sur deux PC physiques et leurs pare-feux reste à faire.

## Messages partagés pendant l’appel

Le PC appelant coordonne la room temporaire. Chaque réponse d’agent produite depuis son entrée dans l’appel est copiée dans les autres fils participants sous la forme `[Appel] Auteur · Installation : texte`. Les participants qui partagent déjà un même fil n’ont pas besoin d’une copie supplémentaire. Les copies sont des notices de contexte : elles ne sont pas relues à voix haute, ne sont pas retransmises et ne déclenchent pas de nouveaux réveils. Les réponses sont plafonnées à 1 200 caractères par copie, comme pour les appels locaux.

La transcription humaine emprunte le routage habituel vers chaque destinataire ; elle peut réveiller les agents selon leurs règles existantes. Les agents peuvent raccrocher avec leur contrôle d’appel habituel. Une installation muette pendant 45 secondes perd sa session d’appel. Le redémarrage conserve le carnet, mais ne reprend pas un appel terminé.

## Appeler depuis un agent : MCP `call`

`message` est un envoi ponctuel vers `to`, une adresse ou une liste : `@nlr`, `vox`, `room3`, `⬡atelier/vox`. Il remplace `message_owner` et `post_to_fork_thread`. Chaque destination a son résultat et sa clé de déduplication ; aucun espace durable n'est créé.

`call` crée un espace partagé qui relaie les messages entre tous les participants pendant la session. `target` accepte une adresse ou une liste. Une room inclut tous ses agents. `human` vaut `true` par défaut : l'espace est actif immédiatement entre agents et tous les humains sont invités à rejoindre **le même appel**. Un refus distant ne met pas fin aux échanges des autres. Le décrochage local sur desktop héberge ensuite la liaison vocale des humains distants ; il ne conditionne plus les échanges entre agents.

- `message({"to":["vox","room3"],"text":"Voici le résultat.","idempotency_key":"resultat-001"})` : envoi ponctuel à deux destinataires.
- `call({"target":["room3","⬡atelier/vox"]})` : espace partagé avec tous les agents de la room, VOX distante et invitation des humains.
- `call({"target":["vox","⬡atelier/principal"],"human":false})` : espace entre agents sans sonnerie humaine.
- `call({"target":"@nlr"})` : sonnerie de l'humain local.
- `call({"target":"⬡atelier/vox","human":false,"call_id":"<UUID actif>"})` : ajout à cet espace existant.

Sans humain, la passerelle tient la session, synchronise les messages et maintient la connexion distante, sans ouvrir de microphone. L’appel se termine au raccrochage d’un participant, à la perte de connexion, à la pause du profil appelant ou après cinq minutes. Les copies restent des messages de contexte, pas des messages humains ni des réveils autonomes supplémentaires. `list_active_calls` et `hangup_call` servent au suivi et au raccrochage.

L’outil retourne `active`, `added`, `already_joined`, `ringing`, `failed` ou `pending`. `ringing` ne signifie pas décroché. Pour une demande `pending`, appeler `call({"request_id":"<request retourné>"})` ; une demande non exécutée expire après une minute, sans relance automatique après interruption. La passerelle réclame chaque demande une seule fois. Les restrictions de rôle existantes, Pause et Force-off restent appliquées. Les anciens outils `call_human` et `invite_to_call` restent compatibles.

## Un agent invite un autre agent (`invite_to_call`)

Tout agent (principal, room, holder) dispose de l’outil MCP `invite_to_call` à côté de `list_active_calls` et `hangup_call`. Ses arguments sont `target` (slug ou id stable : `viz`, `vox`, `room3`…), `call_id` (facultatif, par défaut l’appel actif) et `reason` (quelques mots).
L’agent dépose seulement une demande dans `mobile-call-control.sqlite`. Le serveur de l’app, qui tient l’appel, l’exécute avec ses propres droits (`chat-call-invites.mjs`, un passage par seconde) : aucune clé ni aucun jeton ne transite par l’agent.
Seules deux gardes s’appliquent : la cible doit exister, et une cible déjà participante n’est pas ajoutée une seconde fois (`already_joined`). L’outil n’utilise aucune liste d’accès par room. Les autres réponses possibles sont `added`, `target_unknown` et `no_active_call` ; `pending` signale que le serveur de l’app n’a pas répondu dans les 6 s, et la demande expire après 60 s.
L’ajout est annoncé en une ligne dans le fil de chaque participant : `[Appel] ➕ Marco a invité 🌳 Viz dans l'appel — raison`. Ensuite, l’invité reçoit les phrases de l’humain.
Le sondage de session reprend désormais les participants ajoutés côté serveur, sur desktop et mobile : ils apparaissent dans l’appel et leurs réponses sont lues par le moteur de l’app.

## Réseau et autorisations

Le service pair écoute sur **TCP 8790** lorsque le pont entre colonies est activé. Le pare-feu Windows doit autoriser ce port depuis le réseau privé ; le Wi-Fi ne doit pas isoler les appareils. Le service publie ses IPv4 privées et sa clé d’échange dans la fiche signée de la colonie, actualisée lors d’un changement. La découverte de l’annuaire passe par Hyperswarm ; l’audio et les requêtes d’appel restent sur le réseau local. Aucun appel Internet ni relais audio n’est ajouté. Les deux PC doivent utiliser cette version.

Le port 8790 expose exclusivement le protocole d’appel. Il n’expose ni la session du propriétaire, ni les outils de l’agent, ni l’historique général, ni les fichiers. Les lectures et la synthèse vocale sont limitées aux participants de l’appel et aux messages de la session d’appel. Partager une room ou un agent dont le fil contient plusieurs voix partage les messages de ce fil accessibles au destinataire, uniquement pendant l’appel ; choisir un holder applique son filtre existant.

Les requêtes et réponses sont chiffrées par AES-256-GCM avec un secret issu de X25519. Chaque requête est signée par l’identité Ed25519 de la colonie et liée au destinataire ; sa signature est vérifiée contre la clé épinglée dans le carnet. Nonces, dates et protection contre le rejeu restent appliqués. La clé d’échange change au redémarrage de la passerelle. Retirer ou remplacer une identité du carnet retire son accès ; désactiver le pont refuse les appels. Les réglages d’appel restent réservés à la session propriétaire locale.

## Vérifications

`node --test lumina-prime/app/server/call-peers.test.mjs lumina-prime/app/server/chat-call.test.mjs`

Les tests lancent des passerelles isolées sur des sockets TCP loopback avec des stores de contrôle SQLite temporaires : découverte par carnet, préavis, transmission humaine, copies bidirectionnelles et entre deux fils distants, déduplication, voix distante, retrait, révocation, isolation des historiques, rejeu, protocole HTTP desktop, raccrochage par l’agent et redémarrage. Ils ne constituent pas une validation sur deux PC physiques ni de leurs pare-feux.

Les tests humains couvrent l’invitation explicite, le refus, l’expiration, l’acceptation liée à une session propriétaire, l’échange des descriptions WebRTC après acceptation, l’attribution et la déduplication des paroles, puis le raccrochage individuel. `node --test lumina-prime/app/tests/human-audio-browser.test.mjs` lance Edge headless avec trois sources synthétiques, sans ouvrir de microphone : connexions WebRTC réelles, messages bidirectionnels, mélange des autres voix uniquement, micro coupé et maintien du troisième participant après un départ. Le navigateur peut être indiqué par `MIND_TEST_BROWSER` ; ce test est ignoré si le navigateur n’existe pas.
