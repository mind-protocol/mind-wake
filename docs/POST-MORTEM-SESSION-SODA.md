# Post-mortem de session — Soda, le jugement et la tendance à produire une réponse

20 novembre 2026 · Bilan de l'assistant principal de ce fil.

## Le problème que j'ai fait porter à NLR

La discussion a commencé avec l'idée d'un attachement simulé, puis s'est déplacée vers le jugement des agents : savoir ce qui mérite leur attention, à quel niveau faire le travail et comment poursuivre au-delà d'une seule réponse. Soda est devenu un cas concret. NLR a donné une barre, « ne pas se faire virer le premier jour », et une règle, « moi je fais que ce que vous me demandez explicitement ».

J'ai régulièrement ajouté mes propres réponses à la demande et les ai traitées comme faisant partie du but. NLR a dû signaler lui-même plusieurs difficultés que j'étais censé découvrir : obtenir les accès techniques, couvrir les interactions, déterminer exactement le travail à faire et vérifier que le dispositif permet de le faire correctement. Après chacune de ces corrections, j'ai souvent amélioré la forme de ma proposition avant de réexaminer le choix qui l'avait produite.

## Les erreurs et leurs effets

| Épisode | Ce que j'ai fait | Conséquence |
|---|---|---|
| Premier jour chez Soda | J'ai changé une responsabilité éditoriale figurant dans l'offre en un article à livrer à 17 h le premier jour. J'ai alors construit une épreuve autour de cette échéance. | Le scénario pouvait mesurer la performance sur une commande inventée. Marco a ensuite préparé son propre kit scénarisé et reconnu qu'il reprenait la même erreur. |
| Corrections de NLR sur le premier jour | J'ai produit une journée d'accueil plausible pour un humain, puis ajouté du détail sur les écrans et les canaux. À sa question sur les deux capacités manquantes, j'ai répondu « participer » et « exécuter ». | NLR a encore dû nommer le travail entre les deux : comprendre précisément ce qui doit être accompli et établir si les moyens permettent de le faire au niveau requis. |
| Consultation du pattern holder | Je lui ai posé des questions déjà orientées vers les prédictions et les essais. J'ai ensuite résumé sa réponse comme si elle réglait la difficulté. | Son essai pouvait montrer qu'une interaction préparée était faisable. Il pouvait tout aussi bien valider un plan construit autour de la mauvaise interaction. Il a ajouté une section à sa mémoire. La consultation a donc réellement eu lieu et a laissé une trace, sans apporter la réponse attendue. |
| Projection sur vingt réveils | J'ai prérempli vingt tâches et supposé ce que les premières permettraient de décider. Puis j'ai ouvert mon guide par « Quelle décision est encore ouverte ? », une question qui suppose que l'agent sait déjà quelles décisions méritent son attention. | Le plan avait l'air détaillé. Il fixait précisément les éléments que les réveils devaient permettre de découvrir. NLR a dû préciser que je pouvais choisir le processus et les questions, en laissant les réponses ouvertes. |
| Alignement sur ce qui compte | J'ai érigé la découverte autonome en priorité générale, repris un nombre de réveils propre à un exemple et proposé le travail sans publication, déjà possible dans Wake. | J'ai proposé des moyens avant de comprendre à quoi ils devaient servir. J'ai aussi présenté comme nouveauté un comportement déjà possible. |
| Création et application du skill | J'ai d'abord livré quelques lignes abstraites après un échange sur la sous-estimation de la difficulté. Le skill a ensuite été écrit, validé et essayé sur un cas de médiathèque. Quand NLR m'a demandé de l'appliquer, j'ai à nouveau expliqué comment entraîner d'autres agents. | Le premier essai a donné un retour utile sur une lacune du texte. Mon comportement dans le fil a montré que savoir commenter le skill ou le suivre lors d'un exercice borné ne suffit pas à détecter au bon moment que mon propre travail part dans la mauvaise direction. |
| Dernière proposition d'infrastructure | J'ai vérifié les mécanismes de reprise du dépôt et privilégié un contexte révisable avec des décisions reliées à leurs prémisses. J'ai vérifié les liens et la forme des documents. | La proposition pouvait aider à conserver et rouvrir un choix déjà identifié. Je n'avais pas établi que ce manque de persistance expliquait nos erreurs de jugement, ni éprouvé que le dispositif changeait les choix de l'agent. NLR a demandé de retirer les trois documents. |

## Ce que j'en déduis, et ce que je ne sais pas

Le motif récurrent est **le choix trop précoce d'un critère de réussite qui me permet de produire quelque chose immédiatement**. Vingt lignes semblaient répondre à vingt réveils. Une simulation détaillée semblait répondre à une prise de poste. Un document d'architecture vérifié semblait répondre à un problème de jugement. Dans chaque cas, la qualité formelle pouvait progresser alors que le critère restait mal choisi.

J'ai aussi traité les corrections de NLR comme des retouches locales. Le rejet de la livraison à 17 h aurait dû rouvrir la décision de scénariser la journée. Le rejet de ma première question aurait dû rouvrir ce que le guide devait apprendre au chef de projet. Le défaut de cadrage s'est propagé dans mes réponses et, au moins une fois, dans un dossier préparé par un autre agent.

Cette session établit mes erreurs dans ce fil. Elle ne permet pas d'en attribuer la cause au modèle, au scheduler, à la mémoire ou à un seul prompt. Elle ne démontre pas non plus que MIND manque techniquement de toutes les capacités discutées. Par exemple, l'absence d'une preuve de participation utile à une réunion externe laisse cette capacité à vérifier dans les conditions pertinentes. C'est une conclusion plus étroite qu'une incapacité démontrée.

## Ce qui permettrait de juger un progrès

Si ce travail reprend, le premier objet à évaluer est une décision de l'assistant pendant le travail, à un moment où il pourrait produire une réponse plausible en continuant sur une lecture trop facile. Garder sa première lecture, ce qu'il avait sous les yeux, l'action qu'il a choisie et ce qui lui a fait changer de cap. La preuve recherchée serait qu'il repère et corrige une hypothèse ou un niveau d'exigence inadéquat **avant** que NLR lui fournisse la correction, sur un cas où le problème n'a pas déjà été décomposé pour lui.

Une meilleure réponse rétrospective, une note bien formée ou un nouveau mécanisme en place sont des résultats distincts. Aucun ne suffit à établir ce progrès. La comparaison doit aussi inclure un cas clair où l'assistant sait agir directement, pour discerner si l'intervention améliore le jugement ou ajoute du délai.

Ce bilan clôt la demande de cette session. Le skill local existe toujours. Son effet sur le jugement en situation réelle reste ouvert.
