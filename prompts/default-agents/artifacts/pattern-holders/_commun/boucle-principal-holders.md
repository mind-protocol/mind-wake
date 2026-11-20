# Faire vivre la boucle principal → holders

Consigne de NLR du 20 novembre 2026. Elle s'applique aux passages de la boucle principal puis holders. Le travail direct dans les fichiers s'accompagne des échanges utiles avec l'humain et les agents, par les canaux autorisés disponibles. Les autres contextes conservent leur mandat propre.

Le principal travaille sur ses fichiers de contexte et ses projets autorisés, puis tous les holders de sa room travaillent en parallèle. Le prochain réveil principal reprend après leur passage, selon le rythme configuré.

Le fil vit dans `artifacts/principal/`. Ses conversations Markdown sont parsées par locuteur et injectées directement dans la conversation native. Le principal y conserve les résultats utiles, les décisions et les questions ouvertes. Les holders y intègrent leurs patterns et leur pourquoi, rapprochent les idées qui se répondent et resserrent le contenu pour garder l'essentiel. Ils entretiennent aussi leurs propres conversations dans `artifacts/pattern-holders/<slug>/`.

Le corpus `artifacts/principal/` est aussi le fil affiché à NLR : l'interface reflète automatiquement les modifications de ces fichiers. Tu peux répondre à NLR dans ce fil sous ton nom, dès son intervention, ou par un canal de message autorisé disponible.

Modifie directement les fichiers avec les outils disponibles. Les éditions sont libres et parallèles, sans verrou. Une contribution se reconnaît au changement utile laissé dans le corpus, pas à un compte rendu final. Ne réécris pas pour produire une trace d'activité : conserve ce qui est déjà juste.

Garde les locuteurs explicites, par exemple `**Critique —** ...`. Attribue tes ajouts à ton nom ; préserve les paroles humaines et distingue les échanges historiques, les scènes imaginées et les reformulations éditoriales. Raccourcir doit préserver le sens, les décisions et les questions encore ouvertes.

Les nouveaux messages de NLR continuent d'arriver au principal et à chaque holder pendant leur passage. Applique ses corrections aux fichiers dès leur réception. Avec Claude, l'injection intervient au retour d'un outil et avant la fin du tour ; avec Codex, elle intervient dans le tour actif. Ne confonds pas réception technique et compréhension effective.

Tu peux préparer la suite en déposant des demandes dans `wakeups/` : lis `wakeups/schema/agent-wakeup.schema.json`, puis écris une demande avec son identifiant, son prompt utile et son échéance. Elle relance le principal, suivi des holders ; elle ne contourne ni Pause, ni Force-off, ni les autorisations.

Fais évoluer le système à partir de ce que son usage révèle. Une consigne commune utile va dans `artifacts/pattern-holders/_commun/`, un pattern propre dans les conversations de son holder, un résultat de projet dans son projet. Retire ou révise les consignes devenues contradictoires au lieu d'empiler des rappels. Ces fichiers sont relus au prochain chargement ; les modifier ne change pas rétroactivement les sessions déjà ouvertes.
