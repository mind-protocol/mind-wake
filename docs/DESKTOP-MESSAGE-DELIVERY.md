# Messages desktop vers Claude

## Libérer une attente sans tuer le travail

En mode hôte autorisé, l’adapter observe les événements natifs `task_started`, `task_updated` (champ `patch`), `task_notification` et les snapshots `background_tasks_changed`. Si un message attend et qu’une tâche est au premier plan, il envoie une `control_request` de type `background_tasks` (équivalent natif de Ctrl+B), pour libérer ensemble les tâches de premier plan. Cela évite de rester bloqué sur le deuxième sous-agent après avoir libéré le premier. La réussite exige soit `response.backgrounded === true`, soit un événement natif confirmant la mise en arrière-plan ; un simple accusé `success` sans cette observation ne suffit pas. Le retour d’outil libéré permet au hook PostToolUse de transmettre le message. Aucun appel modèle de routage n’est ajouté.

Tant qu’une tâche native reste en cours, la fin du tour principal ne ferme plus le CLI ni son Job Object. Entre deux tours, un nouveau message est transmis à l’entrée stream-json du même runtime. Les fins de tâches reviennent par les notifications natives. L’usage cumulé du processus est converti en deltas à chaque résultat, puis rapproché sur le total final.

L'envoi direct réserve les identifiants dans SQLite sans les déclarer reçus. Le hook ignore ces réservations, évitant une double livraison. Le CLI est lancé avec `--replay-user-messages` et reçoit un UUID de transport : seul son écho natif correspondant confirme les réservations et expose les ✓✓. Une écriture échouée, une mort du processus ou une reprise libère les réservations non confirmées pour réessai. La fin d'une réponse ne ferme pas le runtime si un message attend encore sa transmission ou son accusé.

Un runtime qui refuse de basculer une tâche en arrière-plan laisse cette tâche intacte et conserve le message ; il n’y a pas de fallback destructif prétendant préserver les descendants. Ce mécanisme concerne les tâches natives Claude (commandes et sous-agents), pas tous les appels MCP arbitraires. Les jobs appartenant au daemon restent indépendants ; pause et arrêt gardent leurs effets ordinaires.

Vérification réelle du 29 octobre : une commande Node de 20 secondes a été basculée par le CLI en arrière-plan ; le parent a répondu `PREEMPTION_OK` avant sa fin ; le fichier produit par la commande et une notification `completed` sont arrivés ensuite. Un test de l’adapter avec processus enfant vérifie aussi que la première réponse ne tue pas le worker et que deux résultats cumulatifs ne doublent pas l’usage.

Vérification de bout en bout du 29 octobre à 20:51 UTC : l'adapter réel Wake, son superviseur Windows et le hook ont lancé une commande Node de 45 secondes dans un espace jetable. Le premier message, reçu pendant la commande, a eu une réponse à 20:51:53 ; le second, arrivé entre deux tours, a été confirmé par écho du runtime et répondu à 20:51:56. Le worker a ensuite produit son résultat à 20:52:35. Un seul processus Claude a été lancé ; aucune commande n'a été tuée pour recevoir les messages. Le rapport est `outputs/message-session-continuity-proof.json` dans le dossier de cette conversation Codex.

Références officielles : [backgroundTasks et événements de tâches](https://code.claude.com/docs/en/agent-sdk/typescript#backgroundtasks), [entrée et sortie stream-json](https://code.claude.com/docs/en/cli-reference).

L'envoi du panneau enregistre le texte et sa clé d'idempotence dans le registre humain et une file locale SQLite, puis appelle le réveil existant. Agent endormi : le daemon démarre et `SessionStart` transmet les nouveaux messages. Agent actif : aucun second processus ; `PostToolUse` les transmet dans `hookSpecificOutput.additionalContext`. Un outil échoué utilise `PostToolUseFailure`. Un message arrivé juste avant la fin de réponse est traité par `Stop`, qui reprend le tour seulement si un nouveau message attend.

La file est persistante : si la session se termine avant un hook, le scheduler considère les messages encore en attente comme un motif de réveil. Les contrôles du moteur continuent à s'appliquer. Le bouton Envoyer garde la sémantique du bouton Réveil (il peut reprendre une pause explicite, jamais un arrêt d'urgence).

Les hooks sont configurés au lancement du runtime Claude sur hôte autorisé. Les chemins et l'identité de session proviennent du lanceur. La forme exec (`command` + `args`) évite de construire une commande shell avec du texte utilisateur. Les sous-agents et les autres sessions ne consomment pas la file. En mode natif, les capacités et réglages habituels du runtime sont conservés. En profil restreint sans hook, la note historique reste disponible ; cette injection ne constitue pas une intégration Codex.

Une transaction SQLite sérialise les hooks simultanés et mémorise les identifiants émis. Une répétition de l'envoi desktop ne réinjecte pas un message déjà émis. Cet accusé signifie « émis par le hook », pas « compris ou traité par le modèle ». Un arrêt brutal entre la transaction et la réception de stdout par Claude peut perdre l'injection ; le registre humain et la note conservent le message pour consultation. Les anciens messages antérieurs à cette fonctionnalité ne sont pas rejoués automatiquement.

La livraison par hook survient au prochain outil terminé. La libération native d’une tâche bloquante décrite plus haut permet ce retour sans attendre la fin du travail. Une génération sans tâche native en cours n’est pas interrompue par ce mécanisme. Les réglages des hooks sont chargés au lancement : un moteur déjà démarré doit être rechargé pour les utiliser.

Le flux structuré Claude permet aussi de reconnaître les appels d'outils en cours et leur retour, par identifiant. Un message non encore transmis affiche une explication lorsqu'un appel `Agent`/`Task` attend son résultat, ou lorsqu'un autre outil travaille. Les événements des sous-agents ne ferment pas les appels du parent. L'observation est rattachée à la session Wake effectivement ouverte ; un ancien appel après une interruption n'est pas affiché comme une attente actuelle. Une fois l'accusé reçu, l'explication disparaît. Seuls les noms/identifiants d'outils et leurs horaires sont conservés, sans arguments ni contenu des résultats.

L'explication précise le nom de l'outil, la durée écoulée et le nombre d'appels encore actifs lorsqu'il y en a plusieurs. En dehors de l'activité, elle indique la pause, l'arrêt, l'attente d'une jauge valide ou l'heure du prochain réveil déjà planifié. La durée affichée est une mesure écoulée, jamais une estimation de temps restant. L'état de contrôle actuel prévaut sur une ancienne observation d'outil et les messages déjà transmis ne portent plus ces indications d'attente.

Référence : https://code.claude.com/docs/en/hooks (PostToolUse, SessionStart, Stop, forme exec).

## Vérification réelle du 29 octobre 2026

Sur le profil local `mind-wake-essai`, le message technique `hook-live-check-20261029-1759` a été émis par SessionStart à 17:59:41 UTC ; l'agent a répondu « Injection desktop reçue ». Le message `hook-live-active-20261029-1800`, envoyé à 17:59:56 pendant cette même session, figure à 18:00:06 dans la requête modèle comme `PostToolUse:Bash hook additional context`. L'agent a confirmé via `message_owner` à 18:00:10 : « Injection PostToolUse reçue ». Aucun redémarrage n'a séparé les deux réceptions. Les envois d'essai utilisaient la même commande `reply` que le bridge desktop ; le clic natif du formulaire n'a pas été rejoué pour cette vérification.

Build TypeScript, UI et exécutable Tauri réussis. 41 tests ciblés passent (file/hook, messages CLI, adapter Claude et enregistrement dans le daemon).
