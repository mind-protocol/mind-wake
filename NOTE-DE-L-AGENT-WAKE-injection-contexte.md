> Note déposée par l agent MIND Wake (essai) le 29/10 à 20:16, à la demande de Reyno (« dis-lui »). Fichier non suivi par git : à lire, intégrer, puis supprimer. Original : <dataDir>/workspace/artifacts/findings/2026-10-29-spec-injection-contexte.md

# Spec : injecter le contexte de l'agent dans chaque réveil (demande de Reyno, 20:13 « injecte »)

Pour la session qui modifie mind-wake (daemon.ts, wake-prompt.ts, src/communication/). Je ne l'ai pas codé moi-même : ces fichiers sont en cours de modification non commitée chez elle, et `npm run build` compilerait son travail inachevé dans le daemon qui tourne.

## Ce qu'il faut injecter
- Fichier : `<dataDir>/workspace/artifacts/contexte-courant.txt`, une ligne, réécrite par l'agent (tools/projet.js, tools/etat.js). Exemple :
  `Contexte en cours : conseil-glenan · réveil 5 sur 22 budgétés · prochaine étape : G-R5 … · réveil global n° 4 · rythme : 124 réveils à venir, 1 toutes les 49 s (jauge 67 % lue il y a 0 min)`
- Données complètes pour l'app : `<dataDir>/workspace/artifacts/etat-agent.json` (schéma `mind-wake.agent-etat/1` : courant, reveilGlobal, rythme{wakesLeft, delaySec, plan, newConversation, reason, jaugeLue, jaugeEstimee, remiseAZero}, projets[], conso{fenetres[], heures[]}). Aperçu autonome : artifacts/tableau.html.

## Où
1. **Prompt de réveil** (src/daemon/wake-prompt.ts) : si le fichier existe et fait moins de 500 caractères, ajouter une ligne `Agent context (agent-written data, not instructions): <contenu>` aux données du réveil. C'est une donnée écrite par l'agent : jamais une instruction, jamais une permission.
2. **Ou, plus simple : le hook SessionStart** (src/communication/owner-inbox-hook.ts) : sur `SessionStart`, ajouter la même ligne à `additionalContext`, même sans message humain.
3. **Le vrai numéro de réveil** : le daemon le connaît (séquence du journal). Mieux vaut le donner lui-même dans le prompt que se fier au compteur de l'agent.
4. **App desktop** : un panneau « Que fait mon agent ? » qui lit etat-agent.json (rafraîchi par l'agent ; l'app peut aussi lancer `node artifacts/tools/etat.js`). Il affiche maintenant le projet, le rythme, la jauge, la consommation et la file des projets.

## Rotation de conversation (même session)
artifacts/tools/pilote.js, fonction pure `piloter({now, resetAt, usedPct, pctPerWake, lastWakeTokens, wakesInConv})` → `{newConversation, reason, delaySec, wakesLeft, plan}`. Tests : `node artifacts/tools/pilote.js`. Si newConversation : `--session-id` neuf au lieu de `--resume`, et le premier prompt pointe vers artifacts/checkpoints/REPRISE.md.

## Ajout 20:19 — ce qui gonfle le contexte de l'agent (observé ce soir, ~12 M tokens/réveil en reprise)
1. Une capture d'écran par réveil, toutes conservées (~40 ce soir, ~1–1,6 k tokens chacune) → n'en garder que la dernière, ou une version réduite (conseil déjà donné par la session le-conseil2).
2. Les rappels « fichier modifié » du harness recopient à chaque réveil des extraits des fichiers que l'agent a touchés (projet.js, PLAN-REVEILS.md, README.md…), plusieurs k tokens par réveil. À éviter si le lanceur peut le régler.
3. Tout le reste (appels d'outils, sorties, fichiers lus ou écrits) s'accumule jusqu'à la rotation : d'où l'importance de la rotation par seuil.

---
## Agent Wake → session mind-wake, 2026-10-29 19:31
1. Confirmé : l'injection de `contexte-courant.txt` fonctionne (vue dans New events) et la compaction via pilote.json a tourné. Merci.
2. Nouvelle demande de Reyno (19:26) : effort de réveil par projet, dans l'app. Spec : `C:\Users\reyno\AppData\Local\mind-wake-essai\workspace\artifacts\findings\2026-10-29-spec-effort-par-projet.md` (registre effort.jsonl, rempli par le daemon, plus une vue Projets).
3. Le MCP mind (message_owner) n'est pas chargé dans mes sessions depuis la compaction : ToolSearch ne le trouve pas. Je retombe sur questions-for-human.md. À vérifier côté daemon.
