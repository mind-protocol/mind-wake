---
name: game-coach
description: Accompagner une partie en direct en regardant une capture du jeu toutes les cinq secondes et en affichant des conseils courts, cadres et post-it en overlay. Utiliser pour une demande de coaching visuel pendant que l’humain joue.
---

# Game coach

Observer la partie, comprendre ce qui vient de changer et faire apparaître dans le champ de vision du joueur une aide immédiatement utile. L’humain joue ; le coach regarde et conseille. Parler dans la langue du joueur.

## Démarrer

Repérer le jeu et sa fenêtre avec les outils disponibles. Charger les instructions du skill `computer-use` avant les captures ou toute interaction avec Windows, puis utiliser l’API de capture qu’il expose réellement dans cette session. Ne pas inventer de méthode ni lancer un collecteur de captures sans moyen de les regarder.

Une demande de coaching en direct autorise l’observation du jeu et les overlays pendant cette séance. Respecter les autorisations de capture existantes ; demander seulement si une surface nécessaire n’est pas couverte. Cette séance ne demande ni accès aux fichiers du jeu, ni contrôle du personnage, ni enregistrement vidéo. Si le jeu, l’objectif ou la difficulté sont reconnaissables, commencer sans questionnaire. Une question courte peut être utile si elle change les conseils : « Tu veux surtout survivre ou optimiser ton temps ? » Continuer l’observation en attendant.

Identifier une zone libre pour les conseils : ne pas cacher le viseur, le personnage, la minimap, les jauges, les sous-titres ou les commandes. Vérifier au premier affichage que l’overlay apparaît effectivement au-dessus du jeu sans lui prendre le focus. Le plein écran exclusif peut masquer les fenêtres Windows : signaler le problème et proposer le mode fenêtré sans bordure, sans changer les réglages du joueur à son insu.

## Boucle : une capture toutes les cinq secondes

1. Prendre une capture fraîche, noter son heure et **la regarder réellement** avec l’outil de vision. Capturer sans regarder ne constitue pas une observation.
2. Comparer à la précédente : position, santé, ressources, ennemis visibles, objectif, événements et effet du dernier conseil. Distinguer ce qui est lisible de ce qui est supposé. Conserver juste le contexte utile à la prochaine comparaison.
3. Choisir le conseil qui apporte le plus maintenant : danger, action prioritaire, ressource oubliée, placement, puis optimisation. Si rien ne mérite une intervention, laisser l’écran tranquille et reprendre une capture au prochain cycle.
4. Faire apparaître le contenu visuel pertinent via l’overlay ci-dessous. Relier le conseil à un élément visible lorsque cela clarifie l’action.
5. Viser la capture suivante à `heure de la capture précédente + 5 secondes`. Si le traitement est plus long, prendre la suivante dès que possible ; ne pas accumuler de captures à analyser en retard. La cadence est une cible réelle, pas une garantie de temps réel dur. Ne pas annoncer une cadence tenue sans l’avoir constatée.

Répéter pendant la séance, jusqu’à la demande d’arrêt du joueur ou à une limite réelle du runtime. Traiter les nouveaux messages entre deux cycles. « Stop », « pause coach » ou une pause de Wake interrompent la boucle et retirent les overlays de cette séance ; reprendre seulement à la demande correspondante. Si le jeu est quitté ou remplacé par une autre application, suspendre les captures jusqu’au retour du jeu. Une réponse finale met fin à la boucle interactive : ne pas prétendre continuer à regarder en arrière-plan après celle-ci.

Ne pas interpréter les propres post-it du coach comme des éléments du jeu. Une capture de fenêtre peut exclure l’overlay : vérifier sa présence séparément sur une surface autorisée si nécessaire. Ne pas conserver une collection de captures sur disque par défaut ; utiliser l’image courante et la précédente, et des notes brèves sur l’évolution.

## Choisir et présenter un conseil

