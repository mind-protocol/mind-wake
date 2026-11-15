# Contribution aux objectifs de code de Wake — 4 novembre 2026

Le contexte courant du projet `ui-app` demande la sortie vocale directe sur Samsung, sans Telegram, et un overlay image pendant le jeu. Cette contribution prend un sous-ensemble indépendant du lot audio `mobile-voice-delivery186`, sans modifier cette copie de travail ni les fichiers de l’agent overlay.

## Code livré

- `lumina-prime/app/src/chat/mobile-audio-player.mjs` : lecteur issu du candidat isolé, avec correctifs de concurrence et anti-écho.
- `lumina-prime/app/src/chat/mobile-audio-player.test.mjs` : six tests du lecteur, dont trois nouvelles régressions.

Le micro est suspendu avant `audio.play()`, au lieu d’attendre `playing` après le début du son. Les doubles activations en cours partagent une seule requête. Stop invalide une activation retardée. L’échec tardif d’un ancien heartbeat ou reçu n’arrête plus la nouvelle activation. Un échec de reçu lors d’une erreur audio est absorbé pour éviter un rejet de promesse non géré ; l’arrêt local reste effectif.

Les contrôles préexistants sont conservés : activation explicite, Bearer en header, vérification SHA-256/taille, séparation received/started/ended, pas de replay d’un clip déjà commencé et aucun appel fournisseur dans le lecteur.

## Vérification

Suite mobile complète : **113 tests réussis, zéro échec**, dont les six tests du lecteur. Typage et lint mobiles : réussis. Le test audio du lecteur utilise une fixture de protocole et un double de HTMLAudioElement, pas un vrai fichier décodable ni un téléphone.

## Raccordement restant au propriétaire de la passerelle

Le lecteur est un module prêt à intégrer, pas une nouvelle voix déjà activée dans l’interface. Il faut encore monter les routes du candidat sur 8789 derrière la session propriétaire et la liaison USB Samsung validée côté serveur. Une session loopback seule ne prouve pas le numéro de série du téléphone. Vérifier aussi CORS : la page 8081 et l’API 8789 ont des origines distinctes ; le handler audio doit préserver les en-têtes CORS de la passerelle pour l’origine autorisée, y compris pour le MP3.

L’intégrateur peut remplacer l’import du lecteur candidat par ce module testé. Activer d’abord le lecteur depuis un geste utilisateur, puis remettre le MP3 déjà produit via le service officiel et le CLI de file existant. Vérifier les reçus et obtenir confirmation du son entendu. Aucun nouveau crédit ElevenLabs n’a été consommé ici. Aucun fournisseur, compte, quota, service supervisé ou APK n’a été changé par ce lot.

La lecture pendant un autre jeu exige encore l’intégration/validation Android ; le succès des tests web ne la prouve pas. Les notes d’intégration originales restent dans `artifacts/projets/ui-app/mobile-voice-delivery186/INTEGRATION.md` du workspace live.
