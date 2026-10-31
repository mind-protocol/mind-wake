# Atelier d’Aurore : clone local explicitement lié

Le panneau lit le clone de son workspace, avec l’origine exacte
`https://github.com/mind-protocol/scisense-aurore-workspace.git`.
Il n’appelle pas le MCP scoped et ne fait aucune opération réseau ou de synchronisation.

Le processus desktop doit recevoir `MIND_WAKE_DATA_DIR`. Sans cette variable, sans
`atelier-aurore.json` dans ce dossier ou avec `enabled` différent de `true`, la liaison
reste inactive. Après revue, l’opérateur peut créer ce fichier :

```json
{"enabled":true,"origin":"https://github.com/mind-protocol/scisense-aurore-workspace.git"}
```

Le seul emplacement accepté est alors
`<MIND_WAKE_DATA_DIR>/linked-workspaces/aurore-mind-protocol`.
Le fichier de liaison n’accepte aucun chemin, endpoint ou credential. Les paramètres
de la webview ne permettent pas de changer cet emplacement. Désactiver le fichier
prend effet à la requête suivante. L’actualisation reste limitée au scope choisi.
La liaison ne peuple pas le dépôt et ne constitue pas une autorisation de publier.

Le lecteur valide une unique URL `remote.origin.url` dans la configuration Git locale,
exige un `.git` répertoire interne et refuse les liens/jonctions sur les chemins lus.
Il ne remplace pas les règles Git de propriété du dépôt (`safe.directory`).
Un échec d’accès ou un dépôt corrompu produit une erreur, sans repli.

États natifs : `not-configured`, `invalid-origin`, `empty` (version nulle pour branche
sans commit), `available` avec SHA du commit, `version-changed`, `error`.
`syncing` conserve la vue pendant une opération supervisée. Une demande de catalogue
avec la version déjà chargée renvoie `unchanged` sans parcourir les fichiers ni l’historique ;
une autre version renvoie `version-changed`. Ces sondes sont strictement locales.
Un commit existant sans documents compatibles produit `empty` avec sa SHA.
Le catalogue retient les blobs réguliers suivis, de chemin non caché, dont les composants
présents dans le clone passent la vérification de confinement. Une suppression locale
non committée ne retire pas le blob du catalogue et ne remplace pas sa date Git. Les sous-modules
et liens Git sont exclus. Le contenu lu provient du blob commité, jamais des modifications
non commitées ou des fichiers non suivis. HTML/Markdown/TXT : 2 Mo ; raster : 8 Mo.
Le catalogue est limité à 10 000 documents ; les commandes Git ont un délai de 5 s et
une sortie maximale de 12 Mo. Aucun filtre Git de contenu n’est exécuté.

La SHA du catalogue accompagne les ouvertures et les images. Si HEAD a changé, le
lecteur exige une actualisation. Le contenu utilise le rendu, l’assainissement HTML,
la CSP et le décodeur raster existants. Le scope Aurore conserve son historique de
navigation et ses positions ; Next utilise son propre catalogue. Les noms d’Aurore
ne sont pas publiés dans le catalogue de conversation de l’humain. Les générations
de navigation rejettent les réponses d’un scope quitté, y compris après un aller-retour.

## Réplication supervisée toutes les 60 secondes

`AuroreGitSync`, créé par le daemon réel dans le profil hôte déjà autorisé, est appelé
par la même maintenance `Scheduler.run` que `WorkspaceGitSync`. Il ne dépend pas de
l’activation de la synchronisation du workspace personnel. Il n’ajoute ni daemon ni
boucle de réveil. L’opt-in `atelier-aurore.json` reste nécessaire, ainsi que la policy
active, l’accord hôte existant et l’absence de Pause, Force-off et StopFlag. Il ne
crée pas de clone et n’active aucune permission.

Premier passage autorisé immédiatement, puis échéance persistée à 60 s du **début**
de tentative, traitée au passage suivant de la maintenance (pas de rattrapage ni de
concurrence). Chaque commande passe par le lanceur Git existant sous Job Object
Windows ; une révocation est surveillée pendant la commande et interrompt son arbre.
La fermeture du daemon annule le travail en cours. Aucun rappel n’est conservé
pendant Pause/Force-off ; une reprise humaine reste nécessaire pour réautoriser le travail.

Le clone et son `.git` interne doivent être confinés, sans jonction, lien symbolique
ou lien dur de fichier. La validation est bornée à 100 000 entrées. Le verrou exclusif
`.git/mind-wake-workspace-sync.lock`, partag? avec le synchroniseur du workspace personnel,
contient PID et jeton ; le lecteur le respecte aussi.
Ne jamais supprimer automatiquement un verrou existant, même apparemment périmé.
Après inspection locale de son propriétaire, l’opérateur peut résoudre un verrou
abandonné. Le synchroniseur ne retire que le verrou dont il détient encore le jeton.

