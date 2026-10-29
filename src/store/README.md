# src/store

Session S3. Base de contrôle SQLite (`better-sqlite3`, ADR-001) et implémentations des dépôts de `src/contracts/repositories.ts`.

- `openStore(path)` / `openDatabase(path)` : WAL, `synchronous = FULL`, `foreign_keys = ON`, `busy_timeout` (5 s par défaut), puis migrations.
- `MIGRATIONS` : SQL figé et versionné, une transaction `BEGIN IMMEDIATE` par migration ; une base plus récente que le binaire est refusée.
- `SqliteUnitOfWork.transaction(fn)` : `BEGIN IMMEDIATE`, savepoint si imbriquée, rollback sur exception ; une fonction asynchrone est refusée.
- Ajout seul, imposé par triggers : révisions de policy (chaîne linéaire par profil), consentements, révocations, checkpoints, imputations du ledger ; le journal refuse toute modification mais accepte la purge, et ne réutilise jamais une séquence.
- Au plus une session ouverte et une expérience active par profil (index uniques).
- Aucune colonne de secret ; l'expurgation du journal relève de `src/journal/`.
