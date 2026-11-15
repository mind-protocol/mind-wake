# Voix ElevenLabs

Dans Réglages → Voix · ElevenLabs, saisir la clé API, charger les voix du compte,
choisir une voix par défaut, puis activer et enregistrer. La clé doit disposer
des droits Voices (lecture) et Text to Speech. L’activation autorise les générations
avec les crédits du compte ; chaque texte est transmis à ElevenLabs.
« Générer et écouter » permet de vérifier le parcours avec un texte choisi.

Le serveur MCP local expose, pour les profils `MIND_WAKE_DATA_DIR` :

- `elevenlabs_list_voices({cursor?})` : catalogue paginé, avec `next_page_token` ;
- `speak_desktop({text, idempotency_key})` pour lire une réponse courte.
- `elevenlabs_generate_speech({text, voice_id?, idempotency_key?})` pour générer
  un MP3 avec la voix choisie et le modèle `eleven_multilingual_v2`.

Exemple : `elevenlabs_generate_speech({"text":"Bonjour, voici ma découverte."})`.
Les deux outils rendent la main avec `generation: "in_progress"` dès la
réservation locale. Le processus MCP poursuit la génération et met le clip en
file à réception du MP3. Un nouvel appel avec les mêmes paramètres et la même clé
peut récupérer `audioPath` et `playback: "queued_for_desktop"` une fois le clip prêt.
La génération peut être interrompue si le processus MCP s’arrête. Aucun nouvel
appel payant n’est relancé automatiquement sur erreur.
Le texte est limité à 5 000 caractères par appel. Pas de clonage ni création de
nouvelle identité vocale dans cette intégration.

Les réglages sont relus à chaque appel, sans redémarrer le serveur déjà doté de ces
outils. Après installation du code, les sessions MCP déjà lancées doivent se
reconnecter pour charger cette version des outils.

Le desktop récupère les résultats toutes les trois secondes et lit un clip à la
fois, même sur un autre onglet. Le lecteur permet pause, reprise et réécoute ;
les voix attendent la fin effective du clip précédent, sans superposition ni
interruption d’une pause ou d’une réécoute. Les arrivées simultanées restent en file.
« Arrêter / passer » retire le clip de la file. Si la lecture automatique est
désactivée ou bloquée par le webview, appuyer sur lecture. La livraison est acquittée
au premier démarrage effectif de la lecture. Une app fermée laisse les clips en
attente jusqu’à sa réouverture ; aucune lecture système cachée n’est lancée.

Pause/Force-off et intégration désactivée empêchent la génération et la lecture
automatique ; le desktop coupe un clip en cours au prochain contrôle (trois
secondes au plus, hors indisponibilité du pont natif). Un appel fournisseur déjà
parti peut avoir consommé des crédits ; son résultat n’est pas mis en lecture si
Wake s’est arrêté entre-temps.

`<data-dir>/elevenlabs.json` contient la clé locale (jamais renvoyée au desktop ni
au modèle). Ce stockage suit les permissions du dossier utilisateur Windows ; ce
n’est pas un coffre chiffré. Ne pas versionner ni synchroniser ce fichier.
`<data-dir>/elevenlabs-audio/` conserve les MP3 ; les fichiers JSON voisins sont les
marqueurs de livraison en attente, supprimés après lecture ou passage. Les MP3 ne
sont pas purgés automatiquement et peuvent être supprimés par l’humain.

Implémentation : API officielle [liste des voix](https://elevenlabs.io/docs/api-reference/voices/search)
et [synthèse vocale](https://elevenlabs.io/docs/api-reference/text-to-speech/convert).
Les tests automatisés utilisent un fournisseur simulé, sans crédits réels.