Origine unique exacte et branche `main` sont exigées. Les opérations sont : validation
du clone propre (y compris les fichiers locaux ignorés), fetch de l’URL HTTPS fixe et de `refs/heads/main`, comparaison
d’ascendance, nouvelle validation puis merge `--ff-only` vers la SHA fetchée. Aucun
push, add, commit, reset, clean ou stash. Un clone sale, en avance ou divergent et
une panne réseau laissent les documents committés en place ; l’erreur visible est
réessayée au prochain cycle autorisé. Les opérations Git inachevées bloquent l’avance.

La configuration Git système/globale est exclue, les includes locaux, filtres,
helpers locaux, remplacements d’URL et extensions sont refusés par une liste de clés
permises. Hooks, fsmonitor, récursion des sous-modules et maintenance Git opportuniste
sont désactivés. Les arbres entrants avec liens ou sous-modules sont refusés.
Sous Windows, seul le helper officiel Git Credential Manager déjà installé peut
réutiliser un accès existant à cette origine, en mode non interactif. Aucun login,
installation de helper ou repli sur un token n’est effectué ; sans accès disponible,
le fetch échoue et l’erreur reste visible. Les fixtures n’utilisent aucun compte.

`<dataDir>/aurore-sync-state.json` expose état, dernière tentative, dernier succès,
échéance, erreur et SHA. Le lecteur ne transmet que les champs de statut destinés
à l’affichage. Le dernier succès est une **date de synchronisation**, jamais celle
d’un fichier. Le lecteur interdit aussi les fetchs paresseux des clones partiels.

La vue déjà ouverte relit son catalogue à sa cadence minute existante. Les événements
de statut desktop existants déclenchent aussi une sonde locale de version, espacée
d’au moins 5 s. Après changement, le catalogue et la page courante sont rechargés
avec la nouvelle SHA, sans changer de scope, de filtres, de brouillon ou de conversation.
Les générations de navigation rejettent les sondes tardives. Un document retiré garde
son aperçu précédent avec une indication explicite ; `syncing`/`version-changed`
conservent l’aperçu pendant le rattrapage. Aucun chemin arbitraire ne vient de la vue.

## Dates et ordre du catalogue

Pour Aurore, `modifiedAt` est la date **committer** du dernier commit Git touchant
ce chemin dans l’historique de la SHA chargée, en millisecondes Unix ; provenance
`modifiedAtSource: git-path-commit`. Un unique `git log` borné (20 000 commits, 12 Mo,
5 s) collecte les dates de tous les chemins. Les renommages comptent comme une
modification du nouveau chemin, sans inventer une date antérieure au renommage.
La date d’un fichier inchangé ne devient jamais celle de HEAD, du checkout ou du fetch.

Une frontière d’historique shallow ne prouve pas la dernière modification : date nulle,
raison `shallow-history-boundary`. L’absence de date au-delà de cette frontière donne
`shallow-history-unavailable` ; historique inaccessible ou borne atteinte donne
`history-limit-or-unavailable`. L’interface indique ces raisons, sans date de substitution.
Les dates Git sont étiquetées « Modifié dans Git », avec ISO UTC dans le détail.
Les scopes locaux conservent leurs dates mtime et leur libellé de modification locale.

Catalogue et vue sont triés par date décroissante, inconnues en fin, puis par chemin
à égalité. La limite de 10 000 documents s’applique après le tri. « Dernière modification »
ouvre le premier document de cet ordre. Dépôt et révision chargée restent visibles,
distincts du dernier succès de sync. La SHA accompagne aussi le read et les images ;
une vérification finale de HEAD/verrou rejette une lecture traversée par une avance.

`artifacts/PERSONALITY.md` n’apparaît que s’il est effectivement présent et commité.
Le prompt complet généré sous `dataDir/runtimes/...` ne fait pas partie de ce clone
et n’est ni lu ni publié par ce panneau.

Vérification locale : `node --test services/shared-workspace/git-document-reader.test.mjs`,
tests `desktop/ui/document*.test.ts`, compilation TypeScript desktop et tests raster Rust.
Les fixtures sont artificielles et restent dans `output/scisense-raccord/fixtures`.
La compilation Tauri et la recette visuelle restent nécessaires avant installation.
Recette supplémentaire sans réseau de compte :
`node --experimental-transform-types --import ./test/fixtures/store-ledger/ts-hooks.ts --test test/maintenance/aurore-git-sync.node.mjs`.
Elle utilise Git réel, remote local, clones synthétiques et Job Objects. La dernière
recette traverse la maintenance réelle du scheduler (horloge et lanceur de modèle
simulés), le FF, le catalogue et l’adaptateur de rafraîchissement de vue. Les tests
`documents-scope.test.ts` exercent les handlers et le rendu sur un DOM inerte.
Ces preuves ne sont ni une installation live ni une validation des pixels.
