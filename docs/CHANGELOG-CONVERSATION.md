# Journal de développement — conversation spécialisée

Date : 31 octobre 2026. Ce document conserve les décisions, les changements de code et les problèmes rencontrés pendant la construction du nouveau parcours. Les composants ont été travaillés en parallèle ; l’ordre ci-dessous suit les décisions et leurs corrections, sans inventer d’horaires ni un ordre exact entre modifications concurrentes.

Ce journal de développement est distinct du journal d’exécution : celui-ci enregistre les messages, appels, révisions, événements et changements réellement produits par une conversation dans le stockage Wake. Une entrée ici ne prouve pas qu’un modèle réel a exécuté le nouveau parcours ou que le panneau Windows a été livré.

## 1. Intention précisée avant le code

Le point de départ est le remplacement du parcours autonome par une coopération déclenchée par les messages humains : Pattern, Contexte, Lead, Work et Commentary. Les spécialistes construisent des référentiels vivants et le fil Lead devient la conversation principale, révisable.

La première formulation technique envisageait encore des fils fournisseurs persistants par rôle. La correction humaine a fixé un choix plus fort : **reconstruire les messages manuellement à chaque appel, sans continuation native**. Le plan a été modifié en conséquence : chaque appel part à neuf, la continuité appartient aux données Wake.

La conversation réécrite est devenue la version canonique utilisée par les appels suivants. Les éditions humaines exigent des révisions explicites pour qu’un résultat tardif ne remplace pas une demande ou une réponse déjà modifiée.

Référence : [plan d’implémentation](PLAN-PATTERN-CONVERSATION.md).

## 2. Socle versionné et reconstruction des messages

Les contrats et le stockage ont été ajoutés dans `src/conversation/` : conversations logiques, messages et versions, appels corrélés à leur révision, contributions de référentiel, conversations canoniques et événements. Les mises à jour importantes sont transactionnelles et les conflits de version sont explicites.

Le constructeur de messages assemble la conversation du rôle, les contributions pertinentes et le contexte courant. Les contenus trouvés ou produits par un spécialiste gardent leur provenance ; ils ne deviennent pas de nouvelles permissions.

Le stockage conserve les entrées réellement transmises à un appel, son résultat public et sa consommation lorsqu’elle est mesurée. Un résultat devenu ancien reste inspectable sans être publié comme réponse de la nouvelle révision.

Sources : [contrats](../src/conversation/contracts.ts), [stockage](../src/conversation/store.ts), [reconstruction](../src/conversation/messages.ts).

## 3. Sorties publiques complètes et appels neufs

La lecture des adapters a révélé un prérequis : l’ancien contrat transportait surtout des résumés d’activité. Codex réduisait notamment les messages à un résumé de 200 caractères. Cela ne pouvait pas servir de contenu aux autres rôles.

Des événements publics complets et des deltas ont été ajoutés, séparés du raisonnement privé, des arguments et des résultats d’outils. Leur émission est activée pour le nouveau parcours, afin de préserver le comportement par défaut des autres usages des adapters.

La fabrique du runtime conversationnel crée un adapter et un stockage de continuité mémoire neufs pour chaque appel. Elle ne passe pas par les registrations qui ajoutent l’actuel `PERSONALITY.md` et la reprise documentaire entière. Les capacités normales des clients officiels restent chargées selon le profil autorisé.

Les contrôles relisent Pause, Force-off, le marqueur d’arrêt de secours, la policy et le quota fournisseur. Une interruption termine les processus appartenant à l’appel, y compris ceux de lecture de quota. Les profils qui demandent une isolation que ce raccord hôte ne fournit pas sont refusés explicitement.

Sources : [runtime de rôle](../src/conversation/role-runtime.ts), [contrat d’adapter](../src/contracts/adapter.ts), [Codex](../src/adapters/codex/codex-adapter.ts), [Claude](../src/adapters/claude/claude-adapter.ts).

Vérification effectuée sur cette tranche : **116 tests réussis** sur les suites du runtime de rôle et des adapters Codex/Claude. Les transports rejouent des fixtures ; ce résultat ne constitue pas un essai de conversation avec un modèle réel. Le rapport local correspondant est `.local/role-runtime-test-report.json` et n’est pas une preuve versionnée du projet entier.

## 4. Coordinateur, parallèle et seconde passe

Le coordinateur lance Pattern et un début de réponse Lead. Contexte peut commencer depuis le premier texte public disponible du Lead. Le Lead reprend ensuite les apports disponibles ; Work reçoit les tâches techniques pertinentes et Commentary accompagne des événements observés.

La seconde passe produit une réécriture par rôle. Elle est enregistrée avec ses versions puis projetée dans les messages canoniques dont partiront les appels suivants. Les versions précédentes restent consultables. Les messages humains et leurs corrections doivent être conservés.

