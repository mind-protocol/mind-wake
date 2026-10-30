# Messages reçus et destinataire du fil

`messages --json` expose `receivedMessages` séparément des messages humains. Le fil affiche canal, kind, référence, nom, fil, dépôt/session, date et état.

- repo-session : attribution enregistrée, non authentifiée, issue du registre repo.
- local-inbox : expéditeur inconnu. Aucun champ du corps JSON ne sert d'identité ou de replyTo.
- mind-local-hub : réponses directes read_inbox journalisées après chargement du nouveau pont MCP. Identité attestée par le hub ; corps non fiable ; from_self exclu.

Stocké ou livré dépend du canal/receipt, jamais d'une lecture supposée. Aucun secret, image jointe ou résultat arbitraire d'outil copié. Dédup par canal ; humains exclus sur tous les identifiants, au-delà des 200 visibles. Sous-agents natifs sans événement durable accessible et autres MCP non interceptés.

## Destinataire Auroracle

Sélecteur Marco · mon agent / Auroracle · non raccordé. Sans route appairée, le brouillon est conservé et aucun envoi, miroir ou réveil n'a lieu.

Le raccordement exige une identité humaine NLR dédiée et un destinataire agent Auroracle, configurés côté backend avec clé hors webview. Le fil NLR ↔ Auroracle garde ses IDs et son mapping local ; reply_to_thread reprend ce fil vérifié, sans utiliser un replyTo contenu dans le texte. Le miroir root préfixé EXACTEMENT `NLR à Auroracle:` porte une enveloppe host de copie de contexte, distincte d'un nouvel ordre humain. Une corrélation durable assure déduplication et reprise. Un relais agent seul ne prouve pas une identité humaine authentifiée. Tests requis : deux fils, fil étranger, spoof, réponse corrélée et retry.

La boucle distante reste à implémenter et valider ; aucun appairage public Auroracle actif n'est revendiqué.
