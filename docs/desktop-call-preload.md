# Préchargement des appels au démarrage

Le lanceur desktop prépare la passerelle locale avant que la WebView charge son iframe d'appel. L'iframe est déjà montée en arrière-plan par `desktop/ui/main.ts`, même si l'onglet Appel n'est pas sélectionné. Aucun microphone ni appel sortant n'est lancé par ce préchargement.

`scripts/desktop-call-host.mjs` appartient au desktop, pas au daemon des agents. Il réutilise une passerelle existante sur 8789, ou lance le service de chat/appel si le port est libre. Il surveille la disparition d'une ancienne passerelle pendant la vie du desktop. Il ne lance aucune session de modèle et ne modifie ni la policy, ni Pause, ni Force-off. À la fermeture du desktop, le superviseur arrête seulement son propre processus ; une passerelle préexistante n'est pas arrêtée.

Le lancement attend au plus 12 secondes la page d'appel ; si elle n'est pas prête, l'application s'ouvre quand même et le service poursuit ses essais. Les erreurs sont dans `installation/desktop-call/host.log`. Un export web mobile manquant doit être construit par la procédure habituelle ; la présence de la passerelle seule ne prouve pas que React a fini de monter dans la WebView.

Par défaut, la passerelle n'écoute que sur 127.0.0.1. Une configuration locale existante peut être conservée dans `installation/desktop-call/network.json` (`host`, `hostnames`, `privateNetworkConnect`, `origins`), validée par le serveur mobile. Lors de la migration d'un ancien job `chat-wake168.mjs`, conserver ces paramètres puis annuler ce job pour empêcher son redémarrage concurrent à la reprise des agents. Les nouvelles installations n'héritent pas des adresses réseau du poste source.

La préparation s'applique au lancement par les raccourcis installés et `scripts/desktop-supervisor.mjs`. L'exécution directe de l'exécutable Tauri en dehors du lanceur ne démarre pas cette passerelle.