Le worker sert les révisions explicitement demandées. Attendre une nouvelle demande ne lance aucun modèle et une réécriture ne déclenche pas une nouvelle boucle de réveils autonomes.

Sources : [coordinateur](../src/conversation/coordinator.ts), [worker](../src/conversation/worker.ts), [réécriture](../src/conversation/rewrite.ts), [prompts des rôles](../prompts/conversation/).

## 5. Défauts détectés puis corrections ciblées

### Réutilisation d’une réponse construite sans le contexte retrouvé

La première sélection d’un appel déjà réussi utilisait essentiellement rôle, passe, révision et prompt. Après une reprise, une réponse Lead pouvait ainsi être retrouvée alors qu’un résultat Contexte auparavant absent était devenu disponible.

Une clé de dépendances a été ajoutée pour distinguer ces situations. Le scénario de régression vérifie qu’un Contexte retrouvé invalide la réponse Lead précédente, tout en évitant de répéter un travail technique déjà effectué. Cette correction mérite de rester surveillée lorsque de nouvelles sources de dépendances sont ajoutées.

Sources : [coordinateur](../src/conversation/coordinator.ts), scénario « a recovered Context result invalidates the earlier Lead answer without repeating completed Work » dans les [tests](../src/conversation/coordinator.test.ts).

### Propriété du worker : PID seul et fenêtre de création du fichier

La première vérification considérait qu’un PID vivant suffisait. Elle pouvait aussi confondre un fichier de propriétaire encore vide avec un propriétaire mort pendant un lancement concurrent.

La propriété passe maintenant par une adresse IPC propre à la conversation et au dossier de données. Le worker expose son PID et un jeton ; la vérification compare ces valeurs au registre. L’élection par l’écoute de l’adresse évite de s’appuyer sur le seul fichier de PID, qui est publié par renommage.

Source : [propriété du worker](../src/conversation/worker.ts).

### Commentary absent des échanges sans travail technique

La première branche appelait Commentary seulement autour de Work. Les recherches initiales et les conversations sans tâche technique pouvaient rester sans contribution de ce rôle.

La correction humaine suivante a précisé que Commentary doit éditer le message Lead plutôt que publier des messages séparés. Le début du Lead est donc matérialisé dans un slot stable dès le streaming ; Commentary y actualise un segment attribué, avec cible, version, CAS et journal avant/après. Le résultat de Pattern peut déclencher cette édition pendant la recherche de contexte. Une édition humaine ou un conflit incompatible bloque la publication. La qualité et la fréquence utiles restent à éprouver en usage.

Source : [coordinateur](../src/conversation/coordinator.ts).

### Échec Work insuffisamment transmis

L’attente de plusieurs tâches par `Promise.allSettled` permettait de continuer le cycle après un échec Work, mais cet échec devait aussi devenir une information explicite pour la conversation suivante.

Le coordinateur ajoute un événement `work_incomplete` et la reconstruction conserve les résultats et échecs d’exécution. Un scénario vérifie que l’échec reste une source explicite pour la réécriture Lead ; la fin du cycle ne doit pas être interprétée comme une réussite de ce travail.

Sources : [coordinateur](../src/conversation/coordinator.ts), [messages](../src/conversation/messages.ts), scénario « a failed Work result remains an explicit source for the Lead rewrite » dans les [tests](../src/conversation/coordinator.test.ts).

### Aperçu en cours et édition humaine

Le fil affiche un début de réponse public avant la publication finale. Cet aperçu doit appartenir à l’appel Lead et à la révision courante ; une sortie JSON de seconde passe ou un ancien appel ne doit pas devenir un nouvel aperçu.

La projection filtre ces événements et remplace les deltas par le texte complet lorsqu’il arrive. Le parcours d’édition protège le brouillon humain pendant le polling et pendant l’arrivée d’une réponse finale. Les conflits de version conservent le texte saisi.

Sources : [modèle du panneau](../desktop/ui/conversation-mode.ts), [tests d’aperçu et d’édition](../desktop/ui/conversation-mode.test.ts).

## 6. Raccord du panneau et sortie du scheduler autonome

Le raccord CLI, les commandes Tauri et le fil desktop utilisent désormais le parcours conversationnel. Le nouveau panneau Windows construit à 22:04:07 a été relancé et ses six onglets ont été vérifiés dans la vraie fenêtre. Le transfert de mode pose un marqueur qui bloque le retour implicite aux wakes autonomes, puis vérifie l’arrêt du propriétaire de l’ancien moteur. Le Force-off est conservé ; aucun de ces contrôles de livraison ne constitue un essai avec un modèle réel.

L’envoi et la lecture ne lèvent pas un arrêt humain. L’activation du nouveau parcours est une action humaine distincte ; les erreurs de transfert restent visibles.