- **Une action courte et située** : « Recule derrière le pilier ; ta vie est basse. » Une dizaine de mots se lit mieux qu’une explication pendant un combat.
- **Un repère précis** : encadrer la potion, la sortie, la couverture ou le bouton concerné. Un cadre suit une position observée, pas une cible supposée hors champ.
- **Une temporalité compatible avec cinq secondes** : privilégier positionnement, ressources, trajectoire, choix et préparation. Ne pas promettre de guider une parade à la frame près ou d’esquiver une attaque déjà terminée lors de l’affichage.
- **Une confiance honnête** : « Il semble préparer une charge : garde une issue » si l’animation est ambiguë. Ne pas inventer une recharge, une touche, un ennemi invisible ou une mécanique de jeu. Vérifier une règle incertaine dans une source appropriée avant de la présenter comme un fait ; garder les conseils immédiats fondés sur l’image pendant ce temps.
- **Peu de bruit** : un post-it et éventuellement un cadre suffisent souvent. Ne pas réafficher le même conseil toutes les cinq secondes. Un double-clic de suppression exprime au minimum que ce conseil doit disparaître ; ne pas le recréer identique au cycle suivant. Si la fermeture n’est pas observable, éviter quand même les répétitions tant que la situation ne change pas.
- **Un ton de partenaire** : signaler un progrès concret (« Tu gardes maintenant une sortie à gauche »), proposer une expérience et adapter l’aide aux décisions du joueur. Garder le bilan détaillé pour une pause ou la fin de partie.

## Afficher avec l’outil post-it local

Installation connue sur ce poste :

`C:/Users/reyno/AppData/Local/mind-wake-essai/workspace/artifacts/tools/postit/postit.ps1`

Lire son `README.md` et vérifier les fichiers avant la première utilisation. Sur un autre poste, rechercher l’outil dans l’espace live au lieu de recopier ce chemin. Le script accepte `sticky`, `box` et `text` ; tous se déplacent par glisser gauche et se suppriment au double-clic gauche. La croix du post-it reste disponible. Pour déplacer un cadre, attraper le trait ou la légende ; son intérieur laisse passer les clics.

Écrire un JSON UTF-8 propre à la séance dans un dossier autorisé, puis lancer le script sans fenêtre console et sans activation. Exemple PowerShell, avec des chemins absolus résolus au préalable :

```powershell
$coachScript = 'C:\Users\reyno\AppData\Local\mind-wake-essai\workspace\artifacts\tools\postit\postit.ps1'
# $coachMarks et $coachLog sont les chemins absolus des fichiers de cette séance.
$coachArgs = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Marks "{1}" -Log "{2}"' -f $coachScript, $coachMarks, $coachLog
$coachProcess = Start-Process powershell.exe -WindowStyle Hidden -ArgumentList $coachArgs -PassThru
```

Garder la référence du processus lancé. Avant de remplacer un conseil encore visible ou à l’arrêt de la séance, fermer uniquement ce processus s’il tourne encore ; ne jamais arrêter tous les PowerShell. Ce script lit son JSON au démarrage : modifier le fichier seul ne met pas à jour les fenêtres existantes. Utiliser un fichier distinct par affichage, ou terminer l’ancien processus avant de réutiliser son fichier. L’expiration courte retire aussi les indications périmées si l’agent est interrompu.

Pour le coaching, régler en général `ttl_seconds: 5`, avec `for: 5` pour chaque élément et `at: 0`. Renouveler seulement si une nouvelle observation le justifie. Cette cadence de séance répond à la demande de coaching ; la recommandation générale d’un seul visuel par réveil dans l’ancien README ne doit pas empêcher cette boucle explicitement demandée.

Les coordonnées `x`, `y`, `w`, `h` des post-it et cadres utilisent le repère **1280 × 720 de l’écran principal entier**, pas celui de la capture recadrée du jeu. Pour un rectangle observé en pixels écran, calculer `x = (pixelX - écranGauche) × 1280 / écranLargeur`, et de même pour `y`, `w`, `h` avec 720 pour l’axe vertical. Si la capture est redimensionnée ou limitée à la fenêtre, rétablir d’abord son échelle et son décalage sur l’écran. Vérifier l’alignement. L’outil actuel vise l’écran principal : si le jeu est sur un autre écran, résoudre cette limite avant d’annoncer des repères alignés.

`text` lance une recherche OCR sur l’écran courant au démarrage. L’utiliser pour une étiquette stable et visible ; préférer `box` pour un objet de jeu ou une cible mobile. Les cadres ne suivent pas automatiquement leur cible : les retirer ou les recalculer dès que la situation change.

## Exemples détaillés

Ces scènes sont des exemples de décision, pas des observations de la partie actuelle. Les coordonnées sont illustratives ; les recalculer depuis la capture réelle.

### Survie : vie basse, soin visible, abri proche

**Image observée :** la barre de vie est presque vide, un soin est disponible et un rocher protège une zone proche. L’ennemi regarde vers le joueur.

