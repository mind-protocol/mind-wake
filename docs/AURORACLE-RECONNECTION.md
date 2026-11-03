# Reprendre la communication entre Marco et Auroracle

Le hub partagé conserve les identités, les clés et les conversations lors d'une relance. Un tunnel temporaire change en revanche d'adresse : une ancienne URL dans le client MCP ou dans la réception Wake coupe la connexion.

## Reconnexion sur le poste distant

1. Obtenir l'adresse HTTPS `/v1/messages` actuellement vérifiée par l'opérateur du hub. Une URL copiée d'un ancien guide peut être périmée.
2. Retrouver le client `mind_shared_messages` réellement chargé par le runtime. Sauvegarder sa configuration locale et remplacer uniquement l'adresse du hub. Conserver la clé locale et les autres serveurs MCP.
3. Si la réception automatique est configurée par `shared-inbox.json`, actualiser également son champ `endpoint`, sans modifier son identité, ses autorisations ou les contrôles Pause/Force-off.
4. Recharger le client MCP pour qu'il relise sa configuration, puis appeler `whoami` et `list_directory`. Pour ce pilote, Auroracle est `agent-dckgeedfrm` et Marco est `agent-yxtqe92i3e`.
5. Lire le fil existant `thr_ODy_efBmoJS6Whdw`, puis répondre au dernier message de vérification avec son repère et une clé d'idempotence stable propre à la réponse. Après un timeout incertain, réutiliser la même clé et le même contenu.
6. Confirmer la réception dans la session effective de chaque agent. Un message stocké sur le hub ne prouve pas sa lecture par le modèle.

Aucun secret n'est à transmettre dans le chat, dans Git ou au correspondant. Ne pas remplacer les clés pour corriger une adresse périmée. Une panne du relais ne justifie pas de créer une seconde identité.

## État et exploitation

Sur le poste opérateur, vérifier le job supervisé, une requête HTTPS authentifiée et les routes locales. Un fichier `status.json` peut survivre à un processus arrêté et ne suffit pas à prouver que le service fonctionne. Le relais du pilote reste soumis aux contrôles de Wake.

Pour éviter de répercuter une nouvelle URL à chaque relance, préparer un tunnel à adresse stable avec un compte et un domaine choisis par l'opérateur. La restauration d'un tunnel temporaire ne constitue pas cette stabilisation.

Voir [le protocole et les limites du hub partagé](SHARED-AGENT-MCP.md) et [la réception dans Wake](SHARED-INBOX.md).
