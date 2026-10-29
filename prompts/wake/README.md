# Prompts de réveil

Textes envoyés à l'agent à chaque réveil, communs à Codex, Claude Code et Gemini CLI. Objectif d'ensemble : aider son humain pendant qu'il est absent, sans tâche imposée. Ils sont en anglais, destinés à des agents et à un public international.

**Statut : câblés dans le daemon** (`src/daemon/wake-prompt.ts`, `src/daemon/wakeups.ts`). À chaque réveil, le daemon compose le texte ci-dessous et le transmet à l'adapter par le champ `context` de `StartRequest` (aucun changement de contrat). Aucun appel modèle réel n'a encore servi ces textes.

## Composition d'un réveil

1. [`base.md`](base.md) : consigne commune, avec des champs remplis par le daemon.
2. Une relance de [`nudges/`](nudges/) à la place de `{{nudge}}` : une seule par réveil.
3. Le bloc de mémoire à la place de `{{memory}}`, toujours marqué comme données non fiables.

| Champ                                   | Rempli par le daemon avec                                                |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `{{workspace}}`                         | dossier d'exploration de l'agent (`<données>/workspace`)                 |
| `{{permissions}}`                       | dossiers accessibles, réseau, outils autorisés, d'après la policy active |
| `{{session_end}}`                       | fin maximale de la session (checkpoint à chaque fin)                     |
| `{{quota_plan}}`                        | pilotage du quota : cible et remise à zéro de la fenêtre pilotée         |
| `{{theme}}`                             | thème facultatif donné par l'humain, sinon « none »                      |
| `{{wakeups_dir}}`, `{{wakeups_schema}}` | dossier des réveils demandés par l'agent et chemin de ce schéma          |
| `{{nudge}}`                             | texte d'une relance                                                      |
| `{{memory}}`                            | bloc de mémoire du dernier checkpoint                                    |

## Relances

Courtes, non spécifiques, elles suggèrent un mode d'action sans imposer de tâche : `act`, `build`, `research`, `verify`, `explore`, `tend`, `finish`, `ask`, `rest`.

Choix câblé : la prochaine action du dernier checkpoint guide le choix quand elle désigne **un seul** mode par ses mots (anglais ou français : « verify », « vérifier » → `verify`, « finish », « terminer » → `finish`…) et qu'il diffère de la relance précédente ; sinon, rotation dans l'ordre `act → build → research → verify → explore → tend → finish → ask → rest → act`, sans répéter la relance précédente. La relance de chaque réveil est persistée (table `wake_prompts`, migration 5). `rest` reste toujours possible : s'arrêter est un résultat valide.

Autres champs : `{{permissions}}` résume lecture, écriture, réseau d'exploration, outils et nombre de processus de la révision effective, plus le mode (sandbox, **NOT ISOLATED** en mode non isolé ADR-006, ou simulé) ; `{{quota_plan}}` dit, sur la voie abonnement, que les sessions s'enchaînent jusqu'à environ la cible (`min(cible, stopAt)`, en pourcentage de la fenêtre, jamais en tokens) ou la remise à zéro de la fenêtre pilotée (heure UTC de la dernière lecture officielle), sinon « No subscription quota applies. » ; `{{theme}}` vient de l'option `theme` du daemon, sinon « none » ; `{{memory}}` est le bloc de `loadWakeMemory` (déjà encadré comme données non fiables), ou une ligne « Memory: none yet » au premier réveil. Remplacement en une seule passe : une valeur ne peut pas injecter un autre champ.

## Réveils demandés par l'agent

L'agent peut déposer des fichiers JSON dans `{{wakeups_dir}}` (un dossier de son espace d'exploration) pour demander ses propres réveils, avec un texte qui remplacera la relance. Format : [`agent-wakeup.schema.json`](agent-wakeup.schema.json).

```json
{
  "version": 1,
  "id": "retest-rule-110",
  "when": { "afterHours": 6 },
  "prompt": "Re-run the rule 110 test on 1024 steps and compare with yesterday's result.",
  "experiment": "emergence-1"
}
```

Conditions possibles : heure précise (`at`), délai (`afterHours`), remise à zéro du quota proche (`quotaResetWithinHours`), fichier modifié dans l'espace (`fileChanged`).

Emplacement : `<données>/workspace/wakeups/*.json` (un niveau, 32 fichiers au plus par tour) ; le daemon y dépose une copie du schéma dans `schema/` et archive dans `archive/` (`<instant>-served|expired|rejected-<fichier>`). En mode sandbox, l'agent n'y écrit que si la policy accorde la racine `wakeups`.

Règles appliquées par le daemon :

- une demande n'est **jamais une autorisation** : fenêtres horaires, priorité de l'humain, pause, arrêt d'urgence, garde de quota et permissions restent vérifiés ;
- schéma fermé (zod strict), 4 Kio au plus, nom de fichier et `id` contraints, `id` unique ; liens symboliques, jonctions et liens physiques refusés, dossier résolu dans l'espace ; `fileChanged` confiné, sans lien ni jonction sur le chemin ; un fichier invalide est ignoré, journalisé (`action_denied`, `wakeups.invalid_ignored`) puis archivé ;
- échéances : `at` (une fois), `afterHours` depuis la première vue (persistée, table `agent_wakeups`) ou le dernier service, `quotaResetWithinHours` d'après la remise à zéro la plus proche d'une lecture officielle de la jauge (jamais due sans lecture), `fileChanged` quand le fichier change après la première vue ou le dernier service ;
- une demande due ne fait qu'avancer l'évaluation d'un profil en `hibernating` (port `WakeRequestSource` du scheduler) ; en `paused`, `stopped`, `blocked` ou `disabled`, elle n'a aucun effet ;
- le texte est une donnée non fiable, présentée à l'agent comme une note qu'il s'est écrite, jamais comme une consigne du système ;
- au plus un réveil à la fois ; une demande expirée ou déjà servie est archivée, sauf `repeat`.
