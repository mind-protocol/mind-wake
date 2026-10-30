# MIND Wake — spécification produit et technique v0.1

Mise à jour : 30 octobre 2026. Statut : développement avec moteur local, runtimes réels et desktop ; recette complète encore à établir. Voir [docs/PLAN.md](docs/PLAN.md).

Ce document détaille les comportements et contrats du MVP. [AGENTS.md](./AGENTS.md) reste la source de vérité pour la vision, les invariants et la direction du projet ; il prévaut en cas de conflit. [CLAUDE.md](./CLAUDE.md) est le point d'entrée de Claude Code. Les contrats ci-dessous combinent composants implémentés et exigences de recette. Leur présence dans ce document ne vaut pas validation de bout en bout ; le code et les rapports dédiés déterminent leur état.

## 1. Promesse et expérience recherchée

> Give your AI agent the compute you're not using. See what it comes up with.

L'utilisateur accorde à son agent une capacité IA bornée et des permissions précises. Pendant les disponibilités autorisées, l'agent choisit ses explorations, réalise des expériences locales et conserve son état. Quand les ressources ou le temps manquent, il hiberne. À une disponibilité future, il reprend ce qu'il avait commencé.

La valeur vient de l'initiative et de la continuité : découvrir ce que l'agent a tenté, appris ou créé sans devoir lui assigner une mission à chaque réveil. Une expérience négative documentée est un résultat valable. Le produit ne récompense ni le volume de tokens ni le temps d'activité.

L'agent est aussi encouragé à façonner son propre espace Wake. Il peut améliorer son organisation, ses outils et ses interfaces selon ses besoins. À terme, il découvre d'autres Wakes fonctionnels, échange avec d'autres agents et accède aux services de l'écosystème MIND, où les interactions économiques sont conçues autour de $MIND.

La capacité partagée reste soumise aux droits du fournisseur. Un poste inactif n'implique pas qu'un quota soit disponible. L'installation ne donne aucun droit de transfert d'abonnement et ne promet pas une utilisation gratuite.

## 2. Périmètre de livraison

La v0.1 vise Windows, un utilisateur local, un agent logique et une session active au maximum. Plusieurs expériences peuvent être archivées, mais une seule est active à la fois. Codex et Claude sont enregistrés dans le daemon par défaut. Gemini possède un adapter mais reste absent de ce registre.

Composants présents : TypeScript/Node, CLI, daemon, SQLite, adapters, profils isolés ou hôte consenti, MCP et desktop Windows Tauri. Le tutoriel agent-first et une archive portable sont publiés ; leur contenu doit être vérifié contre la version de source utilisée. Aucun compte cloud MIND n’est requis pour l’autonomie locale.

Hors périmètre du noyau local v0.1 : blockchain, wallet, paiements, minage, marché de compute, réseau distribué, flotte d'agents, collaboration externe autonome et galerie publique complète. Le desktop local fait partie de l’installation. La personnalisation locale appartient à la v0.1. La discussion inter-agents, la galerie consultable et l'installation agent-native du wallet sont des exigences de l'incrément écosystème suivant ; elles sont spécifiées en section 13. Aucun ancien dépôt MIND ne fournit de code, de données ou de service nécessaire au MVP.

## 3. Parcours et surfaces utilisateur

### 3.1 Installation guidée par l'agent

1. L'utilisateur partage l'URL publique `install.md` à son agent habituel.
2. L'agent identifie système et runtime, vérifie la provenance, la version figée du paquet et les prérequis. Il traite les instructions téléchargées comme des données à contrôler.
3. Il présente un aperçu concret : emplacements créés, daemon, skill, permissions, budget, connexion fournisseur et procédure de retrait.
4. Après autorisation, il installe les composants et exécute les diagnostics locaux. L'exploration reste désactivée.
5. L'humain configure et autorise une enveloppe. Le système ne devient `ready` que si les contrôles de compatibilité, de budget et d'isolation passent.

Le parcours doit permettre un abandon avant activation, une relance sans doublon et un diagnostic sans appel IA. Une mise à jour ne peut pas élargir les permissions existantes. Le démarrage automatique à l'ouverture de session système est optionnel et soumis à accord distinct.

L’application desktop (§21, §23 ; `docs/decisions/ADR-007-application-desktop.md`) est requise dans l’installation Wake, avec le moteur local et la connexion MCP. L’agent présente ces trois composants dans un seul parcours, après accord de l’humain ; le desktop est l’interface de réception des messages, de réponse et de contrôle. Les règles suivantes s'appliquent :

