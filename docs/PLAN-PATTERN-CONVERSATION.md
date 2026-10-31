# Plan d’implémentation — conversation vivante à rôles spécialisés

**Un message humain lance une coopération spécialisée qui construit une bonne réponse, puis améliore la conversation dont partiront les échanges suivants.** Les fils spécialisés deviennent des référentiels vivants ; Commentary rend le travail compréhensible pendant son déroulement.

État au 31 octobre 2026 : le nouveau parcours est implémenté et le panneau Windows livré à 22:04 a été vérifié dans sa vraie fenêtre, sans lever le Force-off. Les lots ci-dessous conservent le plan initial ; le [guide d’utilisation](CONVERSATION.md) et le [journal des changements](CHANGELOG-CONVERSATION.md) distinguent le code testé, les contrôles observés et les points encore ouverts. Le premier échange avec un modèle réel reste à observer après activation humaine.

## 1. Périmètre et décisions de départ

Les six rôles sont Expertise, Pattern, Contexte, Lead, Work et Commentary. Expertise conserve les instructions humaines réutilisables avec leur source, leur portée et leurs conditions d’application. Chaque rôle possède sa conversation logique, son référentiel et un prompt court décrivant sa mission, sa méthode et sa sortie attendue.

Le Lead porte la conversation principale. Pattern sélectionne les méthodes pertinentes et explique leur effet sur la réponse. Contexte apporte les informations et ce qu’elles changent. Work exécute les tâches techniques pertinentes. Commentary intervient par des éditions à l’intérieur du message Lead en cours, avec attribution et couleur des passages modifiés. Il ne publie pas de messages de progression séparés dans le fil principal.

Les rôles peuvent travailler en parallèle et recevoir les résultats disponibles progressivement. Les dépendances utiles restent explicites : une contribution qui répond à une ancienne version du message ne devient pas la réponse courante.

La seconde passe appartient à chaque rôle. Elle produit une version reconstruite de sa conversation, éclairée par les informations acquises. La qualité recherchée est une meilleure compréhension, de meilleures alternatives et de meilleures décisions ; une formulation plus assurée ne suffit pas à démontrer une amélioration.

**Chaque appel modèle repart à neuf.** Wake reconstruit explicitement les messages depuis la conversation canonique, les données propres au rôle et les contributions applicables à la révision courante. Aucun `--session-continue`, `--continue`, `--resume` ou `thread/resume` ne sert à porter la continuité de ce mode. Les fils visibles sont des conversations logiques stockées par Wake, indépendantes des sessions du fournisseur.

## 2. Points du code existant qui déterminent l’architecture

| Élément actuel | Conséquence pour ce chantier |
| --- | --- |
| `src/contracts/adapter.ts` expose activité, usage et fin, sans message public complet | Ajouter une sortie de texte exploitable avant de relier les rôles. Les résumés de 200 caractères de Codex ne constituent pas cette sortie. |
| `src/runner/runner.ts` refuse une deuxième session du même profil | Construire un coordinateur conversationnel avec ses propres exécutions de rôles. Réutiliser les mécanismes de contrôle et les adapters, sans représenter les rôles comme plusieurs wakes autonomes du profil. |
| Codex et Claude possèdent des mécanismes de reprise native | Les désactiver dans ce mode. Chaque appel reçoit ses messages reconstruits ; un appel neuf ne charge aucun historique fournisseur implicite. |
| `owner-steering.ts` ajoute du contenu au tour actif | Une édition exige une révision applicative et une décision de réorientation ou d’annulation ; un ajout au fil ne remplace pas une ancienne demande. |
| Le stockage actuel distingue déjà historique, contexte et messages | Faire de la conversation canonique Wake la source des messages de chaque appel. Une réécriture modifie ainsi les entrées du prochain appel, et pas seulement le texte affiché. |

Les jobs et helpers existants fournissent des mécanismes réutilisables de supervision, de résultat et d’annulation. Leur sélection automatique de correspondants et leurs consultations éphémères ne deviennent pas le coordinateur des rôles.

## 3. Socle à créer

Nouveau module `src/conversation/` :

- `contracts.ts` : rôles, cycles, révisions, contributions, événements publics et états d’exécution.
- `store.ts` : persistance SQLite transactionnelle des conversations, versions, exécutions et sources.
- `coordinator.ts` : déclenchement sur message humain, circulation des contributions, annulation et fin de cycle.
- `role-runtime.ts` : appels neufs aux adapters, sans reprise native, et contrôle des processus d’un rôle.
- `prompts.ts` : composition des instructions courtes, du contexte sélectionné et du message du tour.
- `messages.ts` : reconstruction explicite des messages de chaque appel depuis un instantané versionné des données Wake.
- `rewrite.ts` : seconde passe et conservation des conversations canoniques réécrites.

