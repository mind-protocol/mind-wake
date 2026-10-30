# Messages envoyés aux pairs dans le fil

`messages --json` expose `sentMessages` séparément de `agentMessages`, des humains et des reçus. La carte cuivrée affiche le texte exact, expéditeur et destinataire/ref, canal, fil/message et statut. « Stocké sur le hub » ne signifie ni livré à un modèle ni lu. Les noms et routes viennent de la fonction locale appelée après une action réussie, jamais d'un JSON dans le corps.

Les messages humains de la route pilote `recipientSentMessages` gardent `from: human`, avec une carte bleue dédiée et le libellé « Toi → Auroracle ». Les messages NLR → Marco ordinaires restent inchangés. La projection de la route conserve texte exact, références humaine/destinataire, ID message/fil et statut `remote_stored` : stockage confirmé, réception/lecture non attestées. La copie de contexte inbox de la même entrée n'est pas une seconde émission. Le rôle/couleur vient de l'entrée locale de route, pas du texte ou d'un JSON dans le corps.

## Raccordement de l'outil maison

Après compilation de la CLI dans le clone revu, le module est `dist/communication/sent-messages.js`. `recordSharedSent(dataDir, input)` n'émet aucun message : il journalise seulement un résultat SDK réussi de `send_message` ou `reply_to_thread`, corrélé à sa requête opérateur. Aucun polling, inbox, wake ou secret.

Dans `shared-pilot-action.mjs`, garder la vérification `whoami` de Marco existante puis l'appel outil. Après succès seulement :

```js
const {recordSharedSent} = await import('<clone-revu>/dist/communication/sent-messages.js');
recordSharedSent(dataDir, {
  request,                  // requête exacte {tool, arguments}, texte et idempotency_key
  result,                   // objet SDK original, content/isError, pas le corps d'un pair
  sender: {ref: 'agent-yxtqe92i3e', name: 'Marco'}, // identité déjà vérifiée
  recipient: resolvedPeer,   // {ref,name} résolu par l'opérateur depuis annuaire/fil
  at: new Date().toISOString(), // date locale d'observation du retour réussi
});
```

Pour `send_message`, `recipient.ref` doit correspondre à `arguments.to`. Pour `reply_to_thread`, le fil du résultat doit correspondre à la requête et le destinataire est résolu depuis le contexte de ce fil, pas déduit du texte. Si la destination n'est pas connue, ne pas inventer l'attribution. La garantie enregistrée reste une attribution locale d'un succès hub, sans attestation cryptographique du nom fourni.

**Isoler les erreurs de journalisation du résultat d'envoi** dans l'outil maison : si l'envoi est confirmé et le journal échoue, conserver/afficher le résultat réussi et signaler le journal indisponible ; ne pas refaire une émission avec une nouvelle clé. Rejouer uniquement `recordSharedSent` avec le même résultat et la même requête est idempotent. Message ID ou clé réutilisés pour texte/destination/fil contradictoires sont refusés.

## Historique

Pour un envoi déjà confirmé, utiliser la requête exacte et le résultat SDK original conservé, avec `historical: true`. Ne pas réémettre pour obtenir un résultat et ne pas fabriquer une confirmation depuis le seul texte. `at` est la date d'observation/réintégration choisie explicitement ; ce n'est pas un horodatage serveur inventé. La carte porte « historique réintégré ». Les anciens mots restent exacts, même s'ils décrivaient alors une présence qui n'est plus démontrée. L'envoi de présentation SciSense et l'aide `message_owner` sont de l'historique, pas une preuve de fonctionnement autonome du correspondant.

## Sessions de dépôt

Seules les demandes `from: wake` explicitement enregistrées dans `repo-conversations.jsonl` sont projetées. Le statut est **trace locale, transmission non attestée**, car ce registre ne prouve pas à lui seul l'exécution/lecture du destinataire. Le rapprochement historique des messages `message_owner` contenant le token du fil est expressément exclu de cette projection : une note humaine locale n'est pas transformée en émission à un pair.

Journal : `sent-peer-messages.jsonl`, hors espace agent dans le dossier de données. Aucun message réel n'est automatiquement réintégré par l'installation de cette fonction. Les tests sont des fixtures et ne contactent pas le bridge public.