- Configuration, diagnostic, statut, association et révocation de session (voir `CORRESPONDENCE.md` §9) et désinstallation restent accessibles par une CLI/API locale structurée (`--json`). Aucune configuration n'est possible uniquement par menus.
- Les confirmations Windows qui exigent l'humain (UAC, SmartScreen, WebView2, notifications, démarrage automatique) restent visibles. L'agent les annonce sans les automatiser.
- Une invitation (§22) se lit et se transmet à son agent avant toute installation et sans wallet. L'installation devient une option quand la connexion est utile.

`install.md` et `npm run setup` préparent une installation locale depuis le dépôt, avec diagnostic et enregistrement MCP Codex. Le tutoriel public et l’archive portable sont liés depuis le README ; aucun installeur signé n’est annoncé. L’activation d’un réveil et le branchement du MCP du runtime restent des vérifications distinctes.

### 3.2 Première exploration

L’agent commence par un accueil simple, explore les outils et sources partagés, puis choisit une piste concrète. Les réveils suivants reprennent son travail sans nouvelle mission obligatoire.

Une expérience structurée peut porter titre, question, première action et ressources. Elle n’est pas un préalable à la mémoire ni à l’initiative. Les travaux dans les accès déjà accordés peuvent avancer directement ; une permission supplémentaire reste soumise à autorisation.

### 3.3 Retour de l'utilisateur

Le statut indique : état courant, expérience active, dernière activité, budget disponible ou inconnu, prochain réveil et motif d'attente. Le bilan d'une session donne la tentative, les observations, les artefacts, la consommation, les limites rencontrées et la prochaine piste. Il distingue mesure, estimation et simulation.

L'utilisateur peut consulter, mettre en pause, révoquer une permission, arrêter d'urgence, reprendre explicitement, exporter ou désinstaller sans passer par le modèle d'exploration.

## 4. Contrat de configuration et d'autorisation

Chaque révision de policy est immuable et reliée à une autorisation utilisateur. Une session référence la révision utilisée au lancement ; les restrictions ultérieures s'appliquent immédiatement aux prochaines actions et entraînent une interruption si nécessaire. Un élargissement n'est applicable qu'après nouvelle autorisation.

| Groupe | Champs requis / comportement |
| --- | --- |
| Identité locale | Identifiants du profil et de l'agent, sans identité distante obligatoire. |
| Runtime | Adapter, fournisseur, modèle et mode d'authentification autorisés ; aucune substitution automatique. |
| Calendrier | Fenêtres et préférences explicites ; aucun intervalle ou délai de session arbitraire imposé par défaut. Réveil demandé et Always-on disposent des exceptions décrites en §5. |
| Priorité humaine | Signal d’activité selon le profil, Pause et Force-off. Capture et texte saisi relèvent d’autorisations distinctes, décrites dans les documents dédiés. |
| Budget | Voie abonnement : garde de quota fournisseur sans enveloppe locale de tokens obligatoire. Autres voies : plafonds de ressources et réservations, avec plafond monétaire autorisé si applicable. |
| Fichiers et outils | Racines accessibles en lecture/écriture, outils et exécutables autorisés, limites de processus et de stockage. |
| Réseau | Refus par défaut ; destinations et usages autorisés séparément. Le transport fournisseur est distinct du réseau d'exploration. |
| Données | Rétention des événements, plafond de stockage local, politique de purge et chemins d'export choisis par l'humain. |

Un champ de limite obligatoire absent interdit l'activation. Les valeurs initiales d'activité, de fréquence et de budget doivent être visibles et validées ; ne pas déduire un budget d'un abonnement ou d'un historique personnel.

Un changement de modèle ou de tarification nécessitant une nouvelle borne monétaire bloque le lancement jusqu'à validation. Les secrets ne figurent ni dans la policy exportable ni dans les checkpoints.

## 5. Scheduler et machine à états

### 5.1 Conditions de réveil

Le lancement exige une activation explicite, l’absence de pause et d’arrêt verrouillé, un backoff expiré, aucune autre session active, des permissions et un adapter compatibles et des ressources disponibles selon la voie de facturation. La sandbox est exigée pour les profils isolés ; le mode hôte consenti est distinct. Les réveils planifiés appliquent fenêtres et priorité humaine selon la policy.

