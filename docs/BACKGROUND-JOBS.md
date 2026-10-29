# Travaux de fond supervisés

Un job est un programme Node local indépendant d'un tour de modèle. Il peut continuer quand un réveil finit et quand le panneau desktop est fermé. Le daemon reste son propriétaire : Pause, Force-off, révocation du mode hôte et arrêt du daemon terminent son arborescence Windows entière. Il n'y a pas de quota arbitraire de durée ou de nombre de tâches ajouté par ce mécanisme.

## Usage par l'agent

1. Écrire un script `.mjs` sous `jobs/` dans l'espace Wake. Son répertoire courant sera la racine de cet espace. Les arguments sont transmis directement, sans shell.
2. Appeler `start_background_job` avec `title`, `script` (par exemple `jobs/render.mjs`), `args` et une `idempotency_key` unique. Une nouvelle soumission identique avec la même clé retrouve le même job.
3. Le daemon prend les jobs en file. `queued` signifie enregistré, pas encore exécuté. `running` confirme que le processus a démarré. Les états terminaux sont `succeeded`, `failed`, `cancelled` et `interrupted`.
4. Consulter `list_background_jobs`. Écrire les résultats dans `process.env.MIND_WAKE_JOB_OUTPUT` ; `stdout.log` et `stderr.log` sont conservés dans `jobs/runs/<id>/`. `process.env.MIND_WAKE_JOB_ID` donne l'identifiant. `cancel_background_job` demande l'arrêt du job choisi.

Le statut faisant foi et les clés d'idempotence vivent dans `<dataDir>/background-jobs.sqlite`, hors de l'espace de travail. Les fins de jobs deviennent des événements du prochain réveil ; elles constituent aussi une échéance candidate pour le scheduler, qui conserve ses contrôles ordinaires. Les résultats restent consultables même si l'événement a déjà été présenté.

## Cycle de vie

Le daemon emploie le superviseur Job Object existant : le worker et tous ses descendants appartiennent à la même arborescence. La sortie brute va directement aux fichiers, sans s'accumuler dans le contexte du modèle. Les jobs continuent entre deux sessions ; l'absence de session IA active ne les arrête pas. Les contrôles persistés sont relus toutes les 500 ms. L'arrêt explicite d'un processus peut donc interrompre un fichier en cours d'écriture : les scripts longs doivent enregistrer leurs points de reprise et publier leurs résultats de façon atomique quand cela compte.

Après un crash du daemon, les anciennes arborescences sont terminées et les jobs en cours deviennent `interrupted`. Ils ne sont jamais rejoués automatiquement : une action interrompue a pu produire des effets. L'agent peut lire son checkpoint et soumettre explicitement une reprise avec une nouvelle clé. Les jobs encore en file restent en file.

## Périmètre

Cette première version fonctionne dans le mode hôte Windows déjà autorisé de Wake. Un Job Object assure la supervision et l'arrêt, pas une isolation du compte utilisateur. Aucun secret ni credential du daemon n'est implicitement hérité ; seules les variables système de démarrage, PATH et les chemins du job sont transmis. Cela ne retire pas les accès disque déjà accordés au compte Windows.

Ces outils sont exposés par le MCP local côté agent (`MIND_WAKE_BACKGROUND_JOBS=1`), puis vérifient la policy active et le consentement au mode hôte. Ils ne permettent pas de contourner les permissions, la pause, les limites fournisseur ni de lancer des dépenses ou des sessions IA supplémentaires sans délégation correspondante. Le mode AppContainer et une interface desktop dédiée aux jobs ne sont pas implémentés par cette version.
