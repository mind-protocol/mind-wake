# Mises à jour de l’application

Le panneau de production vérifie au démarrage puis cinq minutes après chaque vérification terminée. Dans « Réglages » du menu de gauche, le bouton de mise à jour lance le même parcours immédiatement. Fermer la fenêtre conserve le panneau dans la zone de notification et donc la vérification périodique ; quitter le panneau l’arrête.

`scripts/app-update.mjs` récupère `main` de `https://github.com/mind-protocol/mind-wake.git` dans un cache Git propre à l’installation. `updateSource` et `updateBranch` dans le manifeste permettent de choisir explicitement un autre canal. Le dépôt de travail n’est ni modifié, ni nettoyé, ni réinitialisé.

L’accès au dépôt source privé doit être déjà configuré pour Git dans le contexte du panneau ; sans cet accès, la récupération échoue et l’installation active est conservée.

Une nouvelle révision est clonée dans `installation/releases/`, puis construite avec `npm ci`, le build du moteur, celui du panneau et `cargo build --locked --release`. Cette première version nécessite Git, npm à côté de Node, Rust/Cargo et les outils de compilation Windows sur le poste. Elle ne télécharge pas encore de binaires précompilés signés.

Le manifeste bascule atomiquement après construction réussie et vérification des fichiers attendus. `previous-manifest.json` conserve les chemins précédents. En cas d’erreur avant cette bascule, l’installation active reste identique. Le résultat et les logs sont dans `installation/update.json` et `installation/update.log`.

La version installée est chargée lorsque l’utilisateur **quitte puis rouvre le panneau**. Les anciens dossiers sont conservés : les raccourcis et le lanceur MCP existants peuvent continuer à y charger `startLocal`, qui relit le manifeste. Les processus déjà lancés (hub, daemon, sessions MCP et agent) gardent leur version jusqu’à leur propre redémarrage. Aucune pause, activation, interruption de session ou migration à chaud n’est déclenchée par l’updater.

## Mode développement

- Un binaire Rust de debug bloque toujours les mises à jour, y compris manuelles.
- `MIND_WAKE_DEV=1` les bloque également.
- Le manifeste doit contenir `development: false` pour permettre un téléchargement. Un ancien manifeste sans ce champ reste désactivé.
- La préparation d’installation met ce champ à `false` pour une distribution portable contenant `bin/mind-wake-desktop.exe`, à `true` pour un checkout de développement. La distribution doit embarquer un binaire **release** pour activer le parcours.

## Concurrence et reprise

Le verrou `installation/update.lock/` empêche deux mises à jour simultanées. Il contient le PID et la date de départ et disparaît à la fin, y compris après une erreur. Après une terminaison brutale du processus, le verrou est conservé : vérifier que l’updater et ses compilations enfants sont arrêtés avant de retirer ce seul verrou et réessayer. Les releases échouées sont conservées pour diagnostic, sans activation.

Pour revenir manuellement à l’ancienne version, quitter le panneau puis restaurer `previous-manifest.json` comme `manifest.json`. Cela restaure les chemins du logiciel, pas les données ni les éventuelles migrations effectuées ensuite.

## Validation

`node --test test/setup/app-update.node.mjs` vérifie le mode dev, la bascule après succès, l’absence de reconstruction sans nouvelle révision, la conservation après échec et l’exclusion des demandes simultanées. Git et les compilateurs sont simulés dans ces tests. Le test Git local réel a été empêché par les restrictions d’écriture de l’environnement sur `.git/config`. TypeScript et Rust sont vérifiés séparément. Le parcours téléchargement → build release → réouverture sur une installation de production reste à observer réellement.

## Version affichée

Les réglages affichent la version du binaire exécuté, sa révision Git abrégée, la date du commit et la date de compilation (heures locales). Ces informations sont intégrées à la compilation et restent indépendantes d’une mise à jour préparée pour le prochain lancement. Un build de développement et les modifications locales sont signalés ; sans Git au build, la révision et sa date restent explicitement indisponibles.
