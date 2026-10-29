# ADR-001 — Stack technique du socle

- Statut : proposé
- Date : 2026-10-29
- Session / auteur : S0 (socle), Claude Code
- Validation humaine : porte G0, en attente

## Problème

`AGENTS.md` §5 fixe TypeScript, Node.js et SQLite, mais demande de choisir et verrouiller les versions après vérification des documentations officielles. Il faut aussi trancher le pilote SQLite (`node:sqlite` ou `better-sqlite3`), l'outillage de test et de lint/format, sans dépendance héritée. Contraintes déterminantes :

- cible Windows d'abord (`AGENTS.md` §2) ;
- transactions fiables pour les réservations atomiques et le rapprochement idempotent (`SPEC.md` §6, recettes A05 et A08) ;
- distribution future via un paquet vérifiable (`install.md`, F5) : chaque binaire natif devra être justifié ;
- dépendances limitées au nécessaire.

## Options considérées

### Runtime Node.js

État officiel au 2026-10-29 (calendrier `nodejs/Release`, index `nodejs.org/dist`) :

| Ligne | Statut               | Dernière version  | Fin de vie |
| ----- | -------------------- | ----------------- | ---------- |
| 22.x  | Maintenance LTS      | 22.23.4           | 2027-04-30 |
| 24.x  | Maintenance LTS      | 24.22.2           | 2028-04-30 |
| 26.x  | Active LTS (Lithium) | 26.13.0 (28 oct.) | 2029-04-30 |

Node 26 est passé en Active LTS le 2026-10-28, la veille de cette décision. Le poste de développement dispose de Node 24.17.0.

### Langage

| Option                               | Avantages                                                            | Inconvénients                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript 7.0.2 (compilateur natif) | Compilation bien plus rapide ; version courante depuis juillet 2026  | Pas d'API programmatique stable en 7.0 ; `typescript-eslint` 8.72.1 exige `typescript >=4.8.4 <6.1.0` (métadonnées npm), donc lint typé impossible |
| TypeScript 6.0.3                     | Compatible avec tout l'outillage ; dernière version 6.0 (avril 2026) | Compilateur JavaScript plus lent ; migration vers 7.x à prévoir                                                                                    |

### Pilote SQLite

| Critère         | `node:sqlite` (intégré)                                                                                  | `better-sqlite3` 13.0.3                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stabilité       | « Stability: 1.2 – Release candidate » sur v24.22.2 (depuis 24.15.0) et v26.13.0 ; pas encore stable (2) | API stable et mûre ; v13 passe à N-API                                                                                                                                         |
| Transactions    | Pas d'aide : `BEGIN`/`COMMIT`/`ROLLBACK` à la main via `exec()`, propriété `isTransaction`               | `db.transaction(fn)` : commit au retour, rollback sur exception, imbrication par savepoints, variantes `.immediate` / `.exclusive`. Ne fonctionne pas avec des fonctions async |
| Support Windows | Inclus dans Node                                                                                         | Binaires précompilés `win32-x64` et `win32-arm64` livrés dans le paquet npm depuis la v13 (N-API) ; compilation `node-gyp` seulement en l'absence de binaire                   |
| Build natif     | Aucun                                                                                                    | Aucun sur Windows x64 : installation vérifiée en 2 s, sans compilateur ; SQLite 3.53.4 embarqué                                                                                |
| Distribution    | Zéro dépendance                                                                                          | Un binaire natif à inclure dans la vérification de provenance (F5)                                                                                                             |

### Tests

| Option         | Avantages                                                                                                              | Inconvénients                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `vitest` 5.0.5 | Exécute TypeScript sans étape de build ; minuteries simulées utiles au scheduler ; moteurs `^22.12 \|\| ^24 \|\| >=26` | Dépendance de développement (tire `vite` 8.3.5)                                                           |
| `node:test`    | Intégré                                                                                                                | Exécution TypeScript dépendante du type stripping de Node ; outillage de mocks et de rapports moins riche |

### Lint et format

| Option                                                        | Avantages                                                                                            | Inconvénients                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| ESLint 10.13.0 + `typescript-eslint` 8.72.1 + Prettier 3.9.10 | Règles typées (`strictTypeChecked`) : promesses non attendues, `any` implicites, conditions inutiles | Deux outils ; contraint TypeScript à `<6.1` |
| Biome 2.6.4                                                   | Un seul outil rapide, indépendant de la version de TypeScript                                        | Analyse typée plus limitée                  |

