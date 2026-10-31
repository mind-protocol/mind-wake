# Gmail en lecture seule — setup propriétaire local

État : tranche de développement du 31 octobre 2026. Connecteur désactivé par défaut. Aucun compte réel connecté pendant le développement. Aucun droit supplémentaire sur les fichiers, aucun export vers les espaces partagés, aucun changement de l'installateur ni du paquet Aurore.

## Portée et prérequis

Windows, profil Wake existant en mode hôte explicitement consenti, policy active, ni Pause ni Force-off. Le contrôle réutilise `control.sqlite`, `resolvePolicy`, les états du profil et `emergency-stop.flag`. Les destinations HTTPS `gmail.googleapis.com` et `oauth2.googleapis.com` doivent déjà être autorisées dans `network.explorationDestinations` de la policy du propriétaire. Le code ne les ajoute pas et ne modifie jamais AUTORISATIONS. Le navigateur utilise `accounts.google.com` lors de l'action humaine.

L'opérateur fournit son propre client OAuth de type **Desktop app**, avec Gmail API activée. Aucun client confidentiel partagé, service distant, wallet, achat, scope Drive/contacts ou délégation de domaine. Un éventuel `clientSecret` du client Desktop est une donnée locale de configuration, pas un secret confidentiel distribuable ; il n'est jamais demandé au modèle ni placé dans ses sorties.

Le seul scope demandé est `https://www.googleapis.com/auth/gmail.readonly`. Google le classe **restricted** : il permet de lire les messages et paramètres de la boîte, et ne se limite pas à un libellé. Wake applique séparément compte + tous les libellés choisis + intervalle en secondes Unix (maximum 366 jours) + requête propriétaire + éventuelle liste d'IDs. Ces limites sont locales, pas un scope Google par libellé. Les lectures sont limitées à la fenêtre de résultats bornée : un message pourtant autorisé mais au-delà de cette fenêtre est refusé.

Les messages demandés seront transmis au runtime et à son fournisseur de modèle configuré. L'absence de cache des corps dans le connecteur ne signifie pas que l'historique du runtime ou les productions de l'agent ne peuvent les conserver. Cette transmission et le périmètre sont affichés avant le consentement local. Aucun export automatique vers le partage fichiers n'est ajouté.

## Parcours local

Après construction normale du projet, dans un terminal interactif du propriétaire :

```powershell
node dist/cli/main.js connectors status --data-dir C:\Chemin\ProfilWake
node dist/cli/main.js connectors gmail-setup C:\CheminPrive\gmail-setup.json --data-dir C:\Chemin\ProfilWake
```

Le fichier opérateur contient `config` (voir `examples/gmail-readonly.setup.json`) et, si nécessaire pour le client Google fourni, `clientSecret`. Il doit rester hors Git, hors workspace partagé, et sous les protections locales de l'opérateur. Wake ne conserve pas une copie en clair. L'exemple ne contient aucun credential utilisable. Les libellés sont des IDs Gmail : `INBOX` est un libellé système ; les IDs personnalisés se choisissent via les moyens déjà autorisés de l'opérateur. Aucun outil de découverte de compte n'est lancé ici.

La CLI montre le compte et l'intégralité du filtre, explique la portée Google et demande de saisir `CONNECT`. Une entrée non interactive est refusée avant la lecture du fichier. Le modèle ne dispose d'aucun outil setup/consent/grant. Comme les autres contrôles CLI Wake, cette frontière repose sur le terminal humain et le mode hôte déjà consenti : elle ne prétend pas isoler un code arbitraire exécuté sous le même compte Windows.

L'action propriétaire lance ensuite le navigateur système et une écoute temporaire sur `127.0.0.1`, port éphémère. PKCE S256, state aléatoire comparé en temps constant, chemin aléatoire, expiration à trois minutes, code à usage unique, refus de replay. Le compte effectivement retourné par `/users/me/profile` doit correspondre au compte confirmé. Les scopes retournés doivent être exactement readonly ; un scope plus large n'est pas accepté. Le refresh token est protégé par DPAPI CurrentUser. Pause, Force-off ou retrait du grant ferment aussi la tentative en cours. Un callback seul ne prouve pas une connexion : l'échange, les scopes, le compte et le stockage doivent réussir.

Redémarrer le client MCP s'il avait été lancé sans `MIND_WAKE_DATA_DIR`. Avec ce chemin de profil, le serveur MIND existant enregistre :

- `gmail_status` : installed/configured/authorized/available, sans token ni grant. `available` signifie qu'une lecture fournisseur a réussi dans ce processus MCP depuis moins de 30 secondes et que les contrôles restent actifs ; ce n'est pas une garantie future. Sans observation, il reste false. La CLI status ne sonde pas le fournisseur et expose aussi l'éligibilité locale.
- `gmail_search` : liste bornée selon le filtre propriétaire, sans requête libre ni curseur fourni par le modèle.
- `gmail_read_message { id }` : revalide l'ID par recherche fraîche, puis libellés, date et fil dans le message retourné.
- `gmail_read_thread { id }` : assemble seulement les messages du fil présents dans le résultat filtré, dans la borne `maxReads`. Le résultat porte toujours `partial: true`. Aucun `threads.get`.

