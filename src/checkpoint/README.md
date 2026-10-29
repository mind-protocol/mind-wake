# src/checkpoint

Session S8 : validation et publication des checkpoints, confinement des chemins, artefacts, mémoire au réveil (SPEC §7, AGENTS §5).

| Fichier        | Rôle                                                                                                                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate.ts`  | Forme d'un candidat : schéma fermé (toute clé inconnue refusée), version, identifiants, tailles, statut de confiance, chemins lexicaux, aucun secret (expurgation de `src/journal/`).                                                                                                  |
| `paths.ts`     | Refus lexical (`..`, absolu, lecteur, UNC, `:`, périphériques, point final) puis contrôle au moment de l'accès : aucun composant lien ou jonction, chemin réel sous la racine réelle, fichier à liens physiques multiples refusé, identité du descripteur recontrôlée après ouverture. |
| `artifacts.ts` | Écriture atomique (temporaire `.mw-tmp-*` exclusif, `fsync`, renommage) et vérification d'empreinte SHA-256 + taille.                                                                                                                                                                  |
| `publish.ts`   | Validation, cohérence avec la session en cours, vérification des artefacts, puis checkpoint + références + événement de journal dans une transaction `BEGIN IMMEDIATE`. `published` n'est renvoyé qu'après validation de la transaction.                                               |
| `reconcile.ts` | Au redémarrage : références manquantes ou altérées, fichiers sans référence, temporaires interrompus, liens trouvés. Rapport seulement, aucune suppression.                                                                                                                            |
| `memory.ts`    | Mémoire du dernier checkpoint dans un budget d'entrée, faits déclarés observés séparés des interprétations, provenance par élément, condensation revalidée avec repli sur l'état brut, message d'interruption.                                                                         |

## Utilisation prévue (runner, S7)

1. `openRoot(<espace>/artifacts)` : racine dédiée aux artefacts, sous l'espace d'exploration. La réconciliation considère tout fichier de cette racine comme un artefact ; ne pas y placer l'habitat de l'agent.
2. Obtenir `decideAction(..., { kind: "publish_checkpoint" })` du policy engine : ce module ne lit ni n'applique la policy.
3. `publishCheckpoint(ctx, candidat)` ; n'annoncer la sauvegarde que sur `status: "published"`.
4. Au démarrage du daemon : `reconcileArtifacts(store.db, root, profileId)`, puis journaliser le rapport.
5. Au réveil : `loadWakeMemory({ uow, experimentId, maxInputTokens, lastSession })`. Afficher `interruption` dans la CLI même si `status` vaut `budget_too_small`.

## Limites connues

- **Contrôles applicatifs, pas une isolation.** Les vérifications de liens réduisent la fenêtre d'attaque ; un processus concurrent qui écrit dans l'espace peut encore tenter une substitution entre deux appels système. Seule l'isolation système (AppContainer, ADR-003, S10) empêche l'agent de poser des liens vers l'extérieur. Pendant la publication, l'idéal reste que la sandbox de l'agent soit suspendue ou que le daemon copie les artefacts dans une zone que l'agent ne peut pas écrire.
- **Liens symboliques sous Windows.** Leur création exige le privilège `SeCreateSymbolicLinkPrivilege` (administrateur ou mode développeur). Sur le poste de validation (Windows 11 Famille, sans mode développeur), `symlinkSync` échoue en `EPERM` : les deux tests de symlink sont ignorés (`skipIf`), et la jonction, qui ne demande aucun privilège, est testée réellement. Le code traite jonctions et symlinks de la même façon (`lstat().isSymbolicLink()`).
- **Hardlinks.** Un fichier à `nlink > 1` est refusé en lecture : son autre nom peut être hors de l'espace et n'est pas observable. Créer un lien physique vers un fichier extérieur reste possible pour l'agent si la sandbox ne l'interdit pas ; le refus est un contrôle de dernier recours.
- **Durabilité du renommage sous Windows.** Node ne peut pas faire `fsync` sur un répertoire sous Windows ; NTFS journalise les métadonnées, sans garantie équivalente après une coupure de courant. Le contenu du fichier est `fsync` avant renommage ; une référence vers un fichier perdu serait détectée comme `missing` par la réconciliation.
- **Texte hostile.** Aucun filtrage heuristique d'« instructions » : il serait contournable. La garantie est structurelle : schéma fermé, texte jamais interprété par le daemon, rendu sur une ligne par élément entre bornes portant un nonce tiré au chargement. Le modèle qui lit la mémoire peut toujours être influencé par son contenu ; ses actions restent soumises au policy engine.
- **Estimation des tokens.** Par défaut, la taille UTF-8 en octets (borne supérieure : un token couvre au moins un octet), donc pessimiste d'un facteur 3 à 4 en pratique. Un tokenizer officiel du runtime pourra être injecté (`estimateTokens`).
- **Mémoire longue.** Seul le dernier checkpoint est chargé ; l'historique reste dans SQLite (ajout seul). La condensation multi-checkpoints est prévue en S13.
- Aucune migration SQLite ni aucun changement de contrat : les tables `checkpoints` et `checkpoint_artifacts` de S3 suffisent. `listReferencedArtifacts` interroge directement ces tables, faute de méthode de liste dans `CheckpointRepository`.
