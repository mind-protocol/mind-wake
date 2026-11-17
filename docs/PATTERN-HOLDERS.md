# Pattern holder

Désactivé par défaut : `mind-wake pattern-holders status|on|off|check|try`.

## Conversations-semences et réveilleur

Le moteur découvre à chaque passage les fichiers et dossiers de `artifacts/pattern-holders/`.
Le slug correspond au nom du fichier ou du dossier. Exemple d’en-tête pour `crypto.md`
ou `crypto/_holder.md` :

````markdown
```json pattern-holder
{"name":"Crypto","emoji":"🪙","wakeHint":"Financement, propriété et soutien d’un collectif."}
```
````

La conversation-semence suit cet en-tête. Dans un dossier, les sections Markdown sont
assemblées dans l’ordre des noms. Déplacer une section transfère cette mémoire au
destinataire dès le prochain échange, sans déclencher d’appel. Le dossier a priorité sur
le fichier du même nom. Au premier souvenir écrit par un holder mono-fichier, Wake crée
son dossier avec une copie de la semence et la nouvelle section. Le fichier initial reste
disponible. Les entrées racine commençant par un souligné sont ignorées.

Le holder réservé `reveilleur.md` ou `reveilleur/` contient les conversations sur **qui
appeler et quand**. Son appel reçoit sa propre semence, les noms, slugs et présentations
(`wakeHint`) des candidats et l’échange du fil. Il renvoie un tableau JSON de destinataires,
éventuellement vide. Le moteur ne publie pas cette sélection. Chaque destinataire reçoit
l’échange d’origine et sa propre semence. Une réponse `SILENCE` accompagnée d’une section
valide enregistre cette section discrètement.

Le routage groupé intervient après huit secondes de calme, une fois par fil et par lot.
Un `@slug` ou une réponse humaine au dernier message d’un holder le réveille directement.
Les messages des holders ne relancent pas la boucle. Les affectations aux forks et les
pauses spontanées (`quietMinutes`) sont conservées. Avec plusieurs holders et aucune
semence de réveilleur, Wake utilise le catalogue seul. Une installation historique à un
seul holder sans réveilleur conserve son comportement. Le premier passage ignore le passé ;
un nouveau spécialiste hérite du dernier curseur connu du fil.

Le champ optionnel `"wake": "mention"` de l’en-tête `pattern-holder` limite le réveil d’un holder à la mention (`@slug` ou nom), au `@handle` d’une personne qu’il coache et à la réponse humaine qui suit son message ; jamais à un simple message du fil (autre valeur : holder invalide).

## Appel et publication

C'est le même appel que ⚡ : Claude Code sans outils, sans MCP ni hooks, avec l'abonnement
claude.ai et le modèle `MIND_WAKE_PATTERN_HOLDER_MODEL` (par défaut celui de ⚡). Le texte
paraît dans le fil sous l'identité de l'agent, préfixé `<emoji> <name> · `, avec la clé
`pattern-holder:<slug>:<message déclencheur>`. Il est aussi remis à la session principale par
`owner-inbox` (canal `pattern-holder`), avec la consigne d'en tenir compte et de mettre la
semence à jour si l'humain corrige un accord. Il n'y a pas de voix ElevenLabs. Le holder
s'arrête avec Force-off et avec le moteur ; comme ⚡, il ne suit pas la Pause.

## Essais

- `pattern-holders check` : liste les réveils prévus, sans appel au modèle.
- `pattern-holders try --slug S --since ISO` : fait un appel réel sur les messages depuis
  `since` et affiche la réponse sans la publier.
- Tests : `src/communication/pattern-holders.test.ts` (appels simulés).
- Le 6 novembre 2026 à 00:24 UTC, premier réveil réel : le holder a répondu en 13 s, en
  signalant les accords qui manquaient à sa semence.

## Limites

- Un lot ordinaire coûte un appel de routage, puis un appel par spécialiste choisi.
- Un holder écoute le fil principal ou le fork actif auquel il est affecté.
- L'app mobile Lumina ne montre que les messages publiés sous `claude-wake` : c'est le cas du
  holder.