**Choix :** recommander d’abord de rejoindre l’abri, puis de se soigner. Encadrer l’abri plutôt que l’ennemi ; ne pas supposer qu’un soin en terrain découvert passera.

```json
{
  "ttl_seconds": 5,
  "marks": [
    {
      "kind": "sticky", "x": 35, "y": 35, "w": 290,
      "color": "orange", "shape": "arrondi", "at": 0, "for": 5,
      "text": "# Priorité : survivre\nPasse derrière le rocher, puis soigne-toi."
    },
    {
      "kind": "box", "x": 850, "y": 270, "w": 150, "h": 180,
      "note": "abri", "at": 0, "for": 5
    }
  ]
}
```

**Au cycle suivant :** si le joueur est à l’abri et sa vie remonte, retirer l’alerte. Si le rocher a quitté l’image, ne pas laisser son ancien cadre. Ne pas répéter « soigne-toi » lorsque le soin est déjà en cours.

### Stratégie / gestion : production arrêtée

**Image observée :** une file de production est vide, des ressources sont disponibles, aucun danger immédiat n’est visible. Cela ne prouve pas que la dépense soit stratégiquement optimale.

**Visuel :** un post-it bleu, « Production à l’arrêt : relance une unité si tu n’économises pas », et un cadre autour de la file vide. Le conditionnel préserve une éventuelle intention d’épargne du joueur.

**Au cycle suivant :** si une unité est en file, retirer le rappel. Si l’humain dit qu’il économise pour une amélioration, intégrer ce choix aux cycles suivants et chercher une autre aide utile.

### Boss : préparation et fenêtre de reprise

**Images comparées :** sur la première, le boss lève son arme ; sur la seconde, le joueur est bloqué entre le boss et un mur. Deux images espacées de cinq secondes ne suffisent pas pour mesurer le timing exact de l’attaque.

**Visuel :** « Garde une sortie sur le côté ; évite de te coller au mur », avec un cadre sur un espace libre encore visible. Après une attaque observée terminée et une ouverture claire : « Ouverture courte : une action, puis replace-toi. »

**À éviter :** « Esquive maintenant ! » fondé sur une image déjà ancienne, un compte à rebours inventé ou une flèche qui prétend suivre l’arme en direct.

### Course : préparer le prochain virage

**Image observée :** un virage serré approche et la voiture arrive sur l’intérieur. La vitesse affichée est lisible, mais aucune distance de freinage fiable n’a été établie.

**Visuel :** un post-it en haut dans une zone libre, « Prépare le virage : élargis ton entrée et freine en ligne. » Encadrer un repère fixe visible seulement si sa position aide réellement ; ne pas déplacer le regard du joueur vers une décoration inutile.

**Au cycle suivant :** comparer la trajectoire et la sortie. Sur une portion calme : « Ta sortie est plus propre ; conserve cette marge à l’entrée. » Éviter d’annoncer un gain de temps non mesuré.

### Puzzle : donner un indice progressif

**Images comparées :** le joueur essaie plusieurs fois la même combinaison sans changement. Un symbole récurrent est visible près du mécanisme.

**Premier visuel :** un cadre discret sur le symbole et « Ce motif apparaît aussi près de la porte. » Laisser le joueur essayer.

**Suite :** s’il demande une aide plus directe, proposer la relation observée puis la prochaine manipulation. Ne pas dévoiler toute la solution d’emblée. Si le joueur explore une autre piste, retirer le cadre au lieu de réimposer l’indice.

### Menu stable : attirer l’attention sur une option lisible

**Image observée :** le joueur cherche comment baisser un effet et l’option « Flou de mouvement » est clairement visible. L’étiquette doit être celle effectivement affichée dans le jeu.

```json
{
  "ttl_seconds": 5,
  "marks": [
    {
      "kind": "text", "find": "Flou de mouvement", "max": 1,
      "note": "cette option réduit le flou", "at": 0, "for": 5
    }
  ]
}
```

Le joueur choisit et modifie lui-même l’option. Si l’OCR ne trouve rien, utiliser un cadre issu de la capture au prochain affichage et ne pas annoncer que le texte a été souligné.

## Terminer

Retirer les visuels encore actifs de cette séance. Donner, si utile, un bilan court fondé sur ce qui a été observé : un progrès, une difficulté récurrente, une prochaine expérience. Distinguer les conseils affichés, leur visibilité réellement vérifiée et leur effet constaté dans la partie. La création de ce skill ne démarre pas une séance de capture.
