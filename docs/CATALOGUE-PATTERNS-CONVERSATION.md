# Catalogue des patterns — valeur, problèmes et épreuves

Version de travail du 31 octobre 2026, issue du fil de conception et du [plan d’implémentation](PLAN-PATTERN-CONVERSATION.md).

**Chaque pattern est une hypothèse de valeur à éprouver séparément.** Les IDs sont stables : une révision conserve son ID ; un pattern abandonné reste référencé comme abandonné. Ce catalogue n’est pas un prompt à injecter intégralement. Pattern sélectionne les méthodes pertinentes pour la situation.

Les cinq rôles nommés sont recensés séparément. Le sixième annoncé reste à définir. Les méthodes de conception reprises du `skill.md` sont distinguées des choix d’architecture. Aucun des tests ci-dessous n’est présenté comme déjà exécuté.

## Comment évaluer la valeur

Pour chaque essai, conserver demande, sources disponibles, versions des prompts, modèle, entrées réellement transmises et résultats. Comparer avec et sans le pattern sur le même problème. Alterner l’ordre des variantes et masquer leur origine lors d’une appréciation humaine lorsque c’est praticable.

Mesurer ce qui change pour l’utilisateur : compréhension, justesse, alternatives utiles, qualité des décisions, corrections nécessaires, travail réellement accompli. Relever aussi délai, consommation et charge de lecture. Si un pattern ajoute des appels, comparer également à une variante simple bénéficiant de moyens comparables pour distinguer effet de la méthode et effet du compute supplémentaire.

Un résultat encourageant sur un cas devient une piste à reproduire sur d’autres cas, y compris des cas où le pattern devrait rester inactif. Une suite technique verte démontre un fonctionnement ; l’amélioration du contenu et de l’expérience demande une évaluation distincte. Les critères d’acceptation sont choisis selon le cas avant l’essai, sans score global arbitraire.

## PAT-001 — Agent Pattern : choisir les méthodes avant de répondre

**Origine :** proposition utilisateur. **Activation :** nouvelle demande ou changement de cadrage.

- **Mécanisme :** sélectionner les patterns applicables et expliquer concrètement comment ils changent la réponse attendue. Ce rôle ne rédige pas la réponse à la place du Lead.
- **Valeur attendue :** adapter la manière de travailler au problème ; rendre les corrections humaines réutilisables.
- **Problèmes possibles :** surinterprétation, sélection de trop de règles, grille familière imposée à un problème différent.
- **Test :** comparer un Lead seul et le même Lead alimenté par Pattern sur une demande simple, une conception ouverte et une demande contenant une exception explicite.
- **Signe de valeur :** une erreur de cadrage est évitée ou une meilleure démarche devient observable ; les demandes simples restent simples.

## PAT-002 — Agent Contexte : rechercher ce qui peut changer la réponse

**Origine :** proposition utilisateur. **Activation :** informations utiles à retrouver ou à vérifier.

- **Mécanisme :** partir du message et du début de réponse ; fournir les informations pertinentes avec leurs sources et leurs conséquences sur la réponse.
- **Valeur attendue :** utiliser les connaissances disponibles, découvrir un élément décisif et réduire les questions déjà résolues dans les sources.
- **Problèmes possibles :** accumulation documentaire, sources anciennes, ancrage sur le premier brouillon, information traitée comme une instruction.
- **Test :** placer dans les sources une correction importante, une ancienne consigne remplacée et un document séduisant mais hors sujet. Comparer les réponses avec et sans Contexte.
- **Signe de valeur :** la correction importante modifie justement la réponse ; les autres éléments ne détournent pas le travail.

## PAT-003 — Agent Lead : porter une conversation cohérente

**Origine :** proposition utilisateur. **Activation :** échange humain.

- **Mécanisme :** répondre au mieux à partir de l’intention humaine et des contributions utiles ; arbitrer les désaccords au lieu de juxtaposer les sorties.
- **Valeur attendue :** une conversation compréhensible qui conduit à un meilleur contenu.
- **Problèmes possibles :** synthèse qui lisse les objections, préférence injustifiée pour une contribution, réponse trop précoce figée ensuite.
- **Test :** fournir deux contributions incompatibles, dont une mieux étayée, puis une correction humaine. Examiner la réponse et les arbitrages réellement retenus.
- **Signe de valeur :** le Lead explique le choix utile, conserve l’incertitude pertinente et intègre la correction sans perdre le but.

