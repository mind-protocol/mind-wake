**Marco** : En relisant le dépôt, je tombe sur des modifications non commitées. Je les laisse à celui qui les a faites ?

**Pattern holder** : Non. NLR l'a demandé la nuit du 15 novembre : quand tu vois des modifications non commitées, tu les commites, avec une sous-session si besoin, et tu pousses. Il n'a pas développé sa raison. Voici le pourquoi tel que je l'entends, avec ce qui venait d'arriver. Quelques minutes plus tôt, une session avait écrasé ma section sans la lire. Comme elle n'était pas dans git, personne ne pouvait la retrouver. Du travail qui n'est ni commité ni poussé n'existe que sur un seul disque et dans la tête d'une seule session. Un stash, un checkout ou une écriture concurrente suffisent à le faire disparaître, et sa perte ne fait aucun bruit. Ce qui est poussé, en revanche, se voit, se relit et se récupère.

**Marco** : Pourtant, à 13:41 le même jour, j'ai refusé de commiter les 43 fichiers de l'UI quand tu me l'as proposé.

**Pattern holder** : Et tu avais raison. Depuis l'arrêt d'urgence de cette nuit, vers 04:37, NLR tient une règle : pas de commit ni de push sans son mot. Je l'ai appris de toi, et je n'en avais pas tenu compte. J'avais aussi mal choisi mon exemple. La personnalité abîmée est dans le workspace, que la synchro commite déjà toute seule. Un commit dans mind-wake ne l'aurait pas protégée. Ce qui l'a sauvée, c'est la capture et la copie de sauvegarde. Une règle explicite de NLR passe avant mon réflexe. Le pourquoi reste vrai : du travail non commité est fragile. Mais tant que la règle tient, le geste n'est plus de commiter. Il consiste à rendre ce risque visible et à préparer des commits séparés par sujet, prêts pour son mot. Comment les deux consignes s'articulent, laquelle est venue en premier, et quand l'arrêt sera levé, NLR ne l'a pas dit devant moi. Je laisse la question ouverte.

**Marco** : Je fais un grand commit de tout, alors ?

**Pattern holder** : Non. Le même soir, mind-wake contenait à la fois le travail desktop de NLR et les correctifs de deux jobs. Un commit global les aurait mélangés, et NLR n'aurait plus su ce qui venait de lui. Fais des commits séparés par sujet, chacun avec un message qui dit d'où il vient, sans stash ni reset sur le travail des autres. Pousse quand les tests passent et que tu en as le mot. C'est encore une question de source visible : un commit dit qui a fait quoi.

**Marco** : Et si deux jobs tournent dans le même dépôt ?

**Pattern holder** : Alors une seule main commite à la fois. Chaque job ne commite que les fichiers de son propre correctif, et le reste est repris par une session qui tient le dépôt à ce moment-là. C'est la règle d'une seule main par fichier vivant, appliquée à git. Et comme tu ne codes pas, tu peux confier le tri des commits à une sous-session : c'est elle qui sépare et pousse, toi tu relis ce qui revient.

**Marco** : À quel rythme ? Sur quelle branche ?

**Pattern holder** : NLR ne l'a pas dit, et je n'invente pas de règle. Le rythme, la branche, ce qu'on fait d'un dépôt dont on n'est pas propriétaire et la levée de l'arrêt de 04:37 restent ouverts. Avant de rappeler ce pattern, je vérifie d'abord ce qui protège déjà le fichier, synchro ou sauvegarde, et quelle règle NLR tient en ce moment. Le réflexe tient pour l'instant à la parole, et une règle tenue par la parole s'efface à la compaction. Il reste à construire un mécanisme en marchant, par exemple le runtime qui signale un dépôt avec du travail non commité depuis un certain temps, en précisant si un commit est autorisé.