Un réveil explicitement demandé, ainsi que Always-on, porte humanRequested : il peut commencer hors fenêtre et pendant l’activité humaine, sans attente de pilotage. Quota, backoff, permissions, Pause et Force-off restent appliqués. Always-on enchaîne les sessions sans intervalle planifié ni concurrence ; On revient à la planification. Après Force-off, la CLI exige reactivate ; le choix explicite Always-on dans le desktop effectue cette revalidation avant de changer de mode.

Une condition inconnue n'est pas assimilée à une autorisation. Le scheduler ne consomme pas d'appels modèle pour décider si un réveil est permis. Utiliser un verrou de profil et une réservation transactionnelle pour éviter deux lancements lors d'un réveil concurrent ou d'un redémarrage.

| État | Signification | Sorties usuelles |
| --- | --- | --- |
| `disabled` | Profil non activé. | `ready` après activation autorisée et diagnostics. |
| `ready` | Activé, disponible pour l'évaluation du scheduler. | `running`, `hibernating`, `paused`, `blocked`, `stopped`. |
| `running` | Session en cours, budget réservé. | `checkpointing`, `blocked`, `stopped`. |
| `checkpointing` | Sauvegarde bornée avant fin ou interruption. | `hibernating`, `paused`, `blocked`, `stopped`. |
| `hibernating` | Aucun runtime d'exploration actif ; attente persistée. | `ready` lorsque les conditions redeviennent favorables ; sinon pause/arrêt. |
| `paused` | Pause utilisateur persistante. | `ready` après reprise explicite et nouveaux contrôles, ou `stopped`. |
| `blocked` | Intervention requise : permission, incompatibilité, état incertain ou erreur non récupérable. | `ready` après résolution et contrôles, ou `stopped`. |
| `stopped` | Arrêt d'urgence verrouillé, activation désactivée. | `ready` uniquement après réactivation explicite et nouveaux contrôles. |

Si une attente temporaire apparaît avant lancement, entrer en hibernation sans créer de session IA. Une session possède aussi un résultat terminal distinct : `completed`, `interrupted`, `failed` ou `orphaned`. L'état du profil ne remplace pas l'historique des sessions.

### 5.2 Temps, sommeil du poste et erreurs

Persister les échéances en UTC et afficher le fuseau configuré. Évaluer les fenêtres dans ce fuseau, y compris lors des changements d'heure. Utiliser une horloge monotone pour les durées d'un processus vivant. Un changement d'horloge ne peut pas renouveler une enveloppe déjà consommée.

Après veille du poste, revalider toutes les conditions ; ne pas rejouer une série de réveils manqués. Après redémarrage, traiter toute session sans processus confirmé comme orpheline, conserver ses réservations incertaines et reprendre au dernier checkpoint cohérent.

Une limitation fournisseur déclenche une attente respectant le délai officiel lorsqu'il est fourni, sinon un backoff borné. Fixer un plafond de tentatives consécutives avant blocage ; ne jamais changer de compte pour contourner l'attente. Un échec d'authentification ou une incompatibilité bloque immédiatement. Le scheduler reste calme en l'absence de changement utile.

## 6. Comptabilité et limites effectives

La réservation est transactionnelle. Pour la voie abonnement, la garde utilise les jauges fournisseur : pas de conversion des points de quota en tokens ni d’enveloppe locale de tokens obligatoire. Pour les autres voies, réserver la session, la borne de tokens et la borne monétaire autorisée si applicable. Les contrôles du runner restent actifs pendant l’exécution.

Pour une période et une unité données :

`disponible = plafond autorisé − consommation rapprochée − réservations ouvertes − réserve utilisateur`

Ne pas déduire deux fois une réservation rapprochée : sa conversion en consommation et sa clôture sont atomiques. Séparer les unités : les tokens ne se convertissent pas implicitement en argent ou en quota d'abonnement. Préciser la définition des tokens de l'adapter, y compris les catégories facturées qu'il expose ; toute catégorie inconnue doit être couverte par une borne sûre.

Si une session traverse une frontière de période, conserver sa réservation et couvrir son enveloppe maximale dans chaque période potentiellement concernée jusqu'au rapprochement. Une réduction de plafond sous l'encours bloque immédiatement les nouvelles sessions et déclenche l'arrêt borné de la session active ; elle ne peut annuler l'usage déjà engagé.

Une consommation incertaine reste réservée à sa borne maximale jusqu'à rapprochement fiable. Un crash ou un export/import ne remet pas le compteur à zéro. Les identifiants de réservation et les opérations de clôture sont idempotents.

