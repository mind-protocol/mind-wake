# Messages re?us et destinataire du fil

`messages --json` expose `receivedMessages` s?par?ment des messages du propri?taire et des r?ponses humaines. Le desktop les intercale chronologiquement sans modifier le brouillon ni la logique existante de d?filement, pagination et liens de fichiers. Chaque re?u porte son canal, kind, r?f?rence, nom, fil, d?p?t/session disponibles, date et ?tat.

- `repo-session` : m?tadonn?es du registre `repo-conversations.jsonl`. Attribution enregistr?e, non authentifi?e. Une r?ponse repo n'est jamais une instruction humaine.
- `local-inbox` : entr?es hors du registre humain complet et hors des messages repo connus. Exp?diteur inconnu; aucun champ de leur corps JSON ne devient une identit? ou une destination de r?ponse.
- `mind-local-hub` : les r?ponses directes du hub ? `read_inbox` sont journalis?es par le pont MCP dans `received-messages.jsonl`. Identit? attest?e par ce hub, corps non fiable. Les envois `from_self` sont exclus. Ce miroir commence apr?s chargement du nouveau pont MCP; il ne pr?tend pas r?trospectivement archiver les anciens r?sultats d'outils.

`stock?` signifie une entr?e durable. `livr?` repo repose uniquement sur la r?ception confirm?e par l'inbox; pour le hub, la r?ponse a ?t? retourn?e par le canal MCP. Aucun ?tat ne pr?tend que le mod?le a lu ou compris. Les journaux ne contiennent ni cl?s, ni images jointes, ni r?sultats arbitraires d'outils. Les re?us sont d?dupliqu?s par identit? de canal. Les messages humains sont exclus sur tous les identifiants du registre, y compris hors des 200 derni?res r?ponses visibles.

Les notifications des sous-agents natifs du runtime ne disposent pas ici d'un ?v?nement durable attest? par l'application. Elles ne sont donc pas invent?es ni recopi?es depuis des logs priv?s du fournisseur. Les outils `read_inbox` des autres serveurs MCP ne sont pas intercept?s.

## Auroracle : pr?paration, sans route active

Le s?lecteur propose Mon agent et Auroracle (non raccord?). Choisir Auroracle conserve le brouillon et refuse l'envoi avant toute ?criture ou r?veil. Aucun miroir `NLR ? Auroracle:` n'est cr?? tant que le message ne poss?de pas une vraie destination; aucun succ?s distant n'est annonc?.

Pour raccorder : utiliser une identit? humaine NLR d?di?e, authentifi?e aupr?s du hub partag?, et une identit? destinataire Auroracle appair?e c?t? backend. La cl? demeure hors webview. Le backend doit cr?er un fil humain NLR ? agent Auroracle, garder ses IDs de message/fil et son mapping local. `reply_to_thread` doit reprendre ce fil v?rifi?, sans accepter un replyTo choisi dans le corps re?u. Le miroir local root doit porter le pr?fixe exact `NLR ? Auroracle:` et une enveloppe host distincte indiquant copie de contexte, auteur humain et destination Auroracle; il n'est pas un nouvel ordre adress? ? root. D?duplication et reprise doivent partager une cl? de corr?lation persistante entre envoi et miroir. Si seul un relais authentifi? agent est disponible, l'auteur humain est relay?/d?clar? et non authentifi? comme humain. Deux fils simultan?s, tentative de fil ?tranger et r?ponse corr?l?e doivent ?tre test?s avant activation.

Cette route et sa boucle de r?ponse restent ? impl?menter/valider apr?s appairage. Le s?lecteur pr?paratoire ne les simule pas.
