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

Chaque fork conserve sa propre file d’intentions dans `fork-planning.sqlite`.
L’entrelacement de la rotation ne sert qu’à amorcer cette file une fois. Le
worker ne recalcule plus les choix du fork à chaque tour. Les entrées sont des
projets actifs, un objectif et un résultat attendu ; la raison de réassignation
et la révision sont conservées et affichées dans le fil.

Le runtime ajoute un serveur MCP stdio `mind_fork_planner`, lié à l’identité et
à une session active du fork, sans remplacer les serveurs personnels :

- `get_my_wakes()` : wake courant, révision, file future et projets disponibles ;
- `reassign_my_wakes(expected_revision, reason, wakes)` : remplace uniquement la
  file future, éventuellement par une file vide ;
- `claim_project(project_id, objective, expected, reason, expected_revision)` :
  réserve le projet pour le prochain wake et conserve la suite de la file.

Aucun argument ne permet de choisir un autre fork. Une ancienne session, une
révision périmée ou une réservation concurrente est refusée. Off, Pause et
Force-off refusent les mutations ; ils ne sont jamais levés par ces outils.
Le mode hôte donne toujours les accès natifs déjà consentis : cette portée MCP
n’est pas une isolation du système de fichiers.

Une réassignation ne change pas le wake déjà lancé. À sa fin, le worker prend
la nouvelle première intention, y compris si son projet n’était pas dans la
répartition initiale. Il n’est pas obligé de terminer dix tours avant de changer.
Une file vide ou un premier projet occupé ouvre un tour de préparation libre :
l’agent peut choisir d’autres projets avec ses outils, sans consommer l’intention
bloquée. La reprise après crash remet l’intention interrompue dans la file.

Les prochains projets choisis sont réservés transactionnellement entre forks.
Pour l’exécution, principal, Claude et forks utilisent en plus les mêmes verrous
de projet SQLite, détenus pendant le tour et libérés après sa terminaison.
Le principal garde sa priorité : sa réservation fait céder le fork, et son
lancement attend la libération réelle du projet. Un ancien worker Claude déjà
lancé est reconnu par son verrou et son tour actif jusqu’à sa prochaine relance.
Les compteurs et le planning du principal ne sont pas modifiés par les forks.

Une terminaison d’arborescence non confirmée laisse un fichier
`project-leases/<empreinte>.uncertain.json` : ce projet n’est pas réattribué.
Il faut d’abord vérifier l’arrêt réel des processus avant de retirer ce constat.
Les agents partagent toujours les mêmes fichiers ; réserver un projet ne constitue
pas une isolation de leurs accès natifs.

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
dossier de données, ainsi que `fork-planning.sqlite` (files et réservations futures) et `project-leases/` (exécution). Le second fil Claude conserve sa propre rotation.

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
