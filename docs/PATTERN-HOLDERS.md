# Pattern holder

Désactivé par défaut : `mind-wake pattern-holders status|on|off|check|try`.

Un accord pris avec l'humain vit dans une conversation-semence portée par un agent : le
pattern holder. Il n'y en a qu'un, toujours allumé (décision de NLR, 6 novembre 2026). Sa
semence est un fichier de données de l'agent, `artifacts/pattern-holders/<slug>.md` dans le
workspace : un bloc ```` ```json pattern-holder ```` (`name`, `emoji`, `quietMinutes`
facultatif) puis la conversation, réplique par réplique, chacune avec sa source. Le moteur
lit ce fichier sans exécuter de code. Il le relit à chaque réveil : une modification compte
dès le message suivant. Les fichiers qui commencent par `_` sont ignorés.

## Réveil

Le moteur (`daemon run`) héberge `PatternHolderService`
(`src/communication/pattern-holders.ts`), à côté de la réponse rapide. Il n'y a pas de
mots-clés : chaque nouveau message du fil principal, de l'humain ou d'un agent, réveille le
holder. Une série de dictées est lue d'un bloc, après 8 s de calme. Le holder relit sa semence
et le fil récent, puis il intervient ou répond `SILENCE`. Une mention `@<slug>` ou une réponse
humaine à son dernier message l'oblige à répondre. Ses propres messages ne le réveillent pas.
`quietMinutes` lui permet de se donner une pause après avoir parlé ; cette pause ne s'applique
ni aux mentions ni aux réponses.

Le premier passage place le curseur au dernier message : l'historique ancien ne réveille
personne. Le curseur avance avant l'appel, si bien qu'un échec ne relance pas le holder en
boucle. L'état est dans `pattern-holders-state.json`.

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

- Chaque message du fil coûte un appel court sur le quota de l'abonnement, même quand le
  holder se tait.
- Le holder ne voit que le fil principal, pas le second fil ni les forks.
- L'app mobile Lumina ne montre que les messages publiés sous `claude-wake` : c'est le cas du
  holder.
