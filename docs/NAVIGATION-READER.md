# Lecteur de documents — navigation de l’atelier

Le panneau droit réunit une bibliothèque, un lecteur HTML/Markdown et un parcours entre documents. La conversation et le fil du projet restent indépendants.

## Les trois niveaux

- **Projet** : la bibliothèque regroupe les créations sous artifacts/creations/<projet>, puis les autres dossiers de premier niveau. La recherche ignore les accents et se combine avec le filtre HTML/Markdown.
- **Document** : les documents sont ordonnés par modification récente. Les grands boutons Précédent/Suivant affichent leur destination ; le bouton Dernière modification revient au début de la sélection courante. Les petites flèches Retour/Avancer suivent l’historique de lecture, distinct de cette liste.
- **Section** : le sommaire est construit à partir des titres h1/h2/h3. Les identifiants manquants ou dupliqués sont rendus uniques pour que chaque entrée cible son propre titre.

Le tiroir Explorer se superpose au lecteur sur les écrans plus étroits ; il se place à côté sur les écrans larges. Une ouverture demandée depuis une carte Projets ferme le tiroir pour rendre le document visible. Les boutons de pagination restent accessibles dans le panneau défilable et mesurent 70 px de haut sur écran large, 62 px sous 700 px.

## Continuité

Le document courant et les positions de lecture sont conservés dans le stockage local du webview, par espace et par chemin. Le rendu effectivement chargé possède sa propre référence : une réponse de lecture encore en cours ne peut pas écraser la position du document précédent. Une ouverture manuelle en cours l’emporte sur la restauration initiale. Une navigation historique échouée ne déplace pas l’index d’historique.

`wake-open-document` ouvre un chemin connu dans un espace agent ou project, sans changer le focus de la saisie. Les extensions de détection de fichiers dans les messages et de file contextuelle Suivant sont un chantier séparé ; leur état est décrit dans le rapport correspondant, pas présumé actif par ce document.

## Lecture et confinement

Le catalogue récursif passe par `document_browse`, avec les mêmes racines canoniques que la lecture existante. Il ne suit pas les liens symboliques, exclut les dossiers cachés et de compilation et annonce sa troncature si la garde de 10 000 entrées ou dossiers est atteinte. La lecture reste limitée aux HTML/Markdown de ces racines et à 2 Mo par document.

Le mode de rendu conserve la politique existante : scripts, cadres imbriqués, formulaires et chargements distants sont désactivés. La navigation personnalisée ne transforme donc pas le lecteur en exécuteur de pages arbitraires.

## Vérification

Le contrôle TypeScript desktop, les tests de recherche/groupement et les tests Rust de confinement/catalogue passent. L’affichage réel, Explorer, les sections, les grands boutons, l’ouverture depuis une carte et la présence du fil doivent être vérifiés sur le binaire relancé. Le rapport de livraison live est `artifacts/findings/navigation-plateforme-livraison.md` dans l’espace de l’agent ; une compilation ne suffit pas à déclarer le rendu montré.
