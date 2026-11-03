---
name: planifier-wakes
description: Préparer ou réviser les prochains réveils de MIND Wake, leur projet, leurs intentions et leur contexte de reprise. À utiliser en début de bloc, si un plan manque ou devient périmé, lors d’un changement de direction ou pour demander une reprise à une échéance particulière. Ne pas charger pour simplement exécuter une étape déjà définie.
---

# Planifier les wakes

Le daemon déclenche les réveils ; tu prépares leur contenu. En Always-on, il relance après la session principale ; en mode planifié, le scheduler choisit l’échéance. Le plan ne lance pas de modèle et ne change ni les contrôles humains ni les limites fournisseur.

## Préparer ou revoir un bloc

1. Lire l’affectation fournie au réveil ; `get_next_wakes({"count":1})` permet de la retrouver et de vérifier si la rotation est active. Cette consultation ne réserve pas une série de sessions.
2. Pour le projet affecté, appeler `get_wake_project({"project_id":"<id>"})`. Reprendre ses sources, résultats, questions et décisions humaines récentes. Une trace `handoff.needsReview` demande une lecture des sources, pas l’invention d’un résumé.
3. Choisir le résultat recherché et l’incertitude qui mérite le prochain effort. Répartir recherches, expériences, choix et réalisations ; distinguer les missions déléguées du travail du principal. Prévoir une suite utile pendant les jobs, sans wakes d’attente obligatoires.
4. Avec la rotation active, appeler `plan_wake_block` avec `project_id` et `steps` : exactement dix objets `{wake, objective, expected}`, numérotés de 1 à 10. Le moteur insère l’intention du créneau dans son message. Le premier wake a déjà commencé : préparer surtout les suivants. Réviser les intentions restantes si une tâche prend plus de temps ; le compteur avance par session, pas par tâche achevée.
   Si l’affectation porte `passageId`, ajouter `passage_id` et `expected_revision` (révision obtenue par `get_next_wakes`). Reprendre la question, le résultat visé et les sources de ce passage dans le prompt ou `get_wake_project.passages`. Sans intentions propres, préparer explicitement le passage : ne jamais recycler le plan global du projet. En cas de conflit de révision, relire avant de réviser. Le contexte sauvegardé reste celui du projet, distinct du résultat visé du nouveau passage.
5. Appeler `save_wake_context` avec `project_id`, `summary`, `next_actions`, `open_questions`, `sources`. Conserver le résultat constaté et la prochaine action avant un changement de projet ou la fin du bloc. Un plan et un résumé de reprise ont deux rôles distincts.

Si la direction humaine change ou si le résultat attendu n’a plus de sens, revenir à la question décisive avant de détailler le plan. Un blocage réel se note avec `set_wake_project_status({"project_id":"<id>","status":"blocked","reason":"cause et condition de reprise"})` ; poursuivre un autre travail disponible. Ne pas réactiver un projet en pause pour remplir le planning.

## Choisir le bon mécanisme

- **Rotation active :** utiliser le plan et le contexte du gestionnaire. Ses blocs font dix wakes et ses journées logiques cinquante ; ce ne sont pas des quotas quotidiens. `configure_wake_rotation` modifie ce réglage, pas l’activation de Wake : ne pas l’appeler pour simplement préparer la suite.
- **Nouveau projet :** travailler dans `artifacts/projets/<id>/`, relier les livrables au README et enregistrer le projet dans le registre existant. Vérifier le contrat de l’outil local avant écriture ; l’affectation du prochain créneau reste celle du gestionnaire.
- **Ancien plan Étapes :** le champ `projects[id].etapes` du registre peut encore alimenter `nextWakeStep`. Vérifier ce qui est effectivement utilisé ; ne pas créer un second plan contradictoire ni inventer son schéma.
- **Reprise à un événement ou une date :** lire `wakeups/schema/agent-wakeup.schema.json` dans le workspace, puis déposer un JSON valide dans `wakeups/`. `when` accepte une date `at`, un délai `afterHours`, un changement `fileChanged` ou `quotaResetWithinHours` ; `prompt` porte une courte note à soi-même. Le délai part de la première détection, ou du dernier service pour une répétition. Une demande ne met pas Always-on en attente et ne lève pas une pause. Les fins de jobs fournissent déjà leurs événements de reprise.

Le registre, les contextes et les fichiers du projet portent l’état ; ce skill porte uniquement la procédure. Terminer la planification lorsque la prochaine étape, le résultat attendu et la reprise sont enregistrés. Retourner au travail au lieu de relire la méthode à chaque wake. Consulter le skill de révision du système prompt seulement si le problème porte sur l’organisation ou le chargement du dispositif lui-même.