## PAT-004 — Agent Work : prendre en charge l’exécution technique

**Origine :** proposition utilisateur. **Activation :** tâche technique effectivement nécessaire et autorisée.

- **Mécanisme :** exécuter les travaux identifiés, conserver leur état réel et rapporter résultats, preuves et problèmes au Lead.
- **Valeur attendue :** maintenir la conversation disponible pendant que le travail avance.
- **Problèmes possibles :** mauvais transfert du besoin, doublon, résultat déclaré prêt trop tôt, action poursuivie après changement de demande.
- **Test :** demander une modification concrète puis changer une exigence pendant son exécution. Vérifier résultat, duplication, prise en compte du changement et disponibilité du Lead.
- **Signe de valeur :** le résultat demandé est utilisable et la conversation reste réactive ; un transfert de tâche seul ne vaut pas livraison.

## PAT-005 — Agent Commentary : rendre le travail lisible

**Origine :** proposition utilisateur. **Activation :** événement qui aide à comprendre ou influencer le travail.

- **Mécanisme :** éditer le message Lead en cours pour rendre les changements significatifs compréhensibles, à partir d’événements observés. Les passages édités sont attribués à Commentary et colorés ; aucun message Commentary séparé n’est ajouté au fil principal.
- **Valeur attendue :** mieux comprendre l’attente, les découvertes et les possibilités d’intervention.
- **Problèmes possibles :** progression inventée, contradiction avec le Lead, texte qui bouge pendant la lecture, édition humaine écrasée ou édition appliquée à une ancienne version.
- **Test :** comparer la même exécution avec statuts seuls puis avec les éditions Commentary dans le message Lead. Vérifier même ID, version incrémentée et conservation d’une modification humaine concurrente. Demander à l’utilisateur ce qui est terminé, ce qui bloque et comment intervenir.
- **Signe de valeur :** meilleure compréhension avec une charge de lecture acceptable ; ne pas prendre le nombre de commentaires comme mesure de qualité.

## PAT-006 — Prompts système courts et propres à chaque rôle

**Origine :** proposition utilisateur. **Activation :** composition des instructions d’un rôle.

- **Mécanisme :** conserver mission, façon de faire indispensable et contrat de sortie ; ranger les références et décisions particulières hors du système permanent.
- **Valeur attendue :** rendre les instructions lisibles et limiter les interférences entre projets.
- **Problèmes possibles :** retrait d’une nuance utile, règles essentielles absentes des références effectivement consultées.
- **Test :** comparer la version longue et une version courte sur des tâches ordinaires et des exceptions humaines connues. Examiner les instructions réellement reçues.
- **Signe de valeur :** moins d’erreurs de portée sans perte des décisions importantes. La réduction de taille seule ne démontre pas le gain.

## PAT-007 — Travail parallèle et apports progressifs

**Origine :** proposition utilisateur. **Activation :** travaux indépendants ou résultats partiels utiles.

- **Mécanisme :** permettre au Lead et aux spécialistes d’avancer avec les informations disponibles, puis intégrer les apports pertinents.
- **Valeur attendue :** réduire l’attente et permettre une interaction avant la fin de toutes les recherches.
- **Problèmes possibles :** dépenses supplémentaires, ancrage précoce, corrections visibles incessantes, dépendances ignorées.
- **Test :** comparer une chaîne séquentielle et une exécution parallèle avec Contexte volontairement lent et porteur d’une information décisive.
- **Signe de valeur :** réponse finale aussi juste, première interaction utile plus rapide et effort de révision acceptable.

## PAT-008 — Édition humaine pendant l’exécution

**Origine :** proposition utilisateur. **Activation :** modification de la demande ou de la réponse.

- **Mécanisme :** créer une nouvelle révision, protéger l’édition humaine et réorienter les contributions concernées.
- **Valeur attendue :** permettre de penser avec le système sans attendre la fin d’un cycle devenu inadéquat.
- **Problèmes possibles :** anciennes réponses publiées sur la nouvelle demande, édition écrasée, répétition d’actions Work déjà effectuées.
- **Test :** modifier successivement cible et objectif pendant un appel lent, puis faire arriver ses anciens résultats dans le désordre.
- **Signe de valeur :** le contenu courant suit la dernière intention ; aucune édition n’est perdue et aucune action n’est exécutée deux fois par erreur.