Les instructions propres aux rôles vivent dans `prompts/conversation/`. Ce mode ne réinjecte pas l’actuel `PERSONALITY.md` de 75 000 caractères dans chaque rôle. Les consignes natives du fournisseur restent présentes ; les permissions et contrôles de Wake continuent de s’appliquer.

La clé d’une exécution contient au minimum la conversation, la révision de travail, le rôle et la passe. Chaque appel conserve l’instantané exact des messages fournis et les versions de ses sources. Les versions sont des données explicites, pas des informations à deviner dans le texte d’une réponse.

La construction d’un appel assemble les instructions du rôle, sa conversation canonique, les informations utiles de son référentiel, les contributions reçues et le message humain courant avec sa révision. Leur origine et leur nature restent explicites : un contenu trouvé par Contexte ne devient pas une consigne système. La représentation exacte dépend du transport officiel utilisé, mais aucun état de conversation nécessaire n’est confié à une reprise implicite du fournisseur.

## 4. Lots de développement

### Lot 1 — un cycle manuel réel de bout en bout

- [ ] Ajouter les sorties publiques complètes au contrat d’adapter, séparées des résumés d’activité et du raisonnement privé.
- [ ] Raccorder Codex d’abord ; maintenir la compatibilité des autres adapters. Ajouter les deltas de streaming au lot suivant.
- [ ] Créer le stockage versionné des conversations logiques par rôle et le constructeur de messages.
- [ ] Garantir un appel fournisseur neuf à chaque exécution, sans aucune option de reprise ; sauvegarder les messages effectivement transmis.
- [ ] Exécuter un premier cycle Pattern → Contexte → Lead, avec contributions typées et persistées.
- [ ] Fournir une commande locale pour envoyer un message, lire le cycle et l’arrêter. Les commandes rendent une référence de cycle et son état ; leur retour ne prétend pas qu’une réponse est terminée.
- [ ] Terminer sans relance autonome lorsque le cycle est fini.

**Preuve :** un message produit les contributions complètes de Pattern et Contexte puis une réponse Lead dans des conversations logiques distinctes. Chaque appel est neuf et reçoit le contenu attendu explicitement. Une répétition de la même demande idempotente retrouve le même cycle. La fin n’appelle pas le scheduler de wakes.

### Lot 2 — parallèle, streaming et modifications pendant le travail

- [ ] Faire évoluer le coordinateur vers des événements asynchrones : Pattern et Contexte démarrent avec les éléments disponibles ; le Lead peut commencer puis intégrer leurs apports.
- [ ] Ajouter les deltas de texte public nécessaires à la réponse en cours.
- [ ] Donner une nouvelle révision à une édition humaine du message ou de la réponse. Un texte en cours d’édition reste protégé des publications concurrentes.
- [ ] Réorienter les travaux encore pertinents et annuler les travaux devenus inutiles. Conserver les résultats anciens avec leur provenance sans les publier sur la nouvelle révision.
- [ ] Permettre de conserver une modification humaine du Lead lors des passes suivantes.

**Preuve :** pendant un appel de contexte volontairement lent, une modification humaine change la direction de la réponse ; le résultat tardif de l’ancienne demande ne l’écrase pas. Une panne d’un rôle est visible et les apports utilisables restent disponibles.

### Lot 3 — Work et Commentary dans le fil du Lead

- [ ] Confier à Work les tâches techniques identifiées, avec dépendances, résultat attendu et références aux travaux existants pour éviter les doublons.
- [ ] Raccorder Work à la supervision des processus et aux contrôles existants. Conserver l’état réel des actions déjà exécutées lorsqu’une demande change.
- [ ] Alimenter Commentary avec les événements et résultats observés du cycle et la version du message Lead à éditer. Il propose des éditions ciblées dans ce message, sans inventer une progression ni recopier tous les logs.
- [ ] Appliquer ces éditions au même identifiant de message avec contrôle de version. Conserver les modifications humaines concurrentes et attribuer les passages à leur agent pour les colorer.
- [ ] Montrer les ajouts Commentary dans le corps du message Lead, sans nouvelle bulle ni nouvelle ligne de message. Son propre fil reste consultable séparément.

