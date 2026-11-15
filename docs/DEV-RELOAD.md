# Appliquer une modification sans tout recompiler

Ce qu'il faut lancer selon la partie modifiée, sur une installation de développement.

| Partie modifiée | Commande | Effet |
| --- | --- | --- |
| `services/**/*.ts` (ElevenLabs, MCP, voix) | rien | relus à chaque appel |
| `desktop/ui/**` | `npm run desktop:ui` | l'app ouverte se recharge seule |
| `desktop/src-tauri/**` (Rust) | `npm run desktop:install` | binaire compilé, installé, app relancée |
| `src/**` (réveils, moteur, ⚡) | redémarrer le moteur | voir ci-dessous |

## Interface du desktop

Le desktop sert `desktop/ui` depuis le dépôt (`MIND_WAKE_REPO_DIR` ou le dépôt du
binaire), pas depuis la copie intégrée. `npm run desktop:ui` compile l'interface dans
`desktop/ui/build`, puis écrit `desktop/ui/build/.reload-stamp`. L'app recharge alors
toutes ses fenêtres dans la seconde. Le rechargement coupe une dictée en cours.
Fichier absent du dépôt : la copie intégrée sert de secours.
`MIND_WAKE_DESKTOP_EMBEDDED_UI=1` force la copie intégrée.

## Binaire du desktop

`npm run desktop:install` (manifeste : `--manifest`, sinon
`MIND_WAKE_DATA_DIR/installation/manifest.json`) :

1. compile l'interface, puis `cargo build --locked --release` ;
2. copie le binaire dans `installation/desktop-builds/<sha256>/` ; le binaire en cours
   n'est jamais écrasé ;
3. remplace seulement `desktopExe` dans le manifeste ;
4. arrête l'ancienne app ; son superviseur relit le manifeste et lance la nouvelle.
   `--no-restart` installe sans relancer.

## Moteur

Avec `"engineFromSource": true` dans le manifeste, `engine-supervisor.mjs` lance le
moteur depuis `src/cli/main.ts`, avec le chargeur TypeScript des services : plus besoin
de `npm run build`. Les hooks Claude et le lancement de secours du ⚡ suivent le même
mode (`src/cli/script-entry.ts`). Une modification de `src/` demande seulement un
redémarrage du moteur sous son superviseur :

```
node scripts/owned-runtime-control.mjs --manifest <manifest> --role daemon --action restart
```

Ne pas relancer le moteur à la main (`node dist/cli/main.js daemon run`) : il échappe
alors au superviseur, ne peut plus être redémarré proprement et ignore le mode sources.
Les commandes CLI lancées par le desktop (`cli.rs`) utilisent toujours `dist/` :
`npm run build` reste nécessaire pour elles.