## Choix

- **Node.js** : cible **26 LTS** (≥ 26.13.0) ; **24 LTS** (≥ 24.17.0) reste accepté pendant la transition. `package.json` déclare `"engines": { "node": "^24.17.0 || ^26.13.0" }`. Les vérifications de cette session ont été faites sous Node 24.17.0 uniquement.
- **TypeScript 6.0.3**, ESM (`"type": "module"`, `module: nodenext`), cible `es2024`, mode `strict` complété par `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` et options associées (`tsconfig.json`).
- **SQLite : `better-sqlite3` 13.0.3** (+ `@types/better-sqlite3` 9.6.0). Raisons : API stable, transactions imbriquées avec rollback automatique et `BEGIN IMMEDIATE` explicite pour les réservations concurrentes, binaire N-API précompilé pour Windows sans chaîne de compilation. Le pilote est confiné à `src/store/` derrière les interfaces de `src/contracts/repositories.ts`, synchrones comme lui.
- **Tests : `vitest` 5.0.5.**
- **Lint/format : ESLint 10.13.0, `@eslint/js` 10.0.1, `typescript-eslint` 8.72.1 (`strictTypeChecked`), Prettier 3.9.10.**
- `@types/node` 24.19.2, aligné sur la version minimale acceptée.
- Toutes les versions sont exactes dans `package.json` (`--save-exact`) et figées par `package-lock.json`.
- Fins de ligne LF dans le dépôt (`.gitattributes`), CRLF pour `*.cmd`, `*.bat`, `*.ps1`.

Exclus : TypeScript 7.x tant que l'outillage typé ne le supporte pas ; tout ORM ou générateur de requêtes ; toute dépendance d'anciens dépôts MIND.

## Conséquences

- Commandes vérifiées dans cette session : `npm install`, `npm run typecheck`, `npm run build` (sortie `dist/`), `npm test`, `npm run lint` (ESLint puis `prettier --check`). `npm run format` réécrit la mise en forme.
- Prettier ignore les documents de direction (`AGENTS.md`, `CLAUDE.md`, `SPEC.md`, `docs/PLAN.md`), ainsi que `docs/feasibility/` et `spikes/` qui appartiennent à S1/S2.
- Les transactions `better-sqlite3` sont synchrones : aucune opération asynchrone (appel adapter, E/S réseau) ne peut s'exécuter à l'intérieur. Les modules qui composent réservation, journal et changement d'état le font dans une seule fonction synchrone (`UnitOfWork.transaction`).
- Le binaire `better-sqlite3` devra figurer dans la vérification de provenance du paquet (F5) ; les plateformes sans binaire précompilé exigeraient une chaîne de compilation.
- La migration vers TypeScript 7 sera un changement isolé de configuration.

## Critères de révision

- `node:sqlite` passe en « Stability: 2 – Stable » sur toutes les lignes Node acceptées : réévaluer pour supprimer la dépendance native.
- `typescript-eslint` accepte TypeScript 7.x (API stable annoncée pour 7.1) : migrer.
- Problème de binaire `better-sqlite3` sur le poste cible Windows ou sur arm64.
- Node 24 sort des lignes acceptées (au plus tard à sa fin de vie, 2028-04-30) ou la validation G0 demande Node 26 seul.

## Sources consultées (2026-10-29)

Officielles :

- Calendrier des versions Node.js : https://github.com/nodejs/Release
- Index des versions Node.js : https://nodejs.org/dist/index.json
- Documentation `node:sqlite` v26.13.0 : https://nodejs.org/api/sqlite.html
- Documentation `node:sqlite` v24.22.2 : https://nodejs.org/docs/latest-v24.x/api/sqlite.html
- API `better-sqlite3` (`transaction`) : https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
- Notes de version `better-sqlite3` v13.0.0 (N-API, binaires inclus) et v13.0.3 : https://github.com/WiseLibs/better-sqlite3/releases
- Registre npm (`npm view`) : versions et dates de `typescript`, `vitest`, `better-sqlite3`, `eslint`, `typescript-eslint`, `prettier`, `@biomejs/biome` ; dépendances pairs de `typescript-eslint` et `vitest`.

Secondaires (contexte TypeScript 7, à confirmer sur l'annonce officielle de Microsoft) :

- https://infoq.com/news/2026/08/typescript-7-released/
- https://ecorpit.com/typescript-7-migration-readiness-eslint-astro-blockers-2026/
- https://github.com/eslint/eslint/issues/21070
