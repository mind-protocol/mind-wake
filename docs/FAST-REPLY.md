# Réponse rapide

Désactivée par défaut : `mind-wake fast-reply on|off|status`.

À chaque message humain enregistré par `reply` (envoi depuis l'app), un processus
détaché lance Claude Code **sans outils** (`--tools ""`, `--strict-mcp-config`,
hooks désactivés, `--disable-slash-commands`, `--no-session-persistence`), avec
l'abonnement claude.ai de l'humain et le modèle `opus` par défaut
(`MIND_WAKE_FAST_REPLY_MODEL`). Il reçoit le prompt système commun,
`PERSONALITY.md`, une consigne de voix rapide et la conversation récente des deux
côtés (environ 24 000 caractères). Sa réponse est publiée tout de suite dans le
fil principal, préfixée par ⚡, sous l'identité de l'agent. `SILENCE` ne publie
rien ; un échec ne publie rien et le message suit son chemin normal.

## Dans le moteur

Le moteur (`daemon run`) héberge la réponse rapide (`FastReplyService`,
`src/communication/fast-reply-server.ts`). Il garde un Claude Code déjà lancé, qui attend
son prompt sans encore appeler le modèle. Il surveille `human-messages.jsonl` toutes
les 250 ms et donne ce prompt dès qu'un message arrive, puis relance un Claude en
réserve. Celui-ci est renouvelé toutes les 10 min et arrêté quand la réponse rapide est
désactivée ou que l'arrêt d'urgence est posé. Le lancement détaché par `reply` sert de
secours quand le moteur ne tourne pas ; la réservation par message empêche une double
réponse. Le moteur lit aussi les boîtes du second fil et des forks actifs.

## Rôle

La voix rapide est la voix immédiate du même agent ; ⚡ marque seulement la
rapidité. Sans outils, elle :

1. répond complètement quand la réponse est dans la conversation (ce qui a été dit
   ou fait, avis, explication, idée) ;
2. pour une action, une vérification ou un fichier, annonce en une phrase ce qui va
   être fait et par quoi commencer ; le fil principal l'exécute ;
3. pour une correction ou une consigne, la reprend explicitement.

Ce qu'elle annonce engage le fil principal ; elle n'annonce que ce qui est
raisonnable et autorisé, ne prétend jamais avoir fait, lu ou vérifié quoi que ce
soit, et dit qu'elle vérifie quand l'état réel est incertain. Une à quatre phrases,
pas de demande de permission, au plus une question si le message est ambigu,
`SILENCE` quand rien n'appelle de réponse.

## Tous les fils, quel que soit le runtime

Le même mécanisme sert le fil principal (Claude ou Codex), le second fil Claude et
les forks Codex 2 à 8. Un message humain direct d'un fork ou du second fil
(`forks send`, `second-thread send`) reçoit lui aussi sa réponse rapide, à partir de
la conversation de ce fil. Elle est publiée dans ce fil, préfixée par ⚡. Les
identifiants `fork:<n>:<entrée>` et `second:<entrée>` désignent ces messages ; tout
autre identifiant appartient au fil principal.

La réponse est ensuite remise à **toutes** les sessions actives par leur boîte
habituelle : `owner-inbox` pour le principal, qui la lit par le hook Claude ou par le
steering Codex, et la boîte du fil pour le second fil et les forks, par steering ou
au prochain tour. Le fil d'origine reçoit la consigne de l'appliquer : tenir ce
qu'elle annonce, ne pas renvoyer la même réponse, la corriger si elle est fausse.
Cette consigne n'apparaît pas dans son onglet. Les autres fils la reçoivent en FYI,
comme contexte sans réponse attendue ; le principal n'est pas réveillé pour un FYI.

Toutes les boîtes appliquent la même attente (`fastReplyHolds`). Quand le moteur
bat (`fast-reply-server.json`), un message humain récent dont la réponse rapide
n'est pas terminée est retenu au plus 45 s, puis part avec elle, ce qui évite une
double réponse. Sans moteur, seul un ⚡ déjà en cours retient le message. Pendant
l'attente, le hook Claude n'envoie pas de rappel ; `Stop` ne bloque pas.

La voix ElevenLabs lit chaque ⚡ juste après sa publication (`speak_desktop`, avec
le fil d'origine et la clé `reply:<id>`). La lecture automatique du desktop ignore
donc les messages ⚡.

Les sondes `latency-*`, les bumps ciblés `ui-bumpe-*` et les notes `steps:` ne
déclenchent pas de réponse rapide.

## Limites

- La voix rapide ne voit que la conversation : elle peut annoncer une action que le
  fil principal devra corriger s'il en sait davantage.
- Chaque message humain coûte un appel court sur le quota de l'abonnement.

Vérifications : `src/communication/fast-reply.test.ts` (appels simulés et faux
exécutable). Un appel réel sans publication a répondu en 6 s le 5 novembre 2026.