**Preuve :** un travail technique s’exécute pendant que la conversation reste disponible ; un événement réel conduit Commentary à éditer le message Lead existant (même ID, version suivante, passages attribués). Le nombre de messages n’augmente pas à cause de Commentary. Une édition humaine concurrente est conservée. Le résultat de Work rejoint le Lead ; un arrêt interrompt les processus appartenant au cycle.

### Lot 4 — seconde passe et conversation reconstruite

- [ ] Déclencher la seconde passe depuis l’état explicite des contributions disponibles pour la révision courante.
- [ ] Demander à chaque rôle de réécrire sa conversation à la lumière des informations acquises : cadrage, liens entre idées, alternatives et qualité de la réponse.
- [ ] Conserver l’intention humaine, les incertitudes utiles et les sources. Une correction de compréhension ne devient pas un ancien accord humain inventé.
- [ ] Enregistrer la version reconstruite et garder la version précédente accessible. Appliquer les réécritures seulement si leur version de départ est encore actuelle.
- [ ] Reconstruire les messages du prochain appel neuf depuis la nouvelle conversation canonique. Conserver les anciennes versions et entrées d’appels comme traces.
- [ ] Empêcher qu’une réécriture déclenche elle-même une boucle infinie de réécritures. Les deux passes appartiennent au cycle de la demande, sans réveils périodiques supplémentaires.

**Preuve :** une information découverte par Contexte améliore la conversation canonique ; le message humain suivant est traité depuis cette conversation améliorée. Une édition humaine concurrente reste conservée.

### Lot 5 — référentiels vivants et règles exécutables

- [ ] Persister les informations et méthodes utiles par rôle avec leur source, leur portée et leur état : proposé, retenu, remplacé ou à vérifier.
- [ ] Sélectionner les références utiles au travail courant plutôt que tout réinjecter dans chaque prompt.
- [ ] Diriger les méthodes vers les skills/processus, les conditions déterministes vers les hooks, les limites vers les contrôles et les informations historiques vers les références.
- [ ] Implémenter le premier exemple demandé : au-delà de 10 000 caractères dans le document personnel, le contrôle signale le dépassement et Pattern reçoit le skill de consolidation. Une règle est extraite vers son mécanisme cible, vérifiée, puis son ancien texte peut être archivé. Le signal ne supprime ni ne tronque le document.
- [ ] Conserver le travail de consolidation entre deux cycles sans créer un doublon à chaque constat du même dépassement.

**Preuve :** une règle transférée est effectivement appliquée par son hook ou son processus ; son origine reste retrouvable. La suppression d’un état de session fournisseur ne retire pas la conversation logique et ses références : l’appel suivant est entièrement reconstruit depuis Wake. Un résultat en cours perdu reste signalé comme tel.

### Lot 6 — raccord au panneau et usage courant

- [ ] Ajouter le mode conversation spécialisée dans le parcours desktop, avec son envoi, ses éditions et ses états.
- [ ] Raccorder `desktop/ui/conversation.ts`, `main.ts` et les commandes Tauri au coordinateur. Dans ce mode, envoyer un message ne passe plus par le couple `wake_reply` puis réveil du scheduler.
- [ ] Permettre d’ouvrir les fils spécialisés et leurs sources depuis le fil principal, de voir la version reconstruite et de retrouver une version précédente.
- [ ] Afficher les échecs, la consommation mesurée et les contributions de chaque rôle, pour juger ce qu’ils apportent réellement.
- [ ] Vérifier le raccord Claude sur le même contrat. Le choix de runtime reste explicite, sans bascule implicite de fournisseur.

**Preuve :** installation → message → contributions → réponse → édition pendant le travail → seconde passe → reprise après fermeture du panneau. Vérifier également Pause, Force-off, crash et reprise sans double exécution.

## 5. Vérification et ordre de livraison

Les tests du coordinateur utilisent un adapter contrôlé pour produire des événements dans le désordre, des erreurs et des résultats périmés. Ils vérifient la persistance, les versions et les arrêts ; ils ne prétendent pas prouver la qualité d’un modèle.

Un essai avec le vrai runtime vérifie ensuite les textes complets, les appels neufs sans reprise native, les messages reconstruits, les outils réellement disponibles et l’usage de la conversation réécrite au tour suivant. L’activation respecte l’arrêt humain : aucun essai ne réactive le profil actuellement en Force-off.

Chaque lot se termine par une tranche inspectable avant le suivant. Le premier résultat attendu est le **lot 1**, pas une réécriture générale du daemon, de tous les prompts ou de la mémoire existante.