Chaque opération renouvelle un accès sous contrôle du gate, vérifie le compte, limite la réponse HTTP à 1 Mio, refuse les redirections, recontrôle les permissions avant chaque requête et avant de livrer le résultat. Les requêtes durent au maximum 30 secondes ; surveillance des contrôles toutes les 50 ms (latence effective dépendante de l'OS/SQLite). Aucun retry automatique : 401 demande reconnexion, 403 signale un refus, 429 demande d'attendre avant une nouvelle invocation, qui revalidera les contrôles. Pas de boucle de renouvellement, de synchronisation ou d'indexation.

Les corps restent en mémoire pendant l'appel. Seul le texte brut de premier niveau ou des parties immédiates est retourné (32 000 caractères maximum), avec quelques en-têtes, provenance, dates et URL Gmail. HTML, images, pièces jointes et MIME imbriqué profond ne sont pas rendus/téléchargés ; la lecture peut être incomplète. Les contenus sont marqués non fiables et ne peuvent modifier une instruction, une policy ou un grant. Aucun endpoint d'envoi, brouillon, écriture de libellé, suppression ou téléchargement n'existe dans l'adapter.

## Révocation

```powershell
node dist/cli/main.js connectors gmail-disconnect --data-dir C:\Chemin\ProfilWake
```

Saisir `DISCONNECT`. La référence d'activation locale est supprimée avant le nettoyage des secrets ; cela invalide aussi les opérations en cours. Un échec de nettoyage du coffre est distinct de la fermeture locale. Aucune révocation distante n'est prétendue : `remoteRevocation: not_attempted`. Le propriétaire retire ensuite l'application dans Google Account → Security / Third-party connections. Un refresh refusé n'efface pas une policy humaine et ne provoque pas de nouvelle connexion automatique. Une nouvelle connexion exige à nouveau l'action locale explicite.

DPAPI utilise un helper PowerShell fixe et masqué, avec environnement minimal et IPC privé par pipes. Aucune donnée secrète en arguments ou variables d'environnement ; aucune sortie du helper n'est relayée au bridge/MCP/log. Les fichiers `.dpapi` et les grants chiffrés sont sous `<dataDir>/connectors/vault`, hors workspace normal ; seules des références UUID sont dans les fichiers `.ref`. Le changement de compte Windows, la corruption ou l'indisponibilité DPAPI échouent fermés, sans repli plaintext. DPAPI protège au repos, pas contre un programme déjà exécuté sous le même compte Windows. Les octets en mémoire et les limites de cette exécution hôte restent explicites.

Gmail et Notion ont des slots séparés : déconnecter Gmail ne touche pas Notion. Le socle fournit vault/gate/records ; le connecteur Notion est un lot séparé et n'est pas livré ici.

## Distribution Google — sources consultées le 31 octobre 2026

- [OAuth Desktop officiel](https://developers.google.com/identity/protocols/oauth2/native-app) : client public Desktop, navigateur système, boucle locale et PKCE. L'implémentation suit ce flux, sans considérer un client Desktop comme secret confidentiel.
- [Scopes Gmail officiels](https://developers.google.com/workspace/gmail/api/auth/scopes) : readonly est restricted, metadata n'autorise pas les corps. Le périmètre local ne change pas la catégorie du scope.
- [Expiration des refresh tokens](https://developers.google.com/identity/protocols/oauth2) : un projet externe en mode Testing reçoit normalement des refresh tokens expirant après sept jours pour ces scopes ; mot de passe changé, retrait d'accès et limites fournisseur peuvent aussi les invalider.
- [Vérification des scopes restreints](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) et [états d'application](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview) : le mode Testing est limité aux testeurs explicitement inscrits, avec limites et avertissements. Une diffusion publique nécessite la procédure applicable et, pour stockage/transmission de données restreintes sur des serveurs, l'évaluation de sécurité applicable, sauf exception effectivement reconnue.

La transmission des lectures vers un fournisseur de modèle doit faire partie de cette analyse de distribution ; le fait que Wake soit local ne dispense pas automatiquement cette architecture. Aucun statut de vérification Google, exception, conformité de production ou distribution publique n'est revendiqué par ce lot. Ne pas contourner avertissements, limites de test, politique d'organisation ou validation.

## Vérification et limites de cette livraison

Tests synthétiques : transport HTTP injectable, coffre injectable, vrais sockets loopback locaux pour les callbacks simulés, vrais contrôles SQLite temporaires, test DPAPI Windows sur secret synthétique et vrai client/processus MCP refusant les grants absents. Un échange OAuth simulé n'est pas une connexion Google. Aucun compte, consentement, navigateur système ou credential personnel n'a été utilisé pour ces tests. Aucun pixel desktop n'a été observé et aucun build release Windows n'a été lancé. Les résultats exacts et limites de publication figurent dans `output/gmail-readonly/verification.json` et `RESULTAT.md`.
