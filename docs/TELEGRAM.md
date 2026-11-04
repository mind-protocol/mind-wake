# Telegram — fil propriétaire

Passerelle optionnelle Bot API officielle, sans serveur public ni webhook. Le bot
reçoit les textes et vocaux du propriétaire dans une conversation privée ; les
textes passent par `mind-wake reply` et la même file que le desktop. Les vocaux
sont transcrits localement avec faster-whisper avant l'enregistrement. Le texte
est identifié comme transcription automatique. Les entrées sont découpées au
besoin pour respecter la limite du fil et conservent des identifiants stables.

Les nouveaux éléments du modèle `desktop/ui/conversation.ts` sont relayés : agent,
humain, aide, messages reçus/envoyés, contexte, objectif et plan. Les activités
(`activity`) sont exclues du relais, en texte comme en audio. Les
réponses d'aide facultatives sont incluses. Les entrées Telegram ne sont pas
renvoyées en écho. L'historique présent à la première activation sert de point
de départ ; il n'est pas envoyé en bloc. Une modification produit un nouvel
envoi. Les images et fichiers joints ne sont pas encore transférés comme médias.

Avec `sendAudio: true`, chaque texte relayé est également lu par la voix locale
Windows (française si disponible), encodé en Opus par FFmpeg et envoyé comme vocal.
Aucune API de transcription ou de synthèse payante n'est appelée.

## Configuration locale

Fichier `<dataDir>/telegram.json`, hors du dépôt et de l'espace de l'agent :

```json
{
  "enabled": true,
  "botToken": "TOKEN_BOTFATHER",
  "ownerUsername": "votre_compte",
  "ownerId": 123456789,
  "sendAudio": true,
  "transcription": {
    "python": "python",
    "model": "C:/chemin/vers/le/modele/faster-whisper"
  },
  "ffmpeg": "ffmpeg"
}
```

Le propriétaire doit avoir ouvert le bot et envoyé `/start`. L'identifiant
numérique est préférable au seul nom de compte. S'il est absent, le premier
message privé dont le nom Telegram correspond est associé durablement à son
identifiant numérique. Aucun autre utilisateur ou groupe n'entre dans le fil.

Installer Python, faster-whisper, un modèle CTranslate2 local, FFmpeg et une voix
Windows. La transcription utilise `local_files_only=True` : aucun téléchargement
implicite au moment d'un vocal. Les fichiers audio temporaires sont supprimés
après le traitement ; la transcription reste dans l'historique du fil.

Lancement : `node scripts/telegram-bridge.mjs <dataDir>`. Au prochain démarrage
local du desktop ou du MCP, `scripts/start-local.mjs` relance la passerelle si sa
configuration est activée. `telegram.pid` évite les consommateurs simultanés.
`telegram.stdout.log` et `telegram.stderr.log` restent dans le dossier du profil.

Pause, Force-off et une politique inactive suspendent la synchronisation. Les
messages attendent chez Telegram ; la passerelle ne lève jamais une pause. Un
message enregistré peut demander un wake normal, soumis aux contrôles du daemon.
Mettre `enabled` à `false` suspend aussi la synchronisation ; le processus reste
en veille pour permettre une réactivation. Relancer pour modifier les autres
paramètres. Arrêter uniquement le PID de `telegram.pid` pour quitter.

Les offsets, textes entrants à reprendre et envois réussis sont conservés dans
`telegram.sqlite`. Les retries évitent les doublons déjà confirmés ; une coupure
entre acceptation par Telegram et écriture du reçu peut encore doubler un envoi.
La source sortante reste l'historique visible du fil : une longue indisponibilité
ne garantit pas la reprise des activités sorties de sa fenêtre de rétention.

## Vérification

`node --test services/telegram/bridge.test.mjs` vérifie l'identité, les groupes,
les vocaux, les types du fil, les reprises, la déduplication, les erreurs et Pause.
`npm run build` et `npm run desktop:ui` préparent les modules employés au lancement.
La preuve réelle exige un texte et un vocal reçus depuis Telegram, leur présence
dans le fil et un message sortant avec son audio. Les tests seuls ne prouvent pas
une livraison réelle ni la qualité de reconnaissance d'une voix humaine.

Référence : [Telegram Bot API](https://core.telegram.org/bots/api).