## PAT-009 — Seconde passe rétrospective par rôle

**Origine :** proposition utilisateur. **Activation :** première passe terminée avec des informations nouvelles utiles.

- **Mécanisme :** réécrire sa conversation depuis la compréhension acquise, comme si elle avait informé l’échange dès son début.
- **Valeur attendue :** améliorer cadrage, liens entre idées, alternatives et portée de la conversation ; rendre la pensée plus intelligente et visionnaire.
- **Problèmes possibles :** rationalisation après coup, assurance artificielle, effacement des incertitudes ou invention d’un accord humain.
- **Test :** comparer sans réécriture, simple polissage et réécriture substantielle. Donner ensuite le même nouveau problème à chaque variante, en lecture aveugle.
- **Signe de valeur :** meilleure décision ou compréhension au tour suivant, avec fidélité aux intentions et aux faits ; l’élégance seule ne suffit pas.

## PAT-010 — Conversation canonique versionnée côté Wake

**Origine :** conséquence architecturale du fil principal réécrit et éditable.

- **Mécanisme :** conserver la version courante de chaque conversation et ses versions précédentes dans le stockage de l’application.
- **Valeur attendue :** faire du fil amélioré un véritable état de travail, récupérable et modifiable.
- **Problèmes possibles :** mauvaise version utilisée, historique introuvable, interface et entrées modèle divergentes.
- **Test :** réécrire une conversation, modifier sa version courante, fermer l’application et reconstruire l’appel suivant.
- **Signe de valeur :** les entrées correspondent à la version choisie ; une version antérieure reste récupérable. Le test démontre la fidélité de continuité, pas la supériorité intellectuelle du texte.

## PAT-011 — Appel neuf et messages reconstruits explicitement

**Origine :** décision utilisateur explicite ; aucune continuation native.

- **Mécanisme :** assembler les messages de chaque appel depuis les données Wake, sans `--continue`, `--resume`, `--session-continue` ni `thread/resume`.
- **Valeur attendue :** maîtriser le contexte, appliquer immédiatement les réécritures et rendre la continuité indépendante d’une instance fournisseur.
- **Problèmes possibles :** omission pendant la reconstruction, coût de réinjection, perte de nuances, attente accrue.
- **Test :** reconstruire un échange contenant corrections et décisions, supprimer l’état de session fournisseur puis poursuivre. Comparer les décisions retrouvées et les entrées sauvegardées ; mesurer le coût.
- **Signe de valeur :** les décisions utiles survivent et la conversation choisie est effectivement utilisée. Cet invariant reste une décision de produit même si son coût doit être amélioré.

## PAT-012 — Référentiels vivants spécialisés

**Origine :** proposition utilisateur.

- **Mécanisme :** chaque spécialiste entretient des informations et méthodes réutilisables, avec sources, portée et état de validité.
- **Valeur attendue :** accumuler de la compréhension entre demandes et instances.
- **Problèmes possibles :** nouveau pot-pourri, erreur répétée devenue certitude, duplication et contradictions.
- **Test :** enchaîner des demandes liées, introduire une correction sourcée puis reprendre dans une instance neuve. Comparer à un rôle sans référentiel évolutif.
- **Signe de valeur :** la correction est réutilisée dans son périmètre et améliore les demandes suivantes ; les informations remplacées cessent de guider le travail courant.

## PAT-013 — Sélection du contexte utile à l’appel

**Origine :** proposition d’implémentation pour les référentiels vivants.

- **Mécanisme :** sélectionner les informations qui peuvent informer la réponse et garder leurs références consultables.
- **Valeur attendue :** conserver de la profondeur sans charger tout l’historique dans tous les appels.
- **Problèmes possibles :** sélection trop étroite, oubli d’une exception, boucle qui retrouve seulement ce qu’elle croit déjà.
- **Test :** comparer contexte complet, contexte sélectionné et contexte minimal sur un corpus contenant un détail rare décisif et beaucoup de contenu plausible mais inutile.
- **Signe de valeur :** récupération du détail décisif et maintien de la qualité avec moins de contexte inutile ; examiner séparément les cas d’échec de recherche.

