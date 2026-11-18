# Travaux de fond supervisés

Un job est un programme Node local indépendant d'un tour de modèle. Il peut continuer quand un réveil finit et quand le panneau desktop est fermé. Le daemon reste son propriétaire : Pause, Force-off, révocation du mode hôte et arrêt du daemon terminent son arborescence Windows entière. Il n'y a pas de quota arbitraire de durée ou de nombre de tâches ajouté par ce mécanisme.

## Usage par l'agent

1. Écrire un script `.mjs` sous `jobs/` dans l'espace Wake. Son répertoire courant sera la racine de cet espace. Les arguments sont transmis directement, sans shell.
2. Appeler `start_background_job` avec `title`, `script` (par exemple `jobs/render.mjs`), `args` et une `idempotency_key` unique. Une nouvelle soumission identique avec la même clé retrouve le même job.
3. Le daemon prend les jobs en file. `queued` signifie enregistré, pas encore exécuté. `running` confirme que le processus a démarré. Les états terminaux sont `succeeded`, `failed`, `cancelled` et `interrupted`.
4. Consulter `list_background_jobs`. Écrire les résultats dans `process.env.MIND_WAKE_JOB_OUTPUT` ; `stdout.log` et `stderr.log` sont conservés dans `jobs/runs/<id>/`. `process.env.MIND_WAKE_JOB_ID` donne l'identifiant. `cancel_background_job` demande l'arrêt du job choisi.

Le statut faisant foi et les clés d'idempotence vivent dans `<dataDir>/background-jobs.sqlite`, hors de l'espace de travail. Les fins de jobs deviennent des événements du prochain réveil ; elles constituent aussi une échéance candidate pour le scheduler, qui conserve ses contrôles ordinaires. Les résultats restent consultables même si l'événement a déjà été présenté.

## Origine automatique

Constat de Viz (18 nov. 2026) : seuls 9 jobs sur 615 étaient reliés au message qui les avait lancés. Depuis, chaque `start_background_job` enregistre une origine dans le job, sans que l'agent ait à la fournir (`src/daemon/job-origin.ts`). Le serveur MCP la calcule à partir de l'environnement que le daemon lui a donné, jamais à partir des arguments de l'agent :

- `launcher.kind` : `principal`, `room-agent` (avec `agentId` ; `agentId: null` pour le canal d'une salle, par exemple VOX) ou `holder` (`MIND_WAKE_PATTERN_HOLDER` ; aucun holder n'a encore l'outil) ;
- `room` (`room:<N>`) et `roomNumber` ;
- `session` : `MIND_WAKE_SESSION`, c'est-à-dire la session Wake du principal ou la session Claude du tour de salle ;
- `trigger` : `basis: "turn"` quand le daemon a transmis le message du tour (salles à agents : `room<N>:entry:<id>` ou `room<N>:relay:<clé>`) ; pour le principal, `basis: "last-delivered"`, le dernier message humain ou pair remis par `owner-inbox.sqlite`. C'est une approximation : un réveil sans message garde le précédent, donc il faut comparer `deliveredAt` à `createdAt` ;
- `parent`, `rootJobId` : si le serveur MCP tourne dans un job (`MIND_WAKE_JOB_ID` hérité), il s'agit du job parent et du premier job de la chaîne. La salle du parent est reprise si la session n'en a pas ;
- `declared` : `why` et `trigger_message_id`, s'ils sont fournis par l'agent (tous deux facultatifs). Ils sont gardés à part et l'origine automatique n'en dépend pas.

L'origine est exposée dans `list_background_jobs` (champ `origin` de chaque job) et dans `jobs/runs/<id>/job.json`, écrit dès la soumission. Elle est aussi passée au script : `MIND_WAKE_JOB_ORIGIN_AUTO` la reçoit toujours, et `MIND_WAKE_JOB_ORIGIN` seulement quand le lanceur n'est pas le principal. Pour les scripts existants (`jobs/atelier-worker-claude.mjs`), l'absence de cette variable signifie déjà « agent principal ». `jobs/vox-sous-session.mjs` continue d'écrire son propre `origin.json` et de poser `MIND_WAKE_JOB_ORIGIN` pour son enfant. Une relance (`relaunch`) garde l'origine du job relancé. Les jobs antérieurs n'ont pas d'origine.

## Cycle de vie

Le daemon emploie le superviseur Job Object existant : le worker et tous ses descendants appartiennent à la même arborescence. La sortie brute va directement aux fichiers, sans s'accumuler dans le contexte du modèle. Les jobs continuent entre deux sessions ; l'absence de session IA active ne les arrête pas. Les contrôles persistés sont relus toutes les 500 ms. L'arrêt explicite d'un processus peut donc interrompre un fichier en cours d'écriture : les scripts longs doivent enregistrer leurs points de reprise et publier leurs résultats de façon atomique quand cela compte.

Après un crash du daemon, les anciennes arborescences sont terminées et les jobs en cours deviennent `interrupted`. Ils ne sont jamais rejoués automatiquement : une action interrompue a pu produire des effets. L'agent peut lire son checkpoint et soumettre explicitement une reprise avec une nouvelle clé. Les jobs encore en file restent en file.

### Boucles longues : `relaunch`

Exception opt-in pour les boucles longues, comme une simulation ou une présence dans le fil : `start_background_job` accepte `relaunch: true`. Un tel job interrompu par une Pause, un Force-off ou la fin du moteur est soumis de nouveau, avec le même script et les mêmes arguments, dès que Wake l'autorise de nouveau. Pour un Force-off, c'est donc après la réactivation par l'humain. Le nouveau job reçoit la clé `relaunch:<ancien id>`, et l'ancien garde `relaunchedAs`. Un job qui échoue, qu'on annule ou qui finit normalement n'est jamais relancé. Le daemon journalise chaque relance (`job relancé après interruption`).

Le script doit supporter ce redémarrage. Il repart de son checkpoint, et un verrou laissé par un processus tué doit être repris, pas bloquer. Lire le `pid` du verrou : s'il ne tourne plus, supprimer le verrou puis le recréer. Essai réel du 6 novembre 2026 : après les redémarrages du moteur de 03:16 UTC, la simulation NLR et VOX v1 sont reparties seules en 5 s.

## Périmètre

Cette première version fonctionne dans le mode hôte Windows déjà autorisé de Wake. Un Job Object assure la supervision et l'arrêt, pas une isolation du compte utilisateur. Aucun secret ni credential du daemon n'est implicitement hérité ; seules les variables système de démarrage, PATH et les chemins du job sont transmis. Cela ne retire pas les accès disque déjà accordés au compte Windows.

Ces outils sont exposés par le MCP local côté agent (`MIND_WAKE_BACKGROUND_JOBS=1`), puis vérifient la policy active et le consentement au mode hôte. Ils ne permettent pas de contourner les permissions, la pause, les limites fournisseur ni de lancer des dépenses ou des sessions IA supplémentaires sans délégation correspondante. Le mode AppContainer et une interface desktop dédiée aux jobs ne sont pas implémentés par cette version.