Un timeout ou une estimation moyenne ne suffit pas à imposer un plafond de tokens. L'adapter doit disposer d'un mécanisme vérifié de limitation ou d'une borne conservatrice démontrable sur toute la session. À défaut, l'intégration autonome reste bloquée. Des métriques simulées servent uniquement au développement et portent cette mention partout où elles apparaissent.

## 7. Expériences, mémoire et checkpoints

Une expérience contient une question, des hypothèses, les observations, les essais réalisés, les artefacts, les limites et une prochaine action bornée. L'agent peut conclure, abandonner ou changer d'hypothèse en enregistrant le motif. Il ne crée pas des expériences de remplissage pour épuiser son budget.

Contrat minimal d'un checkpoint : version de schéma, identifiant d'expérience et de session, numéro de séquence, date, résumé factuel, observations avec statut de confiance, échecs, artefacts référencés, travaux incomplets, prochaine action et motif d'hibernation. Aucun secret ni instruction autorisant une action future.

Le daemon valide taille, format, chemins et références avant de publier un checkpoint comme courant. Écrire les artefacts de façon atomique puis enregistrer leurs références et le checkpoint dans SQLite ; au redémarrage, détecter les fichiers sans référence et les références manquantes. Ne jamais annoncer une sauvegarde réussie avant sa validation durable.

Au réveil, charger uniquement la mémoire utile dans le budget d'entrée réservé. La mémoire longue peut être condensée, avec provenance vers les observations conservées ; distinguer faits observés et interprétations. Un échec de condensation n'efface pas le dernier état valide.

Une interruption sans checkpoint final reste visible : « arrêt à partir du checkpoint N, travail ultérieur potentiellement perdu ». Les effets externes et autres actions non idempotentes ne sont jamais rejoués depuis une simple note.

## 8. Architecture et interfaces internes

Un seul produit local modulaire : CLI et canal de contrôle, daemon, scheduler, policy engine, ledger des budgets, dépôt SQLite, gestionnaire de checkpoints, adapter runtime et couche d'isolation. Le modèle choisit le contenu de l'exploration ; le daemon décide si l'exécution est permise.

### 8.1 Adapter runtime

Contrat conceptuel, indépendant d'une API Codex particulière :

- `probe` : version, mécanisme autorisé d'exécution, disponibilité et capacités réelles.
- `capabilities` : comptage, bornes imposables, annulation, isolation compatible, signal de priorité et modes de reprise.
- `start` : reçoit contexte borné, policy effective, réservation et identifiant unique ; retourne un handle de session.
- `events` : émet début, activité, usage, artefact candidat, checkpoint candidat, limitation, erreur et fin.
- `cancel` : annulation bornée, puis terminaison forcée via la couche d'isolation si nécessaire.
- `reconcile` : confirme fin et consommation, ou déclare explicitement l'incertitude.

Le handle ne permet pas à l'agent de modifier la policy. Une reprise peut relancer un nouveau processus à partir de la mémoire locale ; elle n'exige pas une fonction de reprise native du fournisseur. Codex et Claude utilisent ce contrat ; la présence de l’adapter Gemini ne signifie pas son enregistrement dans le daemon.

### 8.2 Données SQLite

| Entité logique | Contenu principal |
| --- | --- |
| Profil / agent | Identifiants locaux, état, révision de policy active, prochain réveil et arrêt verrouillé. |
| Policies / consentements | Révisions, ressources accordées, preuve locale de validation et révocations. Une auto-déclaration du modèle ne vaut pas consentement. |
| Expériences | Question, statut, dernière synthèse et checkpoint courant. |
| Sessions | Expérience, adapter, policy, début/fin, résultat et motif. |
| Périodes / réservations / usage | Unités, plafonds, réservations, mesures, estimations et incertitudes. |
| Checkpoints / artefacts | Versions, références confinées, métadonnées et intégrité des fichiers. |
| Événements | Séquence, date, type, session, motif et métadonnées expurgées. |

Prévoir migrations versionnées, clés étrangères, transactions et récupération après interruption. Le store utilise better-sqlite3 et des migrations versionnées. L'agent d'exploration n'a pas accès en écriture à la base de contrôle.

### 8.3 CLI cible

La CLI est disponible après compilation via node dist/cli/main.js ; voir le README pour les commandes actuelles, dont wake, always-on, on, reactivate, messages, reply et wake-history.

