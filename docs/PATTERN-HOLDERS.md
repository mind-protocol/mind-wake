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

## Holder cadencé (gestionnaire du budget)

Un holder peut aussi être réveillé **à cadence**, sans message déclencheur (NLR, 18 nov. 2026 :
« le manager du budget », un holder qui vit sur une temporalité plus longue). Dans l'en-tête de
son `_holder.md` (ou de son `<slug>.md`) :

````markdown
```json pattern-holder
{"name":"Budget","emoji":"⏳","wake":"mention","room":6,"cadence":{"everyWakes":5}}
```
````

- `cadence.everyWakes` : tous les N réveils. Avec `room`, ce sont les tours de la salle (table
  `turns` de son fil) ; sans `room`, les réveils du principal (`wake_prompts`).
- `cadence.everyMinutes` : toutes les N minutes. Les deux ensemble : le premier seuil atteint
  réveille et remet les deux compteurs à zéro.
- `room` : salle de rattachement (2 à 8). Le holder lit le fil de cette salle et y publie. Une
  salle désactivée suspend la cadence et les réveils programmés.
- 0 ou absent = désactivé. Il n'y a ni quota ni intervalle minimal.

**Pas de registre** (NLR, 18 nov. 2026 16:13Z : « pas de registre, c'est des holders qui sont des
agents, c'est ça le pattern »). Aucun `BUDGET.md` n'est lu. Le plan du holder — le partage du
temps, ce qui est prévu — vit dans ses propres sections, relues depuis le disque à chaque réveil,
y compris cadencé. Il les crée et les réécrit lui-même par des blocs ```` ```section nom.md ```` ````
dans sa réponse (voir plus haut) ; cela marche aussi à un réveil cadencé ou programmé.

**Revue avec appel** (NLR 16:15Z : « tu dois m'appeler, faire un call à chaque 30 minutes » ;
« s'il n'y a rien à bouger en 30 minutes, c'est qu'il y a un problème, et ça mérite un appel »).
À chaque réveil cadencé, le holder reçoit le nombre de réveils et le temps écoulés, les derniers
messages du fil de la salle, et la consigne de faire la revue : ce qui a été envoyé, l'écart avec
le partage du temps prévu dans ses sections, ce que la salle a décidé de changer ; si rien n'a
bougé, il le dit et dit ce qui bloque (pas de `SILENCE`). Pour l'appel, il utilise ses outils
habituels (`mind_calls`) ; le runtime lui dit lequel, d'après `mobile-call-control.sqlite` :

- aucun appel actif : `call_human` sans handle (NLR), une seule fois ;
- un appel en cours sans lui : ne pas faire sonner, `invite_to_call` avec `target` = son slug,
  puis sa réponse est lue dans l'appel (elle est publiée après son ajout) ;
- il est déjà dans l'appel (son slug, son handle d'appelant ou `room<N>` de sa salle) : sa
  réponse y est lue, sans sonnerie.

Après le réveil, le runtime vérifie que l'appel est parti (invitation à son nom dans
`mobile-calls.sqlite`, ou présence dans l'appel actif) et l'inscrit dans
`pattern-holders-cadence.json` (`lastResult.call` : `rang`, `joined` ou `missing`). Sinon il
publie dans le fil de la salle : « (revue cadencée : aucun appel à NLR n'est parti) ». `call_human`
refuse de sonner quand Wake est en Pause ou Force-off.

Sa réponse ordinaire est publiée dans le fil de la salle et remise à la session de la salle. Elle
n'est copiée dans le fil principal que s'il nomme NLR explicitement.

État : `pattern-holders-cadence.json` dans le dossier de données. Le premier passage pose la
référence sans réveiller le holder. Avant chaque appel, la référence est remise au présent : un
holder n'est pas réveillé deux fois pour la même échéance, et une longue pause ne donne qu'un réveil.
Un appel en échec n'est pas rejoué ; la prochaine échéance suit la cadence normale. Comme les
autres holders, il attend huit secondes de calme dans le fil. Il obéit à
`pattern-holders on|off` et à Force-off. Sa cadence n'empêche pas les réveils réactifs habituels
(mention, sujets…). Pour qu'il ne parle qu'à sa cadence, mettez `"wake":"mention"`.

### Réveils programmés par le holder

NLR, 16:14Z : « Tu es le manager du temps, donc ce que tu peux faire, c'est te mettre des réveils
pour sous-découper tes différentes parties. » Le holder n'a pas d'outil fichier : il programme ses
réveils dans sa réponse, avec un bloc `reveil`, une ligne par réveil, l'heure puis une note pour
lui-même :

````markdown
Dix minutes d'idéation sur l'offre 2, puis rédaction.
```reveil
dans 10 min : fin de l'idéation de l'offre 2, passer à la rédaction
dans 15 min : relire et envoyer l'offre 2
à 16:45 : point sur les trois offres
```
````

- Heures acceptées : `dans N min`, `dans N h`, `+N` (minutes) ; `à 16:45`, `16h45` (heure locale
  de la machine, prochaine occurrence, donc le lendemain si elle est passée) ; une date ISO.
- Note : 300 caractères au plus. `annuler` vide ses réveils en attente.
- Le bloc n'est pas publié ; le fil annonce « (réveil programmé à 16:45 : …) », ou l'erreur.
- Au réveil, il reçoit ses notes (« prévu à 16:45 : … », avec le retard s'il y en a) et le fil de
  la salle depuis la programmation. Un réveil programmé n'appelle pas NLR ; seul le réveil cadencé
  fait la revue.
- Mêmes règles que la cadence : salle rattachée active seulement (sinon celle que le holder
  écoute) ; un même réveil (même minute, même note) n'est enregistré qu'une fois ; il est retiré
  avant l'appel, donc jamais rejoué ; plusieurs réveils échus ensemble, ou rattrapés après une
  pause, donnent un seul réveil avec toutes les notes ; s'il coïncide avec la cadence, un seul
  réveil aussi. Ni quota ni plancher.
- Un holder sans cadence peut aussi se programmer des réveils (par exemple quand on le mentionne).
- État : `pattern-holders-reveils.json` dans le dossier de données ; les réveils d'un holder
  supprimé sont oubliés.

Tests : `src/communication/holder-cadence.test.ts`.

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
