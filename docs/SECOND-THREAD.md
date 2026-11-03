# Second fil Claude Code

Un second fil d’agent, désactivé par défaut, s’active depuis la vue d’ensemble
(sélecteur « Off / Second fil Claude »). Il tourne à côté du fil principal
(Codex) sans s’y mélanger et s’affiche dans l’onglet « Fil Claude ».

## Fonctionnement

- **Réglage** : `second-thread.json` dans le dossier de données (`enabled`).
  Le fil principal, son mode (On, Always-on) et son planning ne changent pas.
- **Worker** : `mind-wake second-thread run`, processus détaché lancé par le
  panneau à l’activation, avec son propre verrou (`second-thread.lock`) et son
  journal (`second-thread.log`). Le panneau le relance au plus une fois par
  minute s’il est activé, arrêté et que Wake le permet.
- **Fil sauvegardé** : une session Claude Code persistante, `--session-id` au
  premier tour puis `--resume` (UUID dérivé de `second-thread` et d’une
  génération). Si la reprise échoue avant `init`, une nouvelle génération
  démarre ; les notes du projet assurent alors la continuité.
- **Séparation** : transcription, messages humains et tours dans
  `second-thread.sqlite`. Le prompt système reprend la direction commune et
  `PERSONALITY.md`, plus une note propre au second fil : sa réponse finale de
  chaque tour est son message à l’humain ; il n’utilise pas `message_owner`, ne
  modifie ni le plan de wakes ni le registre de projets. Aucun serveur MCP MIND
  ne lui est transmis.
- **Autre ordre de projets** : il parcourt les projets disponibles du registre
  dans l’ordre **inverse** de la rotation principale, par blocs de 10 tours, et
  écarte toujours le projet sur lequel le fil principal travaille (réservé ou
  courant). Si le fil principal arrive sur son projet, il passe au suivant.
  Sans autre projet disponible : exploration libre.
- **Enchaînement** : comme Always-on, chaque réponse terminée lance le tour
  suivant. Les messages écrits dans l’onglet sont joints au prochain tour.

## Contrôles

Pause suspend le second fil et interrompt son tour en cours ; Force-off et un
profil arrêté terminent le worker. Off désactive le fil (le tour en cours est
interrompu) et conserve son historique. Une limite du fournisseur
(`rate_limit_event` rejeté) suspend les tours jusqu’à sa remise à zéro, au plus
six heures avant nouvelle tentative ; aucune bascule de compte ou d’API.

Le second fil exige le consentement au mode hôte déjà consigné dans la policy
(`hostUnsandboxedAcknowledged`, ADR-006) : il lance Claude Code sur le poste avec
`--dangerously-skip-permissions` et la configuration de l’humain
(`~/.local/bin/claude.exe` ou `MIND_WAKE_CLAUDE_EXE` ; modèle
`MIND_WAKE_SECOND_THREAD_MODEL`, défaut `opus`). Ce n’est pas une isolation.
Les deux fils partagent l’espace de travail ; la séparation par projet évite
les collisions courantes sans les rendre impossibles.

## Vérifications

`src/daemon/second-thread.test.ts` couvre l’ordre inverse par blocs,
l’exclusion du projet principal, la séparation des stockages, la reprise de
session, la remise unique des messages humains, Pause/Off, et un faux
exécutable Claude Code (`test/fixtures/second-thread/fake-claude.mjs`) pour le
flux, la limite fournisseur et l’interruption réelle du processus. Aucun appel
au modèle n’a été fait : un tour réel reste à observer.
