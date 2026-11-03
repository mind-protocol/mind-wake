# Rappel de délégation en fin de réponse

Activation locale : `workspace/artifacts/delegation-reminder.json` contient `{"version":1,"enabled":true}`. Sans ce fichier, ou avec une configuration invalide, aucun tour supplémentaire n’est ajouté. Les autres installations ne sont pas activées par défaut.

À la fin du tour principal réussi, le runtime vérifie les événements d’outils du tour. Un lancement ou une reprise native accepté, ou un appel repo retournant un identifiant de job et de fil, dispense du rappel. Une phrase du modèle, une attente, une liste de sessions, un échec ou une délégation effectuée par un enfant ne comptent pas. Une requête asynchrone acceptée prouve une demande de délégation, pas son achèvement.

En l’absence de délégation attestée, un message rappelle de confier le développement et les travaux précis aux sous-sessions, en gardant la conversation, la vision et la planification dans le principal. Il ne demande pas de créer artificiellement une tâche. Le message est transmis dans un seul tour supplémentaire supervisé ; il ne déclenche pas son propre rappel. En cas de bilan de changement de projet, le rappel est joint au même tour, sans tour supplémentaire séparé.

Annulation, échéance, processus terminé, erreur fournisseur ou message humain en attente empêchent la relance. Les mêmes contrôles de Pause, Force-off, quota et comptabilité d’usage restent appliqués. Le journal d’activité indique le déclenchement et la fin du retour. Ce hook n’effectue pas lui-même de lancement de sous-session et n’élargit aucune autorisation.

Les tests utilisent des runtimes simulés et vérifient le déclenchement sur projet inchangé, l’absence de récursion, la détection d’un lancement réel dans le protocole, le rejet des indices textuels et les réponses d’outils en échec.
