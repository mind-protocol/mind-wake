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

## Questions et réponses locales

Un `sticky` peut porter `question: { "id": "question-stable-v1", "mode": "yes_no" }`
pour afficher Oui / Non. Pour plusieurs possibilités, utiliser `mode: "choice"` et
`options: [{"id":"indices","label":"Indices progressifs"}, ...]` (2 à 8 options,
un seul choix). Les boutons restent cliquables sans activation de la fenêtre. Le
texte du sticky est la question envoyée ; chaque question et chaque option ont un
identifiant stable. Ne jamais réutiliser un identifiant pour une autre question.

Le document doit préciser `reply_transport`, avec les chemins **absolus** `cli`
(le `dist/cli/main.js` de Wake), `data_dir` (l'instance du propriétaire visé) et
`response_dir` (le dossier local des choix et reçus). Il faut Node et une CLI Wake
compilée. Le script `postit-reply.mjs` reste à côté de `postit.ps1`.

Seul un clic humain sur un bouton sauvegarde le choix, puis lance la CLI locale
`reply --data-dir … --idempotency-key … --json` avec le texte sur stdin, sans
capture ni accès au réseau. Le reçu `recorded` ou `duplicate`, vérifié avec l'ID et
le texte exacts, produit « Transmis à Marco ». Cela atteste la mise en file dans
la conversation, pas la lecture par le modèle. Aucun message n'est envoyé lors
de l'affichage, de la fermeture ou de l'expiration du post-it.

La question disparaît dès le clic, après sauvegarde du choix et déclenchement du
transport. Les autres post-its restent affichés. Le processus d'envoi termine et
écrit son reçu indépendamment de la fenêtre fermée. La disparition n'est pas un
accusé de livraison. En cas d'échec, relancer la même question recharge le choix
conservé et affiche « Réessayer l'envoi » ; aucun nouveau choix n'est fabriqué.

En cas d'échec : « Conservé localement ; envoi non confirmé », choix verrouillé
et bouton « Réessayer l'envoi ». Le même choix et la même clé sont réutilisés ;
une relance du post-it recharge le choix sauvegardé, sans envoi automatique.
Les fichiers `<sha256(question.id)>.json` contiennent la réponse ; les fichiers
`.delivery.json` contiennent le reçu de transport. Ils restent locaux après le TTL
pour permettre la reprise. L'envoi dure au maximum 15 secondes ; un envoi déjà
demandé peut s'achever après fermeture ou expiration de la fenêtre.

Vérification isolée, sans écrire dans une vraie conversation :
`node --test tools/postit/postit-reply.test.mjs` depuis le dépôt Wake.
Le contrat de fermeture et de reprise, sans fenêtre affichée ni vraie boîte de
réception : `powershell -NoProfile -STA -File tools/postit/postit-ui-contract.test.ps1`.

## Savoir-vivre

### Répondre et réagir

Un sticky avec `reply_to: "own_identifiant-du-message"` et le même
`reply_transport` affiche **Répondre** et **Émote**. Répondre ouvre une saisie
libre (4000 caractères maximum, référence incluse). Émote propose 👍 J'aime,
❤️ J'adore, 😂 Drôle, 🤔 À creuser. Chaque envoi conserve la référence au
post-it source. Aucune capture pour ces réponses ou réactions.

Le formulaire ne prend pas le focus à son apparition ; un clic humain dans la
saisie permet de taper. Entrée envoie, Maj+Entrée ajoute une ligne, Échap ou la
croix ferme sans envoyer. Le post-it source reste ouvert pendant la saisie ;
son expiration est suspendue. Envoyer sauvegarde puis lance le transport avant
de fermer la saisie et ce seul post-it. Les fichiers `postit-*.json` et leurs
reçus `.delivery.json` permettent de distinguer contenu sauvegardé et livraison.

### Remplacement du clic droit

`reply-postit.ps1 -Listen -Cli <absolu> -DataDir <absolu> -ResponseDir <absolu>`
observe les clics droits physiques dans un processus supervisé. Désactiver
d'abord « Clic droit — saisie rapide » du desktop pour éviter deux interfaces.
La fenêtre WinForms offre texte libre, Envoyer, Bumpe, croix et Échap. Elle
reste jusqu'à fermeture/envoi et conserve sa cible pendant la saisie. Son
menu de notification permet d'arrêter cet observateur. Aucun service détaché,
nouvelle permission, capture périodique ou redémarrage du daemon requis.

Seuls **Envoyer** ou **Bumpe** depuis ce formulaire ciblé demandent la capture
unique déjà prévue par la CLI du clic droit, avec les coordonnées physiques
issues du hook. Le clic droit seul n'envoie rien et ne capture rien. Bumpe
relit le prompt existant `workspace/artifacts/prompts/bump.md` ; la CLI refuse
un point périmé. Pause et Force-off gardent leur effet sur les jobs supervisés.

Test invisible supplémentaire :
`powershell -NoProfile -STA -File tools/postit/reply-postit-contract.test.ps1`.

`hide-stuck-quick-input.ps1 -Hwnd <identifié> -ExpectedPid <desktop>` masque
uniquement la fenêtre existante vérifiée par PID, nom de processus et titre.
Il ne termine aucun processus. À utiliser après contrôle de l'identité réelle.

- **1 visuel par réveil au maximum**, ~**45 s** (`ttl_seconds: 45`).
- **Ne jamais couvrir la zone de saisie de l'humain, en bas au centre** (en gros y > 600 dans le repère 1280x720) : préférer le haut de l'écran.
- Peu de texte, une idée par post-it.
- **Toujours laisser aussi une note écrite dans le chat** : le post-it est éphémère, l'humain peut ne pas le voir.
