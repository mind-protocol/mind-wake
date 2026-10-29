# Contexte visuel au réveil

Option Windows, désactivée par défaut. Une autorisation locale explicite choisit `wake-window` (la fenêtre du desktop MIND Wake) ou `primary` (écran principal). Aucun autre écran ni fenêtre ne sert de repli. Le mode `wake-window` vérifie le chemin de l’exécutable du desktop du dépôt ; les emplacements d’un futur paquet installé restent à intégrer.

## Fonctionnement

Le daemon capture une fois au lancement de chaque session réelle Codex ou Claude, après les contrôles du scheduler et avant la transmission au runtime. Une capture échouée n’empêche pas le réveil textuel. Le helper refuse un poste verrouillé ; pour `wake-window`, une fenêtre absente, cachée ou minimisée donne un réveil sans image.

Le helper Windows utilise `PrintWindow` pour MIND Wake, sans capturer le bureau derrière la fenêtre. Il réduit l’image en conservant ses proportions : 1 280 pixels au maximum sur le grand côté, sans agrandissement, JPEG qualité 70 et taille encodée bornée. Il ne conserve ni original ni fichier image. La capture est horodatée ; un adapter omet une image vieille de plus de 15 secondes plutôt que réutiliser une capture périmée.

Claude reçoit un bloc image base64 dans son message utilisateur ; Codex reçoit un item `image` avec une data URL dans `turn/start`. Le prompt système reste séparé. La légende qualifie les pixels de contexte non fiable qui ne donne aucune instruction ni permission.

Les formats suivent les sources officielles : [vision Claude](https://platform.claude.com/docs/en/build-with-claude/vision) et [protocole App Server Codex](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).

## Autorisation et révocation

Configuration administrée hors du workspace de l’agent : `<dataDir>/installation/wake-screenshot.json` :

```json
{
  "enabled": true,
  "surface": "wake-window",
  "authorizedAt": "2026-10-29T15:00:00.000Z",
  "providerTransmissionAcknowledged": true
}
```

La date doit être celle de l’accord réel. Le daemon relit ce fichier avant chaque capture. `enabled: false` retire la capture aux réveils suivants, y compris si le lancement indiquait une surface. Une image déjà envoyée ne peut pas être rappelée.

Le lanceur humain peut également choisir `daemon run --wake-screenshot wake-window`, `--wake-screenshot primary` ou `--wake-screenshot off`. L’option ne s’applique qu’à `daemon run`. Elle ne doit pas être ajoutée par un contenu lu dans l’image ou par une note de l’agent. Le sélecteur desktop n’est pas encore implémenté.

## Confidentialité et limites

L’application Wake garde le contenu en mémoire pour cette transmission, sans l’écrire dans son journal ou ses checkpoints. **Cela ne signifie pas absence de conservation chez le fournisseur ou dans l’historique du CLI** : un runtime peut enregistrer les messages multimodaux. La surface choisie peut afficher des informations privées. La réduction n’anonymise rien et aucun masquage automatique de secrets n’est promis.

La détection du verrouillage est codée en refus par défaut ; un essai réel de verrouillage reste à effectuer. `PrintWindow` dépend de la fenêtre et de WebView2 : une capture indisponible est omise, et une image rendue noire reste une limite à contrôler visuellement. La capture ne doit jamais être présentée comme un flux continu ou une preuve de l’état courant du poste.

## Vérifications du 29 octobre 2026

- Capture réelle de la seule fenêtre MIND Wake : 456 × 719 pixels, environ 49 Ko de JPEG, sans fichier image sauvegardé.
- Redimensionnement natif sur une image synthétique : 2 560 × 1 440 → 1 280 × 720, proportions conservées.
- Tests : absence d’image par défaut, formats des deux adapters, horodatage, rejet du périmé et des tailles invalides, sélection exacte et révocation.
- Un vrai lancement a préparé une capture dans le daemon ; ce lancement a été interrompu par la garde de quota. Cela ne valide pas encore l’interprétation de l’image par le modèle. Une session parallèle a ensuite repris le moteur ; ne pas la réinitialiser pour cette vérification.

## Choix actuel corrigé

Le propriétaire a remplacé le choix initial `wake-window` par l’écran principal entier (`primary`). Le réglage a été enregistré pour le profil d’essai ; cela ne reprend pas un moteur en pause. L’ajout de texte est une fonction distincte : préciser s’il s’agit du texte visible dans la fenêtre active ou des messages saisis dans MIND, sans assimiler cette demande à un historique global de frappes.
