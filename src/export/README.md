# src/export

Session S9 (SPEC §4 groupe Données, §8.3, §9 ; AGENTS §3.10, §6.8). Export, plafond de stockage, purge et désinstallation. Commandes CLI associées : `export`, `purge`, `uninstall`, `policy configure`, `enable` (`src/cli/commands/`).

- `snapshot.ts` : `readSnapshot(db)` lit toutes les tables dans une seule transaction de lecture. En WAL, une écriture concurrente validée pendant la lecture n'apparaît pas dans l'export, ni à moitié.
- `export.ts` : `exportData` écrit `state.json` (tables expurgées), les artefacts référencés par les checkpoints et `manifest.json` (`mind-wake.export`, `schemaVersion` 1, empreintes SHA-256 des fichiers). Écriture dans un dossier temporaire voisin, puis renommage ; une cible existante ou située dans le dossier de données est refusée.
- `storage.ts` : `measureDataDir` (liens et jonctions jamais suivis), `assessStorage` (plafond absent = inconnu, jamais de la place libre), `handleStorageSaturation`.
- `purge.ts` : purge du préfixe expiré du journal seulement (`planJournalPurge` de S5), avec les sessions ouvertes et réservations non rapprochées protégées.
- `uninstall.ts` : plan des effets et suppression confinée au dossier de données.

## Garanties et limites

- L'export ne fait que lire la base : aucun compteur de budget n'est remis à zéro, aucune réservation n'est libérée. Les imputations sont recopiées dans le manifeste. Aucun import n'existe.
- Aucune variable d'environnement n'est lue. Les chaînes passent par `redactValue` (heuristique : formats connus et clés sensibles). Un artefact est exclu, avec un motif, s'il contient un motif de secret, si son intégrité ne correspond plus au checkpoint, s'il est absent ou s'il est atteint par un lien ou une jonction.
- La base n'est pas copiée brute : elle pourrait contenir un secret non expurgé.
- Racine des artefacts supposée : `<dossier de données>/workspace` (`DEFAULT_ARTIFACTS_SUBDIR`), à aligner sur S8.
- Saturation, selon l'état du profil :
  - `ready` passe à `blocked` avec un motif ;
  - en session (`running`, `checkpointing`), le résultat est `checkpoint_then_block` : le runner (S7) termine son checkpoint, puis bloque ;
  - un profil inactif reste dans son état ; l'événement est journalisé.
    Rien n'est jamais supprimé à saturation. Le scheduler et le runner doivent appeler `assessStorage` avant chaque réveil ; `enable` le fait déjà.
- La purge ne touche jamais :
  - les expériences et les checkpoints ;
  - les policies et les consentements ;
  - le ledger.
    La suppression est logique : lignes SQLite supprimées, WAL tronqué. Aucun effacement physique sécurisé n'est promis.
- `uninstall` :
  - aucun daemon ni mécanisme de lancement n'existe dans ce build, et la commande le dit ;
  - la suppression refuse une racine de volume, le dossier personnel, le dossier courant, un lien, ou un dossier non vide sans `control.sqlite` ;
  - les jonctions internes sont retirées comme liens, sans toucher leur cible.
