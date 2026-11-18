# Pression mémoire : le worker des salles ne tombe plus

## Incident (17 nov. 2026, salle 6 « Emploi remote »)

Ce n'était pas le contexte du modèle. C'était la **mémoire du poste** (RAM, mémoire engageable de
Windows).

- `forks.log` : `Room 6 : réponse 245 envoyée à NLR sur Telegram.Erreur : out of memory`. Juste
  après, le processus `forks run` s'arrête.
- `forks/6/second-thread.sqlite` : l'entrée 245 date de 2026-11-17T16:29:08Z. Le tour 107 est
  clos « interrupted » à 16:29:14Z, quand le worker a été relancé. La réponse suivante, 264, date
  de 16:35:46Z.
- Une première occurrence, plus ancienne, suit `Telegram entrant (room 2) : network`. Elle n'est
  pas datée, parce que `forks.log` n'avait pas d'horodatage.
- « Erreur : » est le préfixe de `renderError` (src/cli/output.ts). L'exception est donc remontée
  jusqu'au CLI. Le texte exact `out of memory` est celui de SQLite (`SQLITE_NOMEM`,
  better-sqlite3) quand une allocation échoue. Un dépassement de contexte aurait été un résultat
  de tour (« Prompt is too long »), journalisé comme `Fork N : …`, sans arrêter le worker.
- D'autres processus sont morts de la même façon : « Fatal JavaScript out of memory: Committing
  semi space failed » (5 nov.) et « Fatal process out of memory: Zone » (16 nov.), avec des tas de
  6 Mo seulement. C'est la signature d'une mémoire engageable épuisée sur tout le système.
- Le 18 nov. vers 16:55, il restait 370 Mo de RAM libre sur 16 Go et 571 Mo de mémoire virtuelle
  engageable. Une quinzaine de `claude.exe -p` tournaient (≈ 500 à 580 Mo chacun), dont sept
  sous-sessions de jobs de fond lancées sans limite.

Pourquoi tout tombait : dans `runForks`, le tour d'une room à plusieurs agents
(`runRoomAgentsTurn`) n'avait pas de try/catch. Toute exception y passait `stopping = true`, ce
qui arrêtait les sept rooms et faisait sortir le processus.

## Correctif commun

1. **Confinement** (src/daemon/forks.ts) :
   - Le tour multi-agents est désormais protégé, comme le tour mono-agent. Une erreur ne termine
     que ce tour (`error`).
   - Toute l'itération de boucle d'une room est enveloppée : une erreur hors tour (base, planning)
     est journalisée `erreur hors tour` et la room reprend.
   - Dans les blocs catch, les écritures en base sont elles-mêmes protégées.
   - Après une erreur d'allocation, la room fait une pause de 60 s (`OUT_OF_MEMORY_BACKOFF_MS`).
2. **Admission mémoire** (src/daemon/memory-pressure.ts). La mémoire est jugée basse sous
   1024 Mo disponibles (`os.freemem`), avec un plafond d'un dixième de la RAM totale.
   - Une room qui doit lancer une session attend que la mémoire revienne, au plus 90 s
     (`MEMORY_WAIT_MS`). Ensuite elle lance quand même : une room ne reste jamais muette. Le tour
     unique n'est pas consommé pendant l'attente.
   - Les jobs de fond (src/daemon/background-jobs.ts, branché dans daemon.ts) restent en file
     tant que la mémoire est basse, au plus 15 min de suite. Ils sont lancés **un par tick** :
     une rafale ne vide plus la mémoire d'un coup.
3. **Traçabilité** (src/cli/commands/forks.ts) : chaque ligne de `forks.log` porte désormais une
   date ISO et finit par un retour à la ligne.

Tests : test/memory-pressure.test.ts.
