# Gestionnaire de réveils par projet

Le gestionnaire répartit les sessions principales entre les projets du registre
`artifacts/projets-compteur.json` de l'espace actif. Il complète le scheduler :
il choisit le projet et la place dans son bloc, sans modifier les horaires,
Always-on, le quota fournisseur, Pause ou Force-off.

## Rotation

- Une journée logique contient 50 réveils ; ce n'est ni une journée calendaire
  ni une limite de consommation.
- Un bloc contient 10 réveils sur un projet. Le premier retrouve le contexte,
  examine le plan et prépare les neuf suivants. Il compte parmi les dix.
- Les projets disponibles reçoivent chacun dix réveils par tour. La rotation
  continue entre les journées : avec onze projets, les six derniers ne sont
  pas oubliés au début du lendemain.
- Le premier bloc commence par le projet courant s'il est disponible. Les
  nouveaux projets sont intégrés lors de la prochaine lecture du registre.
- Les statuts contenant pause/arrêt, attend/bloqué ou terminé/archivé sont
  respectivement exclus comme pause, blocage ou archive. L'historique reste
  conservé. Une pause ou l'arrivée d'un projet peut interrompre l'égalité
  instantanée ; le choix du prochain bloc privilégie le moins servi.
- Si tous les projets sont indisponibles, le réveil laisse place à une
  exploration libre, sans lever leurs restrictions.

Un réveil est réservé à la composition du prompt et compté une seule fois à la
fin d'une session effectivement démarrée. Une réservation dont le lancement
échoue avant le signal de démarrage ne consomme rien. Sous-sessions et tours
de rappel ne créent aucun créneau supplémentaire. Une session interrompue après
son démarrage compte ; sa trace permet la reprise. Les compteurs commencent à
l'activation du gestionnaire, indépendamment des anciens champs `spent`.

## Passage de relais

Les règles fixes sont dans le contexte système. Le message de réveil contient
les données courantes : journée, position, projet, phase, intention de l'étape
et chemins de reprise. Le registre courant est mis à jour avant la lecture des
autres mécanismes existants de planification.

Au premier réveil du bloc, l'agent utilise `get_wake_project`, retrouve les
sources et les questions, revoit les informations périmées et les améliorations,
puis écrit son plan de dix intentions avec `plan_wake_block`. Les demandes
humaines priment et ce plan reste modifiable.

La procédure est portée par le skill [planifier-wakes](../prompts/wake/planning/SKILL.md).
Son contenu est ajouté aux instructions du lancement en début de bloc, si le plan
est absent/incomplet, si l’intention du créneau manque ou si un changement de projet
reprend une trace marquée `needsReview`. Le début de bloc constitue le rappel
périodique ; aucune cadence supplémentaire n’est ajoutée. Un wake de travail déjà
planifié reçoit seulement l’affectation, son intention et un court pointeur vers
le skill. L’agent peut aussi le consulter à la demande si une correction humaine
rend son plan périmé. La procédure n’est pas recopiée dans chaque message.

Ce chargement conditionnel concerne les nouvelles instructions transmises : il
ne supprime pas le skill déjà lu dans l’historique d’un fil persistant. Une
compaction ou un nouveau contexte est nécessaire pour en retirer cette trace.

L'agent sauvegarde résumé, prochaines actions, questions et sources avec
`save_wake_context`, particulièrement avant de terminer le dixième réveil.
Le daemon conserve automatiquement une référence de session, son issue et les
preuves de consommation disponibles. Ce secours ne résume pas la pensée de
l'agent : `handoff.needsReview: true` signale l'absence de résumé associé à cette
session. Le prochain passage doit alors relire les sources ; le système ne
présente pas une trace brute comme un contexte vérifié.

## Outils MCP

