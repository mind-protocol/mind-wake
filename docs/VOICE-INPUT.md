# Dictée dans le fil desktop

Le bouton **Voice**, près de la saisie, ouvre le microphone après un clic explicite.
Il enregistre des extraits complets de 25 secondes, démarrés toutes les 20 secondes :
5 secondes se chevauchent pour éviter de perdre la fin d'une phrase. Le premier
résultat est préparé après 25 secondes, puis le temps de transcription locale ; les
suivants sont préparés toutes les 20 secondes. Les traitements sont séquentiels.

L'écran principal est capturé au plus une fois toutes les 10 secondes. Chaque
extrait garde sa capture de début, les captures intermédiaires et une capture
finale ; celle-ci attend le prochain créneau si nécessaire. Les extraits qui se
chevauchent réutilisent les mêmes captures au lieu d'en prendre davantage.
Chaque message joint au maximum trois images : début, milieu et fin. Les captures
JPEG gardent leurs proportions, avec un grand côté de 960 px au maximum et un
plafond de 96 000 octets par image ; la résolution diminue encore si nécessaire.
Le texte et toutes ces images horodatées sont envoyés dans le fil **Mon agent**,
sans toucher au brouillon clavier ni à ses images. Sans transcription non vide,
aucun message ni aucune capture n'est envoyé.

Un second clic arrête le microphone et traite l'extrait partiel. Pause, Force-off
et la fermeture de l'app arrêtent le microphone et annulent les extraits encore
en attente. Le microphone ne redémarre jamais automatiquement. Le bouton rouge
et le statut signalent l'enregistrement. Les erreurs de capture ou de
transcription sont affichées ; aucun texte n'est inventé en cas d'échec.

La reconnaissance emploie faster-whisper local, avec le modèle déjà téléchargé.
`<dataDir>/voice-input.json` peut fournir :

```json
{ "transcription": { "python": "python", "model": "C:/chemin/vers/modele-local" } }
```

À défaut, les mêmes paramètres sont lus dans la configuration Telegram du profil.
Aucun téléchargement ni appel de reconnaissance payant n'est lancé implicitement.
L'audio temporaire est supprimé après transcription. Les images envoyées et les
messages suivent la conservation normale du fil.

En mode Voice, les nouvelles réponses de Marco sont lues à voix haute par la
voix française locale. Les messages d'activité, les messages humains et
l'historique déjà présent ne sont pas lus. Le microphone est temporairement
muet pendant la lecture pour éviter de retranscrire la voix de l'application.
Arrêter Voice ou mettre Wake en pause coupe également cette lecture.

La suppression du chevauchement retire une séquence commune d'au moins trois
mots entre la fin de la transcription précédente et le début de la suivante,
en ignorant casse et ponctuation. Elle reste imparfaite si la reconnaissance
reformule les mêmes paroles. Une répétition de moins de trois mots est conservée.

Tests : `npx vitest run desktop/ui/voice-input.test.ts`.

## Paint

Quand le panneau est ouvert, maintenir **Ctrl + Shift** trace la trajectoire du
curseur sur l'écran principal : rouge, largeur 5 px, extrémités rondes et courbes
quadratiques lissées. Relâcher termine le trait ; **Échap** efface le dessin.
Le dessin s'efface automatiquement 15 secondes après le dernier trait. La
surcouche reste transparente aux clics et ne prend pas le focus. Elle consulte
uniquement les touches de modification et les coordonnées du curseur pendant le
geste, sans enregistrer le texte saisi. Les captures de dictée incluent le dessin
visible sur l'écran au moment de la capture.
