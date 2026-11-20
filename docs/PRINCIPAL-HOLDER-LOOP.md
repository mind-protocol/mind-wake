# Boucle principal puis holders

Le daemon exécute un passage du principal, attend sa fin, puis lance en parallèle tous les holders de sa room. Il attend la fin de tous ces passages avant de rendre la main au scheduler. Le réveil suivant reste soumis au mode Always-on ou planifié, à Pause, Force-off et aux contrôles habituels. Un principal échoué ou interrompu ne lance pas le passage des holders.

Le principal travaille sur ses fichiers de contexte et peut poursuivre ses actions de projet autorisées. Les échanges avec l'humain et les agents restent permis par les canaux autorisés disponibles. Sa réponse finale n'est plus exportée dans `principal-outputs.sqlite`, et les sorties finales déjà archivées (`principal-output:*`) ne sont jamais importées dans `90-fil.md` : le principal écrit lui-même dans le fil ce qui doit y rester. L'import du fil retire aussi le préambule « [Appel vocal en cours] … » des messages dictés en appel (il reste dans l'injection en direct) et ignore les notices « [Appel] 📞 … t'appelle ». Ses résultats utiles doivent être conservés dans les fichiers.

Chaque message importé porte sa source dans un commentaire invisible `<!-- source : <date> (<id>) -->` (les anciennes lignes « Source historique : … » restent lues). La date de dernière modification de chaque message est tenue dans `artifacts/principal/_editors/messages.json` (empreinte du texte par message) : l'interface place un message modifié à l'heure de sa modification.

Les holders intègrent leurs patterns et resserrent directement les conversations de `artifacts/principal/`. Ils peuvent aussi faire évoluer leurs propres conversations. Les éditions sont libres et concurrentes, sans verrou, fusion automatique ni contrainte ligne par ligne. Leurs sorties finales ne sont ni publiées, ni relayées au principal. Claude reçoit les outils Read/Edit/Write/Glob/Grep ; Codex reçoit les outils locaux en workspace-write. Aucun MCP de communication n'est exposé aux holders de ce passage.

## Messages humains pendant le passage

L'injection existante du principal est conservée. Juste avant le lancement des holders, le runtime importe les nouveaux apports arrivés pendant le tour du principal. Le corpus et les identifiants de départ proviennent du même relevé ; les vieux messages hors de la fenêtre de 200 tours ne sont pas rejoués comme des messages nouveaux.

Chaque holder dispose ensuite d'un suivi de réception indépendant pour son passage. Il lit les nouveaux messages humains sans consommer la file du principal ou celle d'un autre holder. Les copies de messages d'agents ne deviennent pas des consignes humaines. Cette réception demande d'appliquer les corrections aux fichiers.

Claude reçoit les nouveaux messages via les hooks SessionStart, PostToolUse, PostToolUseFailure et Stop. Le hook Stop retient la fin du passage lorsqu'un message tardif reste à prendre en compte. La remise a lieu à ces frontières ; elle n'interrompt pas instantanément une génération ou un outil bloquant. Seul le hook d'injection fourni par l'hôte est activé pour ce passage.

Codex vérifie les nouveaux messages toutes les 250 ms et les injecte par `turn/steer`. La réception n'est confirmée qu'après un accusé correspondant au tour encore actif. Un refus, une fin de tour ou un arrêt laisse le message non confirmé ; le corpus du prochain passage conserve la reprise. Une réception technique ne prouve pas que le modèle a compris le message.

## Conversations natives et attribution

Le dossier Markdown est reparsé à chaque réveil, avec reconnaissance des locuteurs. Le runtime injecte les tours natifs avant le déclencheur actuel. Claude utilise un transcript reconstruit ; Codex utilise `thread/inject_items`. Chaque agent reçoit ses propres paroles comme tours assistant, les autres comme tours user attribués. Les ajouts éditoriaux ne doivent pas être attribués à l'humain.

Au premier passage, les 200 derniers apports de l'ancien fil, bornés à 120 000 caractères, sont importés dans `90-fil.md`. `_imports.json` retient les identifiants déjà importés. Les réveils suivants ajoutent seulement les nouveaux messages humains : ils ne restaurent pas les passages que les holders ont resserrés ou supprimés. Les archives d'origine restent consultables, mais ne sont plus réinjectées à côté du corpus édité. Une modification ultérieure d'un ancien identifiant dans l'archive ne remplace donc pas l'édition du Markdown. Le corpus complet est borné à 240 000 caractères, sans troncature silencieuse.

## Réveils et périmètre

Les holders peuvent déposer des demandes JSON dans `wakeups/`, avec le champ `prompt` et une échéance conforme à `wakeups/schema/agent-wakeup.schema.json`. Ces demandes réveillent le principal, puis les holders après lui ; elles ne lancent pas un holder hors de la boucle. Chaque holder peut choisir un nom de fichier propre pour sa demande.

Le passage respecte l'interrupteur des pattern holders. Il sélectionne uniquement les holders déclarés `room: 1`. Une absence d’affectation ne vaut jamais appartenance à la room principale. NLR a retenu Critique, Mindset, Cockpit, Improver et Pattern Holder pour son installation. Le réveilleur historique n'est plus nécessaire pour sélectionner les destinataires et n'est pas lancé. Les holders affectés aux autres rooms ne sont pas lancés par cette boucle.

Le daemon ne démarre plus l'ancien service de polling des holders : les mentions, cadences et sorties du principal ne déclenchent plus de cascades autonomes via ce service. Les fonctions historiques restent disponibles pour les usages explicites hors de cette boucle. Les services de communication distincts (réponse rapide, appels, autres rooms) ne sont pas supprimés par ce changement.

Un échec de holder est journalisé et n'empêche pas les autres de terminer. Pause et Force-off interrompent aussi les appels fournisseur pendant le passage. L'attente des holders fait partie du cycle du scheduler ; elle n'est pas un verrou d'édition.

## Fil affiché

Le desktop et la passerelle mobile relisent le corpus Markdown sans le modifier. L'affichage conserve l'ordre des fichiers et des tours, les noms des locuteurs et les passages éditoriaux. Les anciens messages déjà importés ne sont pas affichés une seconde fois, même si leur passage Markdown a été supprimé. Seuls les nouveaux messages humains encore non importés restent visibles à la suite, dans leur ordre chronologique. Les publications séparées, notamment celles d’ouverture d’appel, ne sont pas ajoutées au corpus ni à cette projection. La date de l’import empêche les anciens messages hors de sa fenêtre de remonter à la fin du fil. Les anciennes publications de holders sont identifiées par leur provenance et masquées ; leurs ajouts aux conversations restent visibles. Les listes de tâches, prévisions de réveil, activités techniques et messages transférés des anciens flux sont masqués dans ce fil.

Le desktop actualise le fil toutes les cinq secondes lorsqu'il est visible ; le mobile utilise son polling long existant. Une édition remplace le contenu affiché ; les ajouts et suppressions sont également répercutés. Le desktop conserve les éléments DOM inchangés, le brouillon et l'ancrage de lecture, suit le bas du fil lorsque le lecteur s'y trouve et indique « modifié » sur les passages révisés pendant l'affichage. Les conversations éditables sont identifiées comme telles, sans attribuer une date inventée aux conversations-semence. En cas de lecture temporairement impossible, le fil précédent reste affiché avec une indication d'erreur.