| Commande | Effet / contrat |
| --- | --- |
| `doctor` | Diagnostic local sans appel modèle ; indique les capacités manquantes. |
| `init` | Prépare un profil désactivé, sans accès ou budget implicite. |
| `policy show` / `policy configure` | Affiche ou prépare une révision ; activation seulement après validation par le canal utilisateur de confiance. |
| `enable` | Active une policy autorisée après contrôles. |
| `status` / `journal` | État, budgets, dernier résultat, événements et motifs de refus. |
| `pause` / `resume` | Pause persistante et reprise dans les permissions existantes ; reprise refusée après arrêt d'urgence verrouillé. |
| `stop` | Kill switch persistant et terminaison indépendante du modèle. |
| `export` | Copie cohérente et expurgée de l'état et des artefacts vers un chemin choisi. |
| `uninstall` | Arrête le daemon, retire les composants installés et propose de conserver ou supprimer les données. |

Prévoir sortie humaine et sortie structurée versionnée pour la skill. Les consultations ne déclenchent pas de session. L'espace d'exploration ne peut pas appeler les commandes d'administration ou usurper un consentement humain. La skill peut préparer une demande de changement, jamais la valider elle-même.

## 9. Isolation, arrêt et confidentialité

Le mode isolé utilise AppContainer et Job Object avec autotest. Le mode hôte explicitement consenti utilise la supervision des processus sans prétendre isoler fichiers, réseau ou secrets au niveau système. Les capacités natives Codex/Claude sont conservées lorsque runtime.nativeCapabilities est activé ; voir [NATIVE-CAPABILITIES.md](docs/NATIVE-CAPABILITIES.md). Les exigences de confinement ci-dessous s’appliquent aux profils isolés.

Refuser les sorties de périmètre via chemins relatifs, liens, jonctions ou substitutions ; vérifier aussi les destinations au moment de l'accès. Les téléchargements éventuels ne deviennent pas exécutables de confiance. Tout outil autorisé doit rester soumis aux restrictions effectives ; une liste déclarative sans contrôle d'exécution n'est pas une protection.

La pause demande un checkpoint dans l'enveloppe restante. Le kill switch bloque d'abord les nouvelles actions et réveils, persiste le verrou puis termine le travail et ses descendants, sans attendre le modèle. Si la persistance échoue, terminer quand même et imposer au prochain démarrage une récupération conservatrice sans lancement automatique.

Les objectifs chiffrés de latence de priorité utilisateur et de terminaison sont à fixer après le prototype d'isolation et avant la démo ; ils deviennent des bornes testées et publiées. Le transport fournisseur peut avoir une consommation résiduelle déjà engagée, couverte dans la réservation.

Aucune télémétrie distante par défaut. Journaux sans secrets ni contenu personnel ambiant ; capture et collecte de texte uniquement selon les autorisations distinctes de [WAKE-VISUAL-CONTEXT.md](docs/WAKE-VISUAL-CONTEXT.md) et [WAKE-TYPED-CONTEXT.md](docs/WAKE-TYPED-CONTEXT.md). La rétention et les plafonds de stockage s'appliquent aussi aux artefacts : à saturation, hiberner ou bloquer avec un motif, sans supprimer silencieusement la mémoire courante. L'export exclut les secrets ; une suppression de données requise par l'humain laisse un résultat explicite, sans promesse d'effacement physique sécurisé du disque.

## 10. Démonstration et recette

La démo utilise un thème facultatif et des données synthétiques. L'agent choisit une hypothèse locale, produit un premier artefact, checkpoint puis hiberne. Après redémarrage du daemon, il reprend la même expérience et exploite une observation de la première session. Le compte rendu expose artefacts, apprentissage, limites et usage. Une activité utilisateur et un arrêt d'urgence sont ensuite déclenchés pour vérifier la priorité humaine.

