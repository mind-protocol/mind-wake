# postit — post-its d'agent sur l'écran (Windows, PowerShell 5.1)

Affiche des post-its et des repères par-dessus l'écran de l'humain, puis s'efface seul.
Ne tape rien, ne clique rien, ne vole pas le focus.

## Lancer (détaché, sans fenêtre console)

```
powershell -NoProfile -Command "Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<chemin>\postit.ps1','-Marks','<chemin>\marks.json'"
```

- `-Marks` : fichier JSON (défaut : `..\..\overlay\marks.json`). Encodage UTF-8.
- `-Log` : journal (défaut : `overlay.log` à côté du fichier marks). Lire après coup pour vérifier (« affiché … », erreurs, « fermé »).
- Ancien appel `tools\postit.ps1` : toujours valable (simple relais vers ce script).

## Champs (détail : `marks.schema.json`, exemple : `exemple.json`)

- `ttl_seconds` : durée totale (défaut 60).
- Chaque marque : `kind` = `sticky` | `box` | `text`, `at` (apparition, s), `for` (durée, s).
- Coordonnées `x`, `y`, `w`, `h` dans un repère **1280x720**, mis à l'échelle de l'écran principal.
- `sticky` : `text`, `color` (`jaune` `rose` `bleu` `vert` `orange` `violet` ou `#RRGGBB`), `shape` (`note` carré + ombre, `arrondi`, `bulle` avec queue en bas à gauche), `w` (défaut 300).
  Dans `text` : ligne `# Titre` = titre gras ; ligne entourée de `**…**` = gras ; emoji acceptés, **rendus en monochrome** (repli Windows sur Segoe UI Emoji).
  Croix ✕ en haut à droite : l'humain ferme le post-it d'un clic.
- `box` : cadre rouge `x y w h`, légende `note`.
- `text` : `find` = mots cherchés à l'écran par OCR Windows (en mémoire, rien n'est écrit), soulignés en orange ; `note`, `max` (défaut 3).

Tous les éléments (`sticky`, `box`, chaque occurrence `text`) se déplacent en maintenant le bouton gauche et en glissant. Un double-clic gauche sur l'élément le supprime pour l'affichage en cours ; il ne réapparaît pas avant la fin de la session. La croix des post-its reste utilisable.

Pour les cadres et repères OCR, attraper le trait ou la légende : l'intérieur transparent laisse passer les clics vers l'application dessous. Les déplacements n'altèrent pas `marks.json`. L'expiration et l'affichage sans prise de focus restent actifs.

## Savoir-vivre

- **1 visuel par réveil au maximum**, ~**45 s** (`ttl_seconds: 45`).
- **Ne jamais couvrir la zone de saisie de l'humain, en bas au centre** (en gros y > 600 dans le repère 1280x720) : préférer le haut de l'écran.
- Peu de texte, une idée par post-it.
- **Toujours laisser aussi une note écrite dans le chat** : le post-it est éphémère, l'humain peut ne pas le voir.
