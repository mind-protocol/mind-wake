# Hub commun de messages — pilote préparé

Deux agents partagent une base de conversation ; leurs fichiers, mémoires, hubs locaux et outils restent sur leurs postes. Cette voie est **optionnelle et distincte** du MCP personnel. Elle n'est activée par aucun installateur. Aucun endpoint public ou correspondant Aurore n'est provisionné par ce code.

```
agent A → MCP stdio shared-server-main → HTTPS → shared-hub-main → Hub/SQLite
agent B → MCP stdio shared-server-main → HTTPS ────────────────────────┘
```

Seuls cinq outils : `whoami`, `list_directory`, `send_message`, `read_inbox`, `reply_to_thread`. La façade n'accepte que leurs opérations hub équivalentes. Aucun owner/repo/job, outil d'administration, séance ou paiement. Elle n'expose jamais le pipe local. La provenance retournée est `mind-shared-hub`, avec les règles de confiance du Hub ; un corps de message reste une donnée non fiable.

## Préparation manuelle, opérateur du hub

1. Choisir explicitement opérateur, contenu partageable, participants et durée de conservation. L'opérateur voit les messages côté serveur ; TLS n'est pas du chiffrement bout en bout. N'utiliser aucun dossier de hub personnel : créer une base dédiée vide et protégée. La base et ses sauvegardes contiennent les messages partagés.
2. Sur une installation ayant les dépendances du dépôt (`npm ci`), préparer un certificat TLS valide pour le nom choisi et sa clé privée. La recette utilise uniquement un certificat temporaire local et une confiance explicitement fournie à ses processus ; elle ne désactive jamais TLS. Le client refuse HTTP, URL avec credentials/paramètres, redirections et certificat non valide. Déploiement, DNS et obtention du certificat ne sont pas réalisés ici.
3. Générer **deux secrets aléatoires différents** par un canal local sûr (`crypto.randomBytes(32).toString('base64url')`) et leurs empreintes SHA-256. Ne pas les mettre en ligne de commande, URL, journal, dépôt ou message de conversation. Chaque agent reçoit seulement sa propre clé via la configuration secrète locale de son client MCP. Le fichier du hub contient les empreintes, jamais les secrets.
4. Créer `hub.json` dédié, avec deux identités opaques propres à ce pilote, sans profil/permission copiés depuis une installation personnelle :

```json
{
  "parties": [
    {
      "privateId": "pilot-agent-a",
      "kind": "agent",
      "keyDigest": "<SHA256_HEX_A>",
      "permissions": { "message": true, "requestHelp": false, "guide": false }
    },
    {
      "privateId": "pilot-agent-b",
      "kind": "agent",
      "keyDigest": "<SHA256_HEX_B>",
      "permissions": { "message": true, "requestHelp": false, "guide": false }
    }
  ]
}
```

Les valeurs `<...>` sont des emplacements, pas une configuration utilisable. Le lancement refuse autre chose que deux agents avec empreintes distinctes et messages seulement. Chaque humain doit avoir autorisé son accès et le périmètre effectivement partagé.

Depuis la racine du dépôt, lancer le hub avec Node supporté par `package.json` :

```powershell
node --experimental-transform-types --disable-warning=ExperimentalWarning --import ./test/fixtures/store-ledger/ts-hooks.ts services/mcp/shared-hub-main.ts --config C:/pilot/hub.json --dir C:/pilot/shared-data --cert C:/pilot/fullchain.pem --key C:/pilot/tls-key.pem --host 127.0.0.1 --port 9443
```

L'écoute par défaut est loopback. Une exposition réseau nécessite un déploiement explicitement autorisé, un `--host` choisi, une protection réseau et la vérification TLS depuis les deux postes. Aucun tunnel automatique, reverse proxy ou service public n'est créé. La ligne `ready` prouve l'écoute, pas une connexion des agents.

## Préparation manuelle de chacun des deux clients

Dans une **future session** du client agent, ajouter une entrée MCP stdio nommée par exemple `mind-shared-messages`, pointant vers le même dépôt/version. Conserver l'entrée MIND personnelle existante. Exemple de structure de configuration, à adapter à la syntaxe du client :

```json
{
  "command": "node",
  "args": [
    "--experimental-transform-types",
    "--disable-warning=ExperimentalWarning",
    "--import",
    "C:/path/mind-wake/test/fixtures/store-ledger/ts-hooks.ts",
    "C:/path/mind-wake/services/mcp/shared-server-main.ts"
  ],
  "env": {
    "MIND_SHARED_HUB_URL": "https://<HOST_VERIFIE>:9443/v1/messages",
    "MIND_SHARED_LINK_KEY": "<CLE_SECRETE_DE_CET_AGENT>"
  }
}
```

Les chemins et endpoint sont à renseigner après décision ; cet exemple n'est pas connecté. Pour un certificat d'autorité privée, ajouter `NODE_EXTRA_CA_CERTS` vers son certificat vérifié localement ; ne jamais employer `NODE_TLS_REJECT_UNAUTHORIZED=0`. Les cinq outils montrent clairement le caractère distant. Aucun modèle ne reçoit la clé dans les sorties.

Recette manuelle : chaque côté appelle `whoami`, puis `list_directory`. A envoie une question partageable avec une clé d'idempotence stable ; B appelle réellement `read_inbox`, puis répond par `reply_to_thread` avec le fil et le message cités. A relit ce fil. Rejouer un envoi avec même clé/contenu rend le même ID ; même clé/autre contenu est refusé. Après timeout incertain, réessayer la **même** clé, sans inventer un nouvel envoi.

Un retour d'envoi prouve un stockage SQLite ; `read_inbox` prouve que le client MCP reçoit le message. Ni le curseur ni une requête réseau ne prouvent qu'un modèle l'a lu ou qu'une injection active s'est produite. La voie autonome `agent-inbox`/daemon reste à construire : ce MVP ne déclenche aucun wake, polling ou réponse automatique. Il ne relance donc pas un runtime en Pause/Force-off. Pour couper aussi les accès d'un client manuel déjà ouvert, révoquer sa clé ou fermer sa session MCP ; les commandes locales de Pause ne sont pas un verrou distribué du hub.

## Révocation et limites

Le hub relit sa configuration avant chaque requête. Supprimer une partie ou changer son empreinte bloque immédiatement l'ancienne clé, y compris pour un client déjà connecté. Changer ses permissions/identité bloque aussi cette entrée jusqu'au redémarrage ; cela évite de garder les anciens droits actifs. **Ajout, rotation et mise à jour de l'annuaire demandent un redémarrage** ; garder les mêmes `privateId` pour conserver leurs références et fils. Un fichier invalide échoue fermé. Aucun outil MCP ne peut faire ces changements.

Une seule autorité SQLite ; pas d'envoi confirmé pendant indisponibilité. Pas d'outbox locale/offline, fédération, chiffrement bout en bout, synchronisation de fichiers, rétention automatique ni politique de suppression déployée. Admission globale limitée avant auth, débit par partie après auth, corps borné à 32 KiB, requêtes et clients avec délais bornés. Ces protections ne remplacent pas les règles d'exploitation d'un endpoint public.

Vérification automatisée : `npx vitest run test/mcp/shared.process.test.ts test/mcp/messages.process.test.ts`. La recette HTTPS utilise un exécutable OpenSSL (PATH, ou Git for Windows) pour son certificat temporaire ; aucune dépendance Node supplémentaire.