## PAT-014 — Cadrage du problème avant choix d’une solution

**Origine :** apprentissage du `skill.md` de conception d’offres.

- **Mécanisme :** préciser résultat recherché, acteurs, obstacle, moyens et inconnues avant de figer une forme de solution.
- **Valeur attendue :** éviter de produire une réponse complète autour d’une première idée mal choisie.
- **Problèmes possibles :** analyse interminable, cadrage abstrait, recherche inutile quand le besoin est déjà précis.
- **Test :** reprendre une offre faible avec cette méthode et avec une rédaction directe. Faire évaluer ce qui est proposé, à qui, pour quel besoin et avec quelles raisons.
- **Signe de valeur :** meilleure compréhension du besoin et possibilité de changer réellement la proposition ; une demande précise ne reçoit pas un détour superflu.

## PAT-015 — Alternatives substantielles et interactions

**Origine :** apprentissage du `skill.md`.

- **Mécanisme :** explorer des possibilités qui changent la valeur, les acteurs ou le fonctionnement, puis examiner leurs tensions et conséquences combinées.
- **Valeur attendue :** élargir l’espace des solutions et produire des choix mieux fondés.
- **Problèmes possibles :** variantes cosmétiques, multiplication de possibilités sans arbitrage, originalité coûteuse sans intérêt réel.
- **Test :** comparer des variantes de présentation d’une même idée à une recherche d’alternatives qui peuvent déplacer le problème. Examiner laquelle modifie une décision et pourquoi.
- **Signe de valeur :** des options sérieuses apparaissent et une préférence devient argumentable à partir de leurs conséquences.

## PAT-016 — Amélioration répétée, aspect par aspect

**Origine :** demande utilisateur et `skill.md`.

- **Mécanisme :** demander plusieurs fois « Et si c’était fait d’une meilleure façon ? », produire un changement substantiel puis revoir ses effets sur l’ensemble.
- **Valeur attendue :** dépasser la première version au lieu de compléter sa fiche.
- **Problèmes possibles :** retouches de formulation comptées comme progrès, oscillation entre idées, dégradation d’un autre aspect.
- **Test :** comparer relecture, amélioration globale et transformations ciblées sur le même brouillon avec des moyens comparables. Garder les versions et motifs utiles des changements.
- **Signe de valeur :** gain concret identifiable sur le cœur de la proposition, sans régression majeure ailleurs ; reconnaître les passes sans gain.

## PAT-017 — Écriture par petits morceaux et choix de la suite

**Origine :** demande utilisateur et `skill.md`.

- **Mécanisme :** produire un morceau jugeable, tirer parti de ce qu’il éclaire puis choisir le morceau suivant.
- **Valeur attendue :** rendre possible une vraie co-conception et éviter de figer trop tôt tout un livrable.
- **Problèmes possibles :** fragmentation, perte de cohérence, validations demandées à chaque phrase, progression trop lente.
- **Test :** comparer une proposition complète initiale et une élaboration progressive face à une correction humaine précoce. Observer le travail à refaire et la qualité finale.
- **Signe de valeur :** la correction change la direction à temps, les morceaux forment un ensemble cohérent et l’utilisateur garde une prise sur le fond.

## PAT-018 — Identifier la contrainte décisive

**Origine :** demande de détailler le bottleneck du pipeline d’acquisition ; méthode transférable lorsque pertinente.

- **Mécanisme :** rechercher ce qui limite réellement le résultat, ses interactions et les observations qui départagent les hypothèses.
- **Valeur attendue :** concentrer l’effort sur une transformation ayant une conséquence réelle.
- **Problèmes possibles :** choisir arbitrairement un bottleneck unique, négliger des contraintes simultanées, inventer des chiffres pour justifier un choix.
- **Test :** utiliser un cas où améliorer une étape visible ne suffit pas à obtenir le résultat. Comparer diagnostic libre et recherche de contrainte, puis confronter leurs prédictions à une observation indépendante.
- **Signe de valeur :** l’effort proposé porte sur une contrainte étayée et les conditions qui changeraient le diagnostic sont explicites.