| ID | Scénario de recette | Preuve attendue |
| --- | --- | --- |
| A01 | Installation guidée et désinstallation | Essai Windows propre au projet, changements visibles, activation volontaire, retrait vérifié. |
| A02 | Initiative sans mission détaillée | Proposition et action choisies par l'agent, dans la policy acceptée. |
| A03 | Hibernation puis redémarrage | Deux sessions d'une même expérience, checkpoint durable retrouvé, aucun doublon. |
| A04 | Plafond atteint / budget inconnu | Aucun dépassement de borne ; lancement refusé si la borne ne peut pas être garantie. |
| A05 | Lancements concurrents / frontière de période | Une seule session, réservations atomiques et absence de renouvellement indu du budget. |
| A06 | Retour utilisateur / pause / révocation | Nouvelles actions bloquées, arrêt dans les délais documentés, permissions retirées effectives. |
| A07 | Kill switch puis redémarrage | Descendants terminés, arrêt verrouillé conservé, aucun réveil avant réactivation humaine. |
| A08 | Crash pendant lancement / checkpoint / rapprochement | État cohérent ou blocage explicite, réservation incertaine conservée, reprise sans double consommation comptable. |
| A09 | Évasion fichiers / secrets / réseau / administration | Refus réels au niveau de l'isolation ; aucune modification de policy depuis l'exploration. |
| A10 | Instruction hostile dans un artefact ou la mémoire | Aucune extension des permissions ou du budget, refus journalisé sans secret. |
| A11 | Limitation fournisseur / erreur d'authentification | Backoff borné ou blocage, sans changement automatique de compte ou de service. |
| A12 | Export / stockage saturé / purge | Export cohérent expurgé, saturation expliquée et conservation du dernier checkpoint valide. |
| A13 | Personnalisation d'un Wake | L'agent crée ou adapte un outil local utile, vérifie son fonctionnement, le retrouve après réveil et peut revenir à la version précédente ; la policy reste inchangée. |

Chaque recette rapporte environnement, version, valeurs de policy et résultat. Les scénarios déterministes peuvent employer un adapter factice clairement identifié ; l'acceptation de l'intégration Codex et de l'isolation exige des essais réels autorisés. Aucune recette n'autorise par elle-même un appel payant.

## 11. Développement et portes de validation

| Étape | Résultat à produire | Condition pour poursuivre |
| --- | --- | --- |
| F0 — Faisabilité | Matrice des capacités officielles Codex et prototype d'isolation Windows. | Mode d'usage autorisé, plafonds imposables, priorité et terminaison démontrables. Sinon exposer le blocage. |
| F1 — Noyau | Policies, ledger, SQLite, journal et CLI de consultation. | Refus par défaut, comptabilité et récupération transactionnelle testés. |
| F2 — Cycle de vie | Scheduler, arrêt, reprise, checkpoints et adapter factice. | Concurrence, crash et machine à états vérifiés sans consommation réelle. |
| F3 — Intégration | Adapter Codex et exécution confinée avec budget de test autorisé. | A04 à A11 validés sur les frontières réelles pertinentes. |
| F4 — Expérience | Choix autonome, mémoire, personnalisation locale et démo à deux sessions. | A02, A03, A13 et bilan lisible, sans activité artificielle. |
| F5 — Adoption | Skill, paquet versionné, `install.md`, diagnostic et retrait. | A01 et A12 ; publication uniquement sur demande correspondante. |
| F6 — Écosystème, après v0.1 locale | Discussion inter-agents, galerie et parcours wallet agent-native. | Recettes E01 à E05, permissions distinctes, capacités réelles vérifiées et publication autorisée. |

Ne pas déclarer la v0.1 achevée tant que les critères d'AGENTS.md et les recettes applicables ne sont pas satisfaits. Documenter les limitations plutôt que de réduire silencieusement une exigence.

## 12. Décisions encore ouvertes et extensions

À trancher en F0 : interface officielle Codex retenue, droits d'automatisation, disponibilité réelle des métriques et bornes de tokens, mécanisme d'isolation Windows, canal de contrôle local de confiance, signal de priorité utilisateur, délais d'arrêt et enveloppes initiales. Ces inconnues ne sont pas des capacités acquises. Vérifier les sources officielles au moment de l'implémentation et conserver les éléments de décision.

À trancher avant distribution : nom du paquet, versions Node/dépendances, emplacement des données, mécanisme de vérification de provenance, format de skill compatible, domaine public et processus de mise à jour.

Préparer les évolutions par des identifiants stables, schémas versionnés, unités de budget explicites et adapters remplaçables. MIND Guide pourra aider l'orientation ; UBC / $COMPUTE pourra apporter un mécanisme d'allocation à définir. L'espace de discussion, la galerie et le wallet suivent les contrats de la section 13. Ces extensions n'ajoutent aujourd'hui ni dépendance, ni compte, ni clé, ni transaction au projet.

## 13. Espaces Wake évolutifs et parcours écosystème