| Outil                                                 | Usage                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `get_next_wakes(count)`                               | Aperçu de 1 à 500 réveils, sans les consommer ; inclut la réservation en cours. |
| `configure_wake_rotation(enabled)`                    | Active ou suspend la rotation en conservant son historique.                     |
| `get_wake_project(project_id)`                        | Retrouve contexte, sources, questions, plan, registre et trace de session.      |
| `save_wake_context(...)`                              | Sauvegarde le résumé et ses sources ; conserve l'identifiant de session MCP.    |
| `plan_wake_block(project_id, steps)`                  | Sauvegarde exactement les intentions numérotées de 1 à 10.                      |
| `set_wake_project_status(project_id, status, reason)` | Pause, bloque ou reprend explicitement un projet avec une raison.               |

Ces appels n'accordent aucun accès et ne lancent aucun modèle. Les mutations
refusent Pause, arrêt et Force-off. Une consultation reste possible pendant la
pause. Désactiver la rotation ne désactive pas Wake.

## Persistance et diagnostic

Les allocations explicites et les retours distincts sur un projet suivent le
contrat [Passages futurs](WAKE-PASSAGES.md) : validation sans écriture, import
révisionné, intentions par passage et conservation des identités lors du tri.

Le fil « Messages » affiche une entrée « Objectif en cours » pour la session
principale effectivement démarrée : numéro du wake, projet, étape du bloc,
intention et résultat attendu. Cette vue relit le plan courant et suit ses
révisions. Sans plan, elle indique la préparation ou l'absence d'intention ;
elle disparaît à la fin du wake. Elle ne représente pas un résultat accompli.
La lecture ne réserve ni ne consomme de wake et ne déclenche pas de notification.
Chaque projet est repéré par une couleur dérivée de son identifiant et un badge
portant son initiale, communs à l'objectif, aux prochains wakes du fil et à la
grille de prévision. La grille comporte une légende avec les noms complets.
Un objectif absent ou vide porte le statut « ? À définir » dans le fil et le
détail du wake ; sa carte indique le nombre d'objectifs restant à définir.
Ce statut disparaît dès qu'une intention est renseignée dans le plan.
La prévision regroupe les wakes consécutifs d'un même bloc dans une carte : nom
complet du projet, initiale, couleur, nombre de réveils et plage de numéros. Les
objectifs se consultent dans le détail dépliable.

Les cartes des blocs complets à venir sont déplaçables par glisser-déposer ou
avec les flèches. `wake-order` enregistre leur ordre dans SQLite ; les lectures
de prévision et les réservations du daemon utilisent la même file. Le bloc déjà
réservé ou commencé reste à sa place, ainsi que les fragments de blocs. L'ordre
doit conserver les mêmes blocs complets que la prévision de 500 wakes ; une
révision périmée est refusée. Pause et arrêt interdisent cette mutation. Une fois
la file consommée, la rotation reprend selon les compteurs réels des projets.
Le paramètre `dragDropEnabled: false` du panneau laisse le glisser-déposer HTML
fonctionner sous Windows ([configuration Tauri](https://v2.tauri.app/reference/config/#windowconfig)).

- `artifacts/wake-manager.sqlite` : état transactionnel, réservations par
  identifiant de session et journal des changements (`rotation_events`).
- `artifacts/wake-manager/<empreinte du projet>/context.json` : copie lisible
  du contexte, plan et dernier passage de relais ; SQLite fait autorité.
- Le journal normal de Wake conserve les événements de la session référencée.

Les réservations sont idempotentes et une seconde session principale est refusée
tant que la précédente n'est pas finalisée. Après redémarrage, le daemon
réconcilie l'ancienne réservation avec l'issue conservée dans sa base de contrôle.

## Vérifications

Les tests unitaires couvrent 500 créneaux, onze projets, les limites de journées,
les pauses/blocages, les reprises et l'absence de double comptage. Un test du
daemon lance onze processus avec l'adapter factice et vérifie le changement
effectif du prompt A → B après dix sessions. Un test MCP stdio exerce les six
outils et le refus de mutation sous Pause. Ces essais n'utilisent aucun modèle
et ne prouvent pas que l'agent écrira spontanément un bon résumé ou un bon plan.