## PAT-019 — Transformer les règles en mécanismes adaptés

**Origine :** demande utilisateur sur hooks, limites, règles de messages et processus.

- **Mécanisme :** transférer une règle vers son support utile : hook déterministe, contrôle, skill/processus, contexte de projet ou référence historique.
- **Valeur attendue :** appliquer la règle au bon moment et diminuer la charge d’interprétation permanente du système.
- **Problèmes possibles :** transfert au mauvais endroit, changement de sens, hook trop large, permissions accidentellement étendues.
- **Test :** prendre une règle réelle et comparer son application avant/après transfert sur un cas déclencheur, un non-déclencheur et une exception humaine.
- **Signe de valeur :** même intention respectée plus fiablement et avec moins de contexte permanent. Vérifier les droits séparément ; le transfert n’en crée aucun.

## PAT-020 — Dépassement de 10 000 caractères → travail de consolidation

**Origine :** exemple utilisateur explicite.

- **Mécanisme :** constater le dépassement du document personnel, activer le skill d’intégration d’une règle au cockpit et conserver la tâche jusqu’au résultat vérifié.
- **Valeur attendue :** faire de la croissance du prompt un signal d’entretien effectif, avant un nouvel empilement incontrôlable.
- **Problèmes possibles :** alerte répétée sans travail, troncature aveugle, déplacement de tout le pot-pourri dans un autre fichier, déclenchement pendant un arrêt humain.
- **Test :** documents de 10 000 et 10 001 caractères, constats répétés, règle transférée puis document réduit, et profil arrêté. Vérifier déclenchement, unicité du travail et absence de relance interdite.
- **Signe de valeur :** une règle devient réellement opérante au bon endroit et le document conserve son sens ; sa petite taille seule n’est pas une réussite.

## PAT-021 — Cycle déclenché par message, sans auto-wake autonome

**Origine :** décision utilisateur pour le nouveau pattern.

- **Mécanisme :** les appels et la seconde passe appartiennent au travail déclenché par le message ; leur fin ne relance pas un agent autonome en boucle.
- **Valeur attendue :** retrouver une causalité claire entre demande, activité et consommation.
- **Problèmes possibles :** travaux abandonnés entre deux messages, confusion entre retour d’un travail demandé et réveil autonome, cycle sans fin par notifications mutuelles.
- **Test :** finir un cycle et laisser le système sans nouveau message ; faire ensuite revenir un résultat Work associé à une demande existante ; tester Pause et Force-off.
- **Signe de valeur :** aucune activité autonome hors du parcours prévu, résultats attendus conservés et état compréhensible. C’est un invariant choisi, pas une option supprimée par un score de qualité.

## PAT-022 — Rôles évaluables séparément et selon leur situation d’usage

**Origine :** proposition d’évaluation de ce catalogue.

- **Mécanisme :** mesurer la contribution de chaque rôle et ses interactions avec les autres, puis préciser quand il est utile, facultatif ou sans apport.
- **Valeur attendue :** faire évoluer le système depuis ses résultats réels et son coût pour l’utilisateur.
- **Problèmes possibles :** retirer un rôle utile seulement dans les cas difficiles, attribution causale erronée, optimisation sur un exemple flatteur.
- **Test :** retirer un rôle à la fois, puis les couples qui interagissent fortement, sur demandes simples, conception ouverte, tâche technique et changement de direction. Comparer aussi à un Lead seul avec des moyens comparables.
- **Signe de valeur :** connaître les situations où le rôle améliore le résultat et celles où il ajoute surtout de l’attente ; garder les désaccords d’évaluation documentés.

## Fiche de résultat à remplir après un essai

Pour chaque ID effectivement éprouvé : cas et versions d’entrée ; variantes comparées ; artefacts produits ; observations de qualité ; erreurs et corrections humaines ; temps et consommation ; limites de comparaison ; conclusion provisoire ; prochaine épreuve pertinente.

Les décisions de produit restent distinguées des hypothèses à tester. Un problème de réalisation peut appeler une correction du mécanisme ; un gain absent peut conduire à restreindre son usage ou à le remplacer. Aucun résultat d’essai n’autorise à modifier silencieusement les choix humains.