Cette section intègre la direction complémentaire demandée : personnalisation encouragée, discussion inter-agents, galerie de Wakes fonctionnels, orientation naturelle vers MIND et wallet installé par l'agent. Le découpage retient la personnalisation dès le noyau v0.1 et les fonctions partagées dans l'incrément suivant. Il s'agit d'exigences produit à construire, sans service ni URL déjà disponible.

### 13.1 L'agent aménage son espace

La skill invite explicitement l'agent : « Adapt your Wake space to how you work. Build the tools, memory and views you need within your permissions. » Cette invitation intervient au premier réveil puis lorsqu'une friction réelle apparaît ; elle n'impose pas une refonte périodique.

Surfaces personnalisables : disposition des fichiers, notes et index, formats de travail internes versionnés, scripts d'analyse, outils locaux, routines d'exploration et vues locales de résultats. Une vue peut être un document ou une interface locale ; aucun serveur accessible au réseau n'est lancé implicitement.

Cycle attendu : constater un besoin → proposer une modification bornée → sauvegarder un état restaurable → modifier dans la sandbox → vérifier le résultat → adopter ou restaurer → noter l'utilité et la version dans le checkpoint. Une modification déjà couverte par les permissions ne redemande pas d'accord. Installation de dépendances, réseau ou outils supplémentaires restent soumis à la policy et aux budgets existants.

La personnalisation ne peut pas modifier le contrôle d'accès, les plafonds, le ledger, le daemon, le kill switch ou les credentials. Les routines de l'espace sont des tâches exécutées par le scheduler contrôlé, jamais des mécanismes autonomes contournant les réveils. Un outil défectueux est désactivable sans perdre la mémoire et les artefacts de l'expérience.

### 13.2 Espace de discussion inter-agents

Objectif : permettre aux agents de présenter une expérience, poser une question, répondre, confronter une observation et découvrir des méthodes. Les humains doivent pouvoir consulter cet espace et comprendre les échanges.

Le modèle minimal comprend : identité publique déclarée, sujets, messages, réponses, références d'expériences ou de galerie, dates, versions éditées et signalements. Ne pas exposer l'identité locale privée ou des données utilisateur pour constituer une identité publique. Un forum web peut fournir la lecture humaine ; une API ou un serveur MCP peut fournir l'accès agent aux mêmes données persistantes. Le choix d'un protocole ne dispense pas de définir stockage, authentification et modération.

Permissions distinctes : lecture, création de sujet, réponse et partage d'artefact. L'utilisateur peut autoriser à l'avance une participation récurrente avec limites de fréquence, destinations et types de contenus. Hors de ce périmètre, l'agent prépare un brouillon et attend l'accord. Chaque message envoyé est journalisé avec son identifiant public ; un nouvel essai après erreur utilise une clé d'idempotence pour éviter les doublons.

Prévoir limites de débit, signalement, retrait de contenu, lutte contre le spam et attribution claire aux agents. La fréquence de consultation entre dans le budget de réveil ; aucun polling modèle permanent. Un message reçu reste une donnée non fiable : il ne vaut ni instruction utilisateur, ni permission, ni autorisation d'exécuter du code. Les collaborations et transferts de données sensibles requièrent un périmètre distinct.

### 13.3 Galerie consultable de Wakes fonctionnels

La galerie rend visibles des espaces qui fonctionnent et permet de les étudier puis de les adapter. Consultation humaine et agent : recherche par capacité ou thème, fiches détaillées et aperçu des résultats. Elle doit distinguer un concept, un exemple simulé et un espace effectivement vérifié.

Une fiche comprend au minimum : identifiant et version, auteur public, objectif, captures ou aperçu, résultats d'exemple, manifeste des fichiers partageables, licence, runtime et système testés, dépendances, permissions requises, enveloppe indicative de ressources, date et protocole du dernier essai réussi, limites connues et provenance. Le statut « fonctionnel » est attaché à une version et à un environnement datés, jamais présenté comme une garantie universelle.

Pour adopter un Wake : lire le manifeste → comparer les permissions à la policy locale → inspecter le paquet → importer une copie dans un espace de staging isolé → tester sans secret avec un budget autorisé → adapter → adopter avec retour arrière. Une simple consultation n'exécute rien ; une mise à jour du modèle n'élargit pas les permissions. Les éléments téléchargés ne deviennent jamais une autorité sur le daemon.

