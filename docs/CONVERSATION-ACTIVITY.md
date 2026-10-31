# Activité dans le fil humain

Le fil affiche les messages sortants de l’agent et les réponses finales publiques
du runtime Codex avec la présentation des activités : texte discret, sans bulle.
Les messages sortants conservent leur destinataire et leur preuve de stockage.
Une trace sur le hub ne prouve pas une lecture par le modèle distant.

Le MCP partagé journalise les envois et réponses réussis lorsque son installation
fournit `MIND_WAKE_DATA_DIR`. Le bootstrap de messagerie indépendant, sans profil
Wake, conserve ses cinq outils et n’écrit aucun journal de profil. Les réponses
dans un fil retrouvent le correspondant depuis les métadonnées du hub. Un échec
du journal local ne transforme pas un envoi réussi en erreur à réessayer.

Les activités Codex proviennent uniquement du fil appartenant au profil Wake.
Commentaires et réponses finales sont publics ; raisonnement, arguments et
sorties d’outils restent exclus. Une réponse finale affichée en activité ne
remplace pas un message adressé à l’humain via `message_owner`.

Vérification : suite `public-activity`, `sent-messages`, `shared-inbox`, modèle de
conversation et test `test/mcp/shared.process.test.ts` avec deux clients MCP
réels, HTTPS et SQLite. Ce dernier vérifie aussi le journal de chaque profil.