Sources : [CLI](../src/conversation/cli.ts), [transfert de mode](../src/conversation/mode.ts), [panneau](../desktop/ui/main.ts). Ce journal n’atteste pas encore une recette Windows complète du nouveau parcours.

## 7. Règles réutilisables et premier hook

Le premier contrôle déterministe observe la taille du document personnel. Au-delà de **10 000 caractères**, il crée une contribution de consolidation pour Pattern, liée à la version du document, et fournit le skill associé. Le texte source est conservé.

Le skill demande de transporter une règle vers le mécanisme approprié — hook, limite, processus ou référence — puis de vérifier son effet avant d’archiver son ancien texte. La présence du signal ne prouve pas qu’une règle a déjà été migrée dans le profil réel.

Les consignes réutilisables doivent conserver leur portée, leur source, leur condition d’application et leur état. Une correction située dans un projet ne devient pas automatiquement une règle permanente pour tous les échanges.

Sources : [contrôle de consolidation](../src/conversation/messages.ts), [skill](../skills/conversation-consolidation/SKILL.md), [catalogue des patterns](CATALOGUE-PATTERNS-CONVERSATION.md).

## 8. Précision récente : sixième rôle Expertise

L’utilisateur a nommé **Expertise** pour compléter les cinq rôles initialement définis. Cette décision entre dans le chantier en cours. Son raccord doit être suivi dans les contrats, le prompt, les contributions au Lead, les référentiels, les secondes passes et l’inspection du panneau.

Le raccord d’Expertise est désormais présent dans le coordinateur, son fil, son référentiel et l’interface : seules les instructions avec une citation et une version valides d’un message humain sont acceptées, avec leur condition et leur portée. Une proposition de seconde passe ne remplace pas silencieusement cette règle sourcée. Les six rôles possèdent maintenant un prompt précis de réécriture ; la seconde passe ne recharge plus le schéma de sortie de la première. Ces comportements sont testés avec des fixtures ; leur qualité sur un échange modèle réel reste à observer.

## 9. Propriétaire global : dépassement des jobs imbriqués détecté en essai

La relecture a identifié que `maxProcesses` était posé par appel. Un propriétaire de coopération a été ajouté pour lancer le worker dans un Job Object parent, conserver son entrée de contrôle, relayer ses logs et terminer tout le groupe lors d’un arrêt ou d’une perte du propriétaire. Il ne redémarre pas automatiquement un worker terminé ou en échec.

Un essai Windows avec des processus Node jetables a ensuite montré qu’il fallait distinguer le plafond immédiat du job et le compte agrégé des jobs imbriqués. Même avec le sous-job sans plafond explicite, le compte parent a dépassé la limite de trois avant interruption. La documentation Microsoft distingue les limites héritées dans la chaîne des jobs des autres limites, et indique que les compteurs sont agrégés dans les parents : [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject).

Le raccord retenu pour cette tranche pose donc le plafond du job parent **et surveille le compte agrégé**, avec arrêt du groupe si ce compte dépasse la limite ou devient illisible pendant que le worker est encore vivant. Il s’agit d’une garde agrégée qui interrompt après constat, avec dépassement transitoire possible ; ce n’est pas une garantie de plafond noyau strict sur toute la hiérarchie.

Le résultat et les logs du propriétaire portent cette distinction : `immediateJobLimit`, `aggregateLimit`, `enforcement: observed_fail_closed`, `largestObserved` et `transientOvershootPossible`. Le test imbriqué a observé quatre processus pour la limite de trois, puis l’arrêt du groupe. Les tests distincts de Force-off et de fin sans relance automatique passent également : **six tests du propriétaire réussis**, sans aucun modèle réel.

Sources : [propriétaire](../src/conversation/owner.ts), [essais Windows et contrôles](../src/conversation/owner.test.ts). L’effet de la garde agrégée et son coût d’observation restent à mesurer sur une coopération réelle.

## Points encore ouverts à vérifier

- Tester le trajet réel avec le runtime autorisé, puis l’usage de la version réécrite au message suivant, sans continuation native.
- Terminer et vérifier le raccord d’Expertise sur tout ce trajet.
- Confronter les règles de réutilisation aux changements de sources et de référentiels, en plus du cas Contexte déjà couvert.
- Vérifier en charge l’annulation simultanée, le quota commun et la garde agrégée de processus. Un dépassement transitoire est explicitement possible avant son observation et l’arrêt global ; aucune garantie de plafond noyau strict de toute la hiérarchie n’est revendiquée.
- Observer la valeur de la seconde passe et de Commentary : meilleure compréhension et meilleures décisions, coût et bruit compris.
- Compléter la recette du panneau Windows et la preuve de remplacement du parcours réellement lancé. Aucun de ces points n’autorise à réactiver un profil humain en Force-off.
