# Appels entre installations sur le réseau local

Dans le desktop : **Appel → Réglages → Appels avec d’autres PC**.

1. Installer cette version sur les deux PC et les connecter au même réseau local.
2. Sur le PC qui reçoit l’appel, renseigner le nom de l’installation et de son utilisateur, créer un code d’association.
3. Sur le PC appelant, renseigner ses propres noms, saisir l’adresse locale affichée sur le PC distant et coller son code. Le code est valable une heure, pour une seule association.
4. Fermer les réglages, ouvrir « + », sélectionner les agents dans **Autres PC**, puis appeler. Il est possible de mélanger des agents locaux et distants (huit participants au total).
5. Pour autoriser les appels dans l’autre sens, répéter l’association dans le sens inverse. « Révoquer » retire l’autorisation et termine les appels concernés. Tous les agents et rooms locaux sont partagés par défaut, y compris ceux ajoutés après l’association. Cette règle s’applique aussi aux associations existantes.

**Copier le prompt de liaison** prépare directement un texte à coller à l’agent de l’autre PC : noms, adresses locales, nouveau code, expiration, tous les agents/rooms et procédure d’association dans les deux sens. Ce bouton remplace le code précédent ; le nouveau code reste valable une heure et ne sert qu’une fois. Si le navigateur bloque le presse-papiers, le prompt reste affiché et peut être copié manuellement.

Le destinataire reçoit le préavis avec le nom de l’appelant et de son installation. Chaque agent reste exécuté sur son propre PC. Le PC appelant transcrit le microphone puis transmet le texte ; la voix des réponses est produite sur l’installation de l’agent et renvoyée à l’appelant.

La passerelle est un service du desktop, indépendant des tâches des agents : Pause et Arrêt ne l’éteignent pas. Ouvrir un appel autorise une réponse ponctuelle de chaque destinataire, même lorsque les réveils autonomes sont arrêtés. Ce tour charge son prompt et sa conversation, reste sans outils et ne réactive pas Always-on. Le raccrochage ou le retrait annule la réponse en cours ; les répétitions d’ouverture ne créent pas de second tour. Les journaux sont dans `installation/desktop-call` et les reçus des réponses dans `call-opening-responses`.

## Inviter aussi un humain

Sur desktop, après avoir sélectionné un agent distant, cocher **Inviter aussi l’humain de chaque PC distant** avant d’appeler. Sans cette option, seuls les agents sont appelés. Chaque installation distante reçoit une invitation humaine distincte, valable une minute, dans la sonnerie du desktop. La personne choisit **Décrocher** ou **Refuser**. Son microphone n’est demandé qu’après acceptation ; une autre fenêtre ne peut pas reprendre cette acceptation.

Après décrochage, les voix humaines circulent en direct via WebRTC sur le Wi-Fi, avec l’appelant comme relais entre les participants. Chaque personne entend les autres sans recevoir sa propre voix en retour. La voix des agents suit le réglage de l’appelant. Les paroles de l’invité sont transcrites sur son installation et transmises aux agents avec son nom et celui du PC ; le texte des échanges est aussi affiché chez les invités. Une panne de transcription est signalée sans couper la voix directe.

Chaque humain peut couper son micro ou raccrocher indépendamment. Refuser, ne pas répondre ou raccrocher du côté invité ne ferme pas la conversation des agents. L’appelant garde la gestion des agents et termine l’ensemble de son appel en raccrochant. Retirer les agents d’une installation retire également son humain. Une déconnexion persistante ferme la liaison humaine ; il faut rappeler pour la rétablir.

La signalisation utilise l’association chiffrée existante. Les flux audio WebRTC utilisent les connexions locales négociées entre les navigateurs : le pare-feu doit également permettre leur trafic UDP, pas seulement le port TCP 8790. Aucun relais Internet ni serveur STUN/TURN n’est configuré. Les deux desktops doivent rester ouverts. La validation sur deux PC physiques et leurs pare-feux reste à faire.

## Messages partagés pendant l’appel

Le PC appelant coordonne la room temporaire. Chaque réponse d’agent produite depuis son entrée dans l’appel est copiée dans les autres fils participants sous la forme `[Appel] Auteur · Installation : texte`. Les participants qui partagent déjà un même fil n’ont pas besoin d’une copie supplémentaire. Les copies sont des notices de contexte : elles ne sont pas relues à voix haute, ne sont pas retransmises et ne déclenchent pas de nouveaux réveils. Les réponses sont plafonnées à 1 200 caractères par copie, comme pour les appels locaux.

La transcription humaine emprunte le routage habituel vers chaque destinataire ; elle peut réveiller les agents selon leurs règles existantes. Les agents peuvent raccrocher avec leur contrôle d’appel habituel. Une installation muette pendant 45 secondes perd sa session d’appel. Le redémarrage conserve l’association, mais ne reprend pas un appel terminé.

## Réseau et autorisations

Le service pair écoute sur **TCP 8790**, uniquement après création d’un code sur cette installation (et aux démarrages suivants). Le pare-feu Windows doit autoriser ce port depuis le réseau privé. Le réseau Wi-Fi ne doit pas isoler les appareils entre eux. Utiliser une adresse IPv4 privée ; la découverte automatique et les appels Internet ne sont pas inclus. Si l’adresse change, refaire l’association avec la nouvelle adresse.

Le port 8790 expose exclusivement le protocole d’appel. Il n’expose ni la session du propriétaire, ni les outils de l’agent, ni l’historique général, ni les fichiers. Les lectures et la synthèse vocale sont limitées aux participants de l’appel et aux messages de la session d’appel. Partager une room ou un agent dont le fil contient plusieurs voix partage les messages de ce fil accessibles au destinataire, uniquement pendant l’appel ; choisir un holder applique son filtre existant.

Les corps de requêtes et réponses sont chiffrés et authentifiés par AES-256-GCM, y compris sur HTTP local. L’invitation utilise une clé aléatoire de 256 bits ; une clé différente est créée pour l’association persistante. Les requêtes comportent un nonce, une date et un contrôle de rejeu. Les clés sont conservées dans `credentials/call-peers.json` dans le profil local, jamais dans le navigateur ni dans le dépôt. L’administration des associations exige une session propriétaire sur une connexion loopback.

## Vérifications

`node --test lumina-prime/app/server/call-peers.test.mjs lumina-prime/app/server/chat-call.test.mjs`

Les tests lancent des passerelles isolées sur des sockets TCP loopback avec des stores de contrôle SQLite temporaires : association, préavis, transmission humaine, copies bidirectionnelles et entre deux fils distants, déduplication, voix distante, retrait, révocation, isolation des historiques, rejeu, protocole HTTP desktop, raccrochage par l’agent et redémarrage. Ils ne constituent pas une validation sur deux PC physiques ni de leurs pare-feux.

Les tests humains couvrent l’invitation explicite, le refus, l’expiration, l’acceptation liée à une session propriétaire, l’échange des descriptions WebRTC après acceptation, l’attribution et la déduplication des paroles, puis le raccrochage individuel. `node --test lumina-prime/app/tests/human-audio-browser.test.mjs` lance Edge headless avec trois sources synthétiques, sans ouvrir de microphone : connexions WebRTC réelles, messages bidirectionnels, mélange des autres voix uniquement, micro coupé et maintien du troisième participant après un départ. Le navigateur peut être indiqué par `MIND_TEST_BROWSER` ; ce test est ignoré si le navigateur n’existe pas.
