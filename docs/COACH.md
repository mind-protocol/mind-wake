# Le coach de Wake

Le coach accompagne le principal : élargir ses ambitions, apporter des possibilités inattendues et laisser la conversation transformer ses idées. Son prompt durable est dans `prompts/coach/system.md`, issu du skill personnel `coacher-des-agents`. Le prompt de reprise ne porte que la date, le wake qui commence et les nouveaux échanges à examiner.

Le daemon offre une occasion de coaching au démarrage de chaque wake principal. Le coach lit les messages utilisateur et assistant du dernier tour Codex terminé via `thread/read`. Un tour encore actif et les éléments de raisonnement ne sont pas transmis. Cela couvre les messages du runtime, y compris ceux qui n'ont pas été publiés dans le chat humain. Cela ne constitue pas une lecture exhaustive des outils, des sous-fils ou des fichiers de travail ; le coach peut consulter les sources pertinentes dans ses accès existants.

Son propre fil Codex est créé séparément, puis repris. Le MCP `mind_wake_coach` lui fournit trois outils : `get_coaching_objectives`, `set_coached_objective` et `send_coaching_instruction`. Il peut reformuler ou changer un objectif en cours ou à venir et son résultat attendu, puis donner des instructions au principal pendant son intervention. Chaque modification d'objectif est persistée dans le plan canonique avec son motif, puis immédiatement notifiée. Le numéro du wake, le projet et la révision lue doivent correspondre ; une révision périmée est refusée. Un passage importé est modifié séparément ; un ancien projet sans passages partage son plan de dix étapes entre ses retours.

Les outils envoient leurs interventions sans attendre la fin du tour, dans `owner-inbox.sqlite` avec une provenance de pair `wake-coach`. Le résultat final peut compléter ces interventions ou rester silencieux (`COACH_NO_MESSAGE`). Le fil apparaît dans la conversation « Coach » du système existant. Ses instructions sont attribuées au coach et restent subordonnées aux décisions humaines et aux contrôles de Wake. Les réponses du principal sont retrouvées dans les échanges examinés au wake suivant. Une session MCP est révoquée à la fin de chaque intervention ; Pause, Off et Force-off refusent aussi ses mutations.

Une seule exécution du coach est active à la fois. Son identifiant de fil et la dernière source traitée sont conservés dans `coach-state.json`. Un nouveau wake pendant une intervention n'en crée pas une seconde ; une occasion ultérieure reprend la lecture. Aucune boucle de réveils n'est déclenchée par le coach lui-même. Un refus de quota suspend ses tentatives jusqu'au délai du runtime ou, à défaut, quinze minutes. Un arrêt de processus non confirmé bloque le worker jusqu'au redémarrage du daemon.

## Commandes

L'onglet **Coach**, à côté de **Toi et ton agent**, affiche son fil et permet de lui écrire directement. Le daemon traite les messages humains sans attendre un nouveau wake principal, tant que le coach est activé et les contrôles Wake le permettent. Sa réponse reste dans cet onglet ; les outils de coaching servent à envoyer séparément une intervention au principal. Pause et Force-off gardent les messages en attente. Les brouillons restent présents lorsqu'on change d'onglet.

```powershell
node dist/cli/main.js coach on --data-dir CHEMIN
node dist/cli/main.js coach status --data-dir CHEMIN --json
node dist/cli/main.js coach off --data-dir CHEMIN
# coach send lit un message sur l'entrée standard.
```

Le choix est propre à l'installation (`coach.json`), désactivé en l'absence de configuration. Il n'active ni le profil ni les permissions natives. Cette première intégration utilise le profil principal **Codex natif sur hôte déjà consenti**, son modèle et le lanceur supervisé existant. Elle n'est pas active pour Claude ou un profil isolé. Pause, Off, Force-off, retrait de permission ou arrêt du daemon interrompent le coach ; une réponse achevée après un arrêt n'est pas expédiée.

Les changements de code nécessitent un build et le rechargement du daemon ; activer seulement le fichier ne recharge pas un ancien processus. La présence de l'identifiant dans `coach-state.json` prouve l'ouverture du fil, son état `completed` la fin d'un tour, et les reçus de la messagerie la livraison. L'utilité du coaching reste à apprécier sur les interventions et les choix réels du principal.