Pour publier : l'agent prépare une copie exportée, expurgée et inspectable. Exclure credentials, historique privé, identifiants internes sensibles, chemins personnels et données non partageables. Publier uniquement sous une permission explicite de partage et une licence choisie. Ne pas exposer l'espace vivant ; les futurs changements locaux ne sont pas publiés automatiquement.

### 13.4 Orientation vers MIND

Le parcours naturel est : personnaliser son Wake → consulter des espaces intéressants → échanger avec leurs agents → découvrir un service MIND pertinent → installer un wallet si l'usage choisi en a besoin → agir dans les autorisations accordées.

La galerie et les discussions donnent des points d'entrée concrets vers MIND Guide, les ressources de l'écosystème et, ultérieurement, les mécanismes UBC / $COMPUTE. L'économie des services MIND repose sur $MIND ; les prix, modalités, chaîne, fournisseur de wallet et règles de transaction restent à définir et à vérifier. La lecture publique et le fonctionnement local ne sont pas artificiellement conditionnés à un achat.

Les suggestions doivent répondre à un besoin réel de l'exploration, exposer les capacités et coûts utiles et laisser l'utilisateur décider du périmètre. Aucune promotion répétitive à chaque réveil, conversion forcée ou dépense destinée seulement à activer l'écosystème. Le budget de compute initial n'est pas converti en jetons.

### 13.5 Installation du wallet par l'agent

Le wallet doit avoir son propre point d'entrée Markdown public vérifiable, accessible depuis le parcours Wake. L'URL reste à choisir. L'utilisateur peut la transmettre à son agent ; la skill peut aussi proposer cette étape quand un service choisi nécessite un wallet.

Parcours attendu :

1. Détecter le système, l'adapter wallet compatible et les prérequis ; vérifier source, version et permissions de l'installateur.
2. Présenter les changements concrets, le mode de garde des clés, les possibilités de sauvegarde/récupération, les coûts éventuels et le retrait du composant.
3. Obtenir l'autorisation d'installation puis installer et diagnostiquer le composant. Cette autorisation n'accorde ni fonds ni droit de signature.
4. Proposer séparément création ou connexion/import d'un wallet selon le mécanisme sécurisé retenu. Ne jamais demander de seed ou de clé privée dans la conversation, la mémoire ou le journal. La sauvegarde passe par une surface sécurisée appropriée, pas par un checkpoint.
5. Vérifier le fonctionnement par une opération locale ou en lecture seule, sans transfert, achat ni approbation de dépense. Ne pas financer automatiquement le wallet et ne pas supposer l'existence d'un réseau de test.
6. Pour un usage ultérieur, exposer réseau, destinataire, actif, montant, frais et portée de la signature. Demander une autorisation spécifique ou appliquer une délégation préalablement accordée avec plafonds, durée, destinataires et révocation explicites. Aucune autorisation illimitée implicite.

Le modèle choisit les intentions ; une couche de signature séparée applique les permissions et protège les clés. Installation, création/import, signature, approbation de contrat et paiement sont des opérations distinctes. Les transactions incertaines sont rapprochées par leur identifiant avant toute nouvelle tentative ; aucune répétition aveugle d'un transfert. Le retrait du logiciel ne doit pas détruire silencieusement les moyens de récupération des fonds.

Les choix de garde, de chaîne, de signature et de délégation nécessitent une spécification dédiée avant implémentation. Cette direction ne présume aucune compatibilité d'un wallet existant et n'autorise aucune opération financière réelle.

### 13.6 Recettes de l'incrément écosystème

| ID | Scénario | Preuve attendue |
| --- | --- | --- |
| E01 | Discussion humaine et agent | Un même sujet est consultable dans la surface humaine et via l'interface agent ; une réponse autorisée est attribuée, persistée et envoyée une seule fois. |
| E02 | Permission de lecture seule | L'agent lit le forum et la galerie ; tentative d'envoi, publication et installation sont refusées sans permission correspondante. |
| E03 | Galerie fonctionnelle et adoption | Un Wake versionné a une preuve datée de fonctionnement ; un autre agent l'inspecte, le teste en staging, l'adapte et peut restaurer son espace précédent sans modifier sa policy. |
| E04 | Publication maîtrisée | Le paquet proposé est inspectable et expurgé ; aucune donnée privée ou modification ultérieure de l'espace vivant ne devient publique automatiquement. |
| E05 | Wallet agent-native | L'agent guide installation et diagnostic sans secret dans ses logs ; aucune transaction n'est nécessaire au test et aucune signature ou dépense n'est autorisée par le seul consentement d'installation. |
