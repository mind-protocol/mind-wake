# Conversation spécialisée — utilisation et état

Le fil principal passe par six rôles : Expertise, Pattern, Contexte, Lead, Work et Commentary. Chaque appel fournisseur est neuf ; Wake reconstruit ses messages et conserve les conversations, les versions et les références.

## Dans le panneau

Ouvrir le fil puis utiliser **Activer les conversations** pour l’activation humaine initiale. Cette action arrête l’ancien moteur autonome par son propriétaire, confirme l’arrêt de ses processus et réévalue le profil consenti avant de lever un éventuel Force-off. Ouvrir le panneau, lire le fil ou envoyer un message en attente ne lève pas cet arrêt.

Un message lance le travail des spécialistes. Le Lead commence avec les éléments disponibles puis intègre leurs contributions. Work intervient lorsque la réponse contient une tâche technique. Commentary actualise un passage attribué dans le même message Lead ; son activité ne crée pas de messages séparés dans le fil principal.

Les onglets colorés ouvrent la conversation de chaque rôle. Le fil Lead garde les messages humains et sa réponse, avec les passages attribués à Commentary dans sa couleur. Un brouillon d’édition reste conservé lorsqu’on change d’onglet ou qu’un conflit de version survient.

Les messages humains et la réponse Lead sont modifiables pendant le travail. Enregistrer une modification crée une nouvelle révision ; les appels devenus inutiles sont annulés, leurs sorties restent consultables et ne remplacent pas la nouvelle demande. Les effets techniques déjà exécutés par Work restent signalés aux appels suivants.

La seconde passe produit une version améliorée des conversations. Les appels suivants sont reconstruits depuis cette version. Les éditions humaines restent protégées et les anciennes versions restent disponibles.

**Reprendre** reprend une conversation interrompue sans répéter un Work réussi. Un cycle achevé dont les données et instructions n’ont pas changé n’effectue pas de nouveaux appels modèle. **Arrêter** coupe le cycle ; Pause et Force-off restent les contrôles globaux du profil.

## Expertise et instructions réutilisables

Expertise conserve dans sa conversation les consignes réutilisables et leurs conditions d’application. Les entrées de référentiel gardent instruction, condition, portée, message humain source, version et citation exacte. Une entrée sans source humaine valide n’est pas acceptée comme instruction réutilisable.

Le premier hook déterministe mesure le document personnel. Au-delà de 10 000 caractères, il enregistre une tâche de consolidation pour cette version et fournit à Pattern le skill correspondant. Il ne tronque pas le document. L’intégration effective d’une règle dans un hook, une limite ou un processus reste un travail à exécuter et à vérifier.

## Journal des changements

Dans **Journal des changements**, inspecter les versions avant/après, la révision, le rôle, l’appel source et les raisons publiques déclarées. Les appels conservent les messages effectivement transmis, leur empreinte, la réponse publique brute, l’usage rapporté et les erreurs. Les sorties périmées ou invalides sont conservées sans être publiées.

Les changements et versions sont append-only. Le journal ne collecte pas le raisonnement privé du modèle et n’invente pas de motif lorsque l’humain a simplement édité un texte. Le [journal de développement](CHANGELOG-CONVERSATION.md) raconte séparément la construction et les corrections du code.

## Éditions d’un paragraphe

Une édition modèle du fil est validée avant publication : au plus un paragraphe modifié ou inséré sur l’ensemble du résultat d’appel. Les suppressions pures sont exemptées. Une édition refusée garde sa sortie brute et un diagnostic, sans être découpée pour contourner le contrôle.

Le même helper sait contrôler un chemin `.md` ou `.txt`, insensible à la casse, et laisse les autres extensions hors de cette règle. L’interception générale des écritures natives shell/CLI de Work sur ces fichiers n’est pas encore raccordée : l’existence du helper ne prouve pas cet enforcement externe. Les créations initiales et les éditions humaines ne sont pas soumises au plafond des éditions modèle.

## Runtime et limites actuelles

Codex et Claude utilisent leurs clients officiels et leurs capacités natives configurées. Le raccord actuel prend les profils hôte déjà consentis ; un profil qui exige une sandbox est refusé explicitement. Aucun repli vers une autre identité, un autre fournisseur ou une API payante n’est effectué.

Les processus d’une coopération appartiennent à un propriétaire et à un Job Object global ; chaque rôle garde son contrôle d’arrêt. Les essais Windows montrent que les jobs imbriqués peuvent dépasser transitoirement le plafond agrégé. La garde observe ce compte et arrête le groupe si le plafond est dépassé ou illisible ; les métadonnées `owner-control` exposent cette limite. Le plafond agrégé n’est donc pas présenté comme une borne noyau stricte sans dépassement.

La capture jointe du précédent parcours rapide point/image n’est pas encore raccordée au nouveau contrat. Elle est refusée avant publication avec conservation du brouillon ; aucun envoi de texte seul n’est présenté comme une capture jointe réussie. Les messages texte rapides utilisent le nouveau fil.

## CLI de diagnostic

Le panneau utilise `node dist/conversation/cli.js ACTION --data-dir PROFIL --json` avec un objet JSON sur stdin. Actions : `read`, `submit`, `edit`, `events`, `stop`, `resume`, `activate`. `activate` est une action humaine distincte et ne fait jamais partie de la lecture ou du polling.

Exemple d’entrée d’envoi : `{"conversationId":"main","text":"Message humain","idempotencyKey":"une-cle-stable"}`. Une nouvelle tentative conserve la même clé ; elle retrouve le même envoi.

Les essais contrôlés du coordinateur, des adapters, du stockage et des Job Objects sont isolés du profil installé. Ils vérifient les comportements du code, sans prouver la qualité d’une conversation avec un modèle réel. Le premier essai réel est à observer après activation humaine du nouveau panneau.
