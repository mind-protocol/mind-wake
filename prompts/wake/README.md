# Messages de réveil

Décision : ce qui est fixe va dans le système. Le réveil transmet seulement une relance, le temps/budget courant et les événements nouveaux.

## Composition

- `StartRequest.systemContext` contient l’espace, les permissions effectives, les chemins de demandes de réveil et le thème humain facultatif. Les adapters Claude et Codex l’ajoutent aux instructions système, séparément du message utilisateur. Codex compare son empreinte avant de modifier les instructions d’un fil repris.
- `StartRequest.context` utilise `base.md` : `{{nudge}}`, `{{budget}}`, `{{events}}`. La ligne des événements est absente lorsqu’il n’y a rien de nouveau. Aucun résumé de checkpoint ni historique de conversation n’est recollé.
- L’historique est repris par le runtime. Les notes, fichiers et checkpoints restent consultables par l’agent quand il en a besoin. Une conversation neuve consulte aussi les fichiers ; elle ne reçoit pas automatiquement l’ancien historique.
- Les éléments nouvellement collectés et autorisés (demande de réveil, contexte clavier, image jointe) restent des données, sans modifier les permissions. Aucun historique de messages n’est chargé par défaut : l’agent consulte son canal quand utile.

## Relances

40 amorces courtes de continuité : « Where was I? », « Let’s continue. », « Here we go again! » et variantes. Les identifiants historiques restent compatibles avec le journal. La rotation évite la répétition immédiate ; le checkpoint peut orienter le choix en interne sans être recopié.

## Contrôles

Le daemon impose toujours les permissions, budgets, priorité humaine, pause et arrêt. Le changement de rôle du texte ne change aucune autorisation. Les relances sont des amorces, pas des missions ni des rapports à produire.

## Réveils demandés par l'agent

L'agent peut déposer des fichiers JSON dans `{{wakeups_dir}}` (un dossier de son espace d'exploration) pour demander ses propres réveils, avec un texte présenté comme un événement nouveau. Format : [`agent-wakeup.schema.json`](agent-wakeup.schema.json).

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

## Continuité sans projet

Claude utilise un fil stable même lorsque aucune expérience n’est sélectionnée. L’ancrage optionnel `runtimes/claude/default-conversation.json`, côté contrôle, permet de reprendre le dernier fil existant lors de la mise à jour, sans copier ses messages. Une expérience sélectionnée conserve son propre fil.
