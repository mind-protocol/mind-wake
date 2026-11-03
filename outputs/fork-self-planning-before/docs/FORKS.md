# Forks Codex

La vue d’ensemble propose sept interrupteurs indépendants, Off par défaut :
le fil principal et les forks 2 à 8 font au maximum huit agents Codex.
Chaque fork possède un onglet, une boîte de réception, une transcription et un
identifiant de fil Codex persistants. Off arrête son travail et conserve ces données.
Les messages humains attendent son prochain tour, sans activer un fork éteint.
Chaque fork affiche son icône numérotée et colorée, son état « Travaille » et
son indicateur « Nouveau message » dans l’onglet et la vue d’ensemble. Le
compteur ne concerne que ses réponses d’agent et s’efface quand son fil est
visible, au premier plan et lu jusqu’en bas. La position de lecture est
conservée localement, séparément pour chaque fork.

Les commentaires publics, appels d’outils et activités des sous-sessions du fork apparaissent dans son fil pendant le travail, depuis son journal Codex. L’historique hérité et les fils voisins sont exclus ; ces activités ne déclenchent pas le badge de nouveau message.

## Répartition des projets

Les projets actifs, dans l’ordre de la rotation Wake, sont répartis entre les
forks activés par entrelacement. Le projet réservé ou courant du fil principal
est exclu. Chaque fork poursuit des blocs de dix tours sur les projets qui lui
reviennent. Sans projet disponible, il reste en attente. Activer ou désactiver
un fork recalcule les parts ; le worker interrompt les tours dont l’attribution
change et attend leur terminaison avant de réattribuer leur projet.

Le planning et les compteurs du fil principal restent gérés par WakeManager.
Les tours des forks sont enregistrés séparément : ils ne consomment pas les
réservations du planning principal. Si le fil principal entre sur un projet
occupé, le fork est interrompu au prochain contrôle (500 ms). Les agents
partagent les mêmes fichiers ; cette répartition ne constitue pas une isolation
des écritures, notamment pendant cette transition.

## Runtime et contrôles

`mind-wake forks run` supervise les sept boucles sous un verrou unique
`forks.lock`. Le desktop lance ce worker après On et vérifie sa présence au
plus une fois par minute. Fermer le panneau ne termine pas le worker.
Les forks exigent un profil Codex natif actif et le consentement hôte déjà
consigné dans la policy. Ils utilisent le modèle configuré dans la policy.
La configuration personnelle Codex est conservée, avec les outils natifs.

Au premier tour, `thread/fork` crée un fil à partir du principal si son
identifiant est disponible dans `codex-threads`; sinon `thread/start` crée un
fil neuf. Ensuite `thread/resume` reprend uniquement le fil du fork.
Les instructions communes et personnelles sont relues à chaque tour.
Une reprise refusée reste une erreur visible : aucun historique n’est effacé.
Le transport suit le [protocole officiel Codex App Server](https://learn.chatgpt.com/docs/app-server).

Chaque processus app-server et ses descendants vivent dans un Windows Job
Object. Pause interrompt les tours et garde le worker en attente ; Force-off,
retrait du consentement ou arrêt du profil terminent ses boucles. Le contrôle
est relu toutes les 500 ms pendant un tour. Le worker attend la terminaison
des arborescences avant de libérer leurs projets. Une limite fournisseur
suspend tous les forks ; en l’absence d’heure officielle exploitable, le
prochain essai attend quinze minutes. Cette attente survit au redémarrage du
worker. Aucun changement de compte, de fournisseur ou d’API n’est effectué.

Stockages : `forks/<id>/enabled.json`, `forks/<id>/second-thread.sqlite`
(schéma de transcription réutilisé), `forks-quota.json` et `forks.log` dans le
dossier de données. Le second fil Claude existant reste indépendant.

Commandes CLI : `forks status|on|off|send|run --json`. On, Off et Send lisent
sur stdin un objet JSON `{ "id": 2, "text": "…" }` (`text` pour Send).
La commande Tauri `wake_forks` n’est accordée qu’à la fenêtre principale.

## Vérification

Les tests couvrent toutes les combinaisons d’interrupteurs, les sept boucles
concurrentes, la séparation des messages, la reprise des fils, l’interruption
en cours de tour, les limites fournisseur et une boucle IPC réelle avec un
faux Codex dans un Windows Job Object. Ils n’appellent aucun modèle.
Une utilisation avec de vrais agents et une revue visuelle dans le desktop
restent à observer avant de déclarer le parcours complet validé.
