# Voix mobile MIND — état du 4 novembre 2026

Corrections NLR : STT sur le desktop, connexion privée persistante sans saisie de code, tranches micro de 30 secondes avec Pause, réponse audible sur le téléphone. Parcours vérifié ici : Chrome Android sur Samsung via USB, Expo localhost:8081 et passerelle loopback 8789. Le composant natif DeviceVoice reste un placeholder ; ces observations ne valident pas un APK.

## Parcours

- La passerelle utilise Whisper local déjà configuré pour Wake (aucun fournisseur ou compte changé). Le téléphone capture avec MediaRecorder et envoie ses tranches authentifiées au desktop.
- La capture démarre uniquement avec « Parler à Marco ». Elle se poursuit pendant le traitement des tranches précédentes ; les transcriptions sont séquentielles, avec au plus deux clips en attente. Une transcription trop lente met le micro en pause plutôt que de laisser croître la file.
- Sans conversation vocale activée, la transcription rejoint le brouillon. « Activer la conversation vocale » active explicitement l’envoi automatique des futures transcriptions et la lecture des nouvelles réponses, y compris au premier plan. L’historique restauré n’est pas relu.
- Le micro est suspendu pendant la synthèse vocale et en arrière-plan. Une Pause humaine l’emporte sur toute reprise automatique. La synthèse utilise une voix locale du téléphone.
- Le client web conserve sa session dans le stockage de cette origine. La passerelle conserve seulement les empreintes de jetons et leurs échéances dans `credentials/mobile-chat-sessions.json`, hors dépôt. Les sessions de production durent un an et restent révocables.
- `localConnect: true` est explicitement activé dans le job de cette installation. Par défaut il reste désactivé. La connexion sans code exige une connexion réseau loopback, un Host loopback et une Origin loopback explicitement autorisée. Elle ne donne pas de connexion automatique depuis le LAN ou un site externe. Le jeton reste exigé pour les messages et l’audio. Ce modèle fait confiance aux processus locaux du propriétaire et au tunnel USB ; ce n’est pas une isolation contre eux.

## Vérifications effectuées

- Typage et lint mobiles : passent. Tests mobiles : 107/107, dont nouvelle couverture de reprise/révocation des sessions, refus d’origines non autorisées, tranches continues et annulation des résultats tardifs.
- Samsung réel : contexte sécurisé localhost, accès micro déjà accordé, MediaRecorder et voix locale française disponibles. L’interface présente le chat connecté et les nouveaux contrôles.
- Rechargement du navigateur : empreinte de session identique. Redémarrage réel du job passerelle : le même jeton est encore accepté, HTTP 200, sans formulaire de code.
- Test vocal du bouton : le moteur Android a annoncé la fin de lecture. Cela ne constitue pas une confirmation humaine du volume ou du son entendu.
- Test technique depuis le navigateur du Samsung avec un vocal préenregistré : upload authentifié vers le desktop, Whisper réel, HTTP 200, transcription retournée en 27,7 secondes pour 8,95 secondes d’audio. Ce test ne valide pas le microphone physique ni la qualité de reconnaissance d’une voix humaine. La transcription du vocal synthétique comporte des erreurs.
- Un message texte du téléphone et la réponse de Marco apparaissent dans le fil. Le test humain de bout en bout « parole réelle → transcription → message → réponse entendue » reste à confirmer.

## Services conservés

Expo 8081 et le job de captures Samsung toutes les deux minutes n’ont pas été arrêtés. Seul le job chat a été remplacé pour charger les modifications et tester sa reprise. Job chat actuel : `job_77731a27-7b19-4c96-9fac-334dc273d4be`, script `jobs/chat-wake168.mjs` dans le workspace live. Il reste soumis aux contrôles Wake. Aucun nouveau modèle d’agent ni API payante n’a été lancé.

La latence Whisper observée n’est pas compatible avec une réponse instantanée. Le navigateur peut suspendre l’audio et les connexions en arrière-plan ; privilégier MIND au premier plan pour la conversation vocale. Prochain contrôle : une phrase courte au micro du Samsung puis confirmation du son par NLR, sans confondre cette preuve avec le test audio préenregistré.
