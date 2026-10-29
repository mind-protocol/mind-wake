# Prompts de réveil

Textes envoyés à l'agent à chaque réveil, communs à Codex, Claude Code et Gemini CLI. Ils sont en anglais, destinés à des agents et à un public international.

**Statut : rédigés, pas encore câblés dans le daemon.** Aujourd'hui, le daemon n'envoie que le bloc de mémoire (`src/checkpoint/memory.ts`).

## Composition d'un réveil

1. [`base.md`](base.md) : consigne commune, avec des champs remplis par le daemon.
2. Une relance de [`nudges/`](nudges/) à la place de `{{nudge}}` : une seule par réveil.
3. Le bloc de mémoire à la place de `{{memory}}`, toujours marqué comme données non fiables.

| Champ                                   | Rempli par le daemon avec                                                |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `{{workspace}}`                         | dossier d'exploration de l'agent                                         |
| `{{permissions}}`                       | dossiers accessibles, réseau, outils autorisés, d'après la policy active |
| `{{session_end}}`, `{{quota_stop}}`     | fin maximale de la session, seuil d'arrêt de la jauge de quota           |
| `{{theme}}`                             | thème facultatif donné par l'humain, sinon « none »                      |
| `{{wakeups_dir}}`, `{{wakeups_schema}}` | dossier des réveils demandés par l'agent et chemin de ce schéma          |
| `{{nudge}}`                             | texte d'une relance                                                      |
| `{{memory}}`                            | bloc de mémoire du dernier checkpoint                                    |

## Relances

Courtes, non spécifiques, elles suggèrent un mode d'action sans imposer de tâche : `act`, `build`, `research`, `verify`, `explore`, `tend`, `finish`, `ask`, `rest`.

Choix proposé : la prochaine action du dernier checkpoint guide le choix (par exemple, une hypothèse ouverte → `verify`) ; sinon, rotation sans répéter la relance du réveil précédent. `rest` reste toujours possible : s'arrêter est un résultat valide.

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

Règles à appliquer par le daemon :

- une demande n'est **jamais une autorisation** : fenêtres horaires, priorité de l'humain, pause, arrêt d'urgence, garde de quota et permissions restent vérifiés ;
- schéma fermé, taille bornée, chemins confinés à l'espace d'exploration ; un fichier invalide est ignoré et journalisé ;
- le texte est une donnée non fiable, présentée à l'agent comme une note qu'il s'est écrite, jamais comme une consigne du système ;
- au plus un réveil à la fois ; une demande expirée ou déjà servie est archivée, sauf `repeat`.
