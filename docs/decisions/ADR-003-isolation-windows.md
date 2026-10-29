# ADR-003 — Mécanisme d'isolation Windows

- Statut : proposé (à valider à la porte G1)
- Date : 29 octobre 2026
- Session : S2 (F0-Isolation)
- Éléments : [docs/feasibility/isolation-windows.md](../feasibility/isolation-windows.md), [spikes/isolation](../../spikes/isolation/README.md)

Structure selon AGENTS.md §11 (problème, choix, conséquences, critères de révision) ; le modèle d'ADR de S0 n'était pas encore fusionné.

## Problème

AGENTS.md §3.6 interdit l'exécution autonome sans isolation réelle des fichiers, processus, réseau et secrets, démontrée par des refus. Le poste cible est Windows 11 **Famille**, sans élévation au quotidien. Le daemon est en TypeScript/Node. Le kill switch doit terminer le travail et ses descendants dans un délai testé, sans coopération du modèle (§5 Cycle de vie).

Windows Sandbox et Hyper-V n'existent pas sur Famille (documentation Microsoft). WSL2 garde par défaut l'accès à `C:` et l'interop, et sa configuration par distribution se modifie depuis l'intérieur. Un jeton à intégrité basse laisse lire les fichiers de l'utilisateur (mesuré).

## Décision

Retenir pour la v0.1 un **lanceur natif AppContainer + Job Object**, piloté par le daemon :

1. **Identité** : un profil AppContainer dédié à MIND Wake, **sans capacité réseau** par défaut. LPAC (avec la seule capacité `registryRead`) reste une variante renforcée à évaluer en S10 avec Codex réel.
2. **Fichiers** : accès accordé uniquement par ACE explicites pour le SID du conteneur. Racine d'exploration en `Modify`, racine runtime (copie de Node et des outils déclarés) en `ReadAndExecute`. Aucune autre racine n'est accordée. La base de contrôle SQLite et la policy sont hors de toute racine accordée.
3. **Processus** : Job Object assigné à la création (`PROC_THREAD_ATTRIBUTE_JOB_LIST`), sans breakaway, avec `KILL_ON_JOB_CLOSE`, une limite de processus actifs et une limite mémoire. La terminaison passe par `TerminateJobObject`. La fermeture du handle détenu par le lanceur sert de filet si le lanceur meurt. Le lanceur termine aussi le job si son canal de contrôle se ferme.
4. **Secrets** : bloc d'environnement construit explicitement, sans héritage. Poignées héritées limitées par `HANDLE_LIST`. Le credential fournisseur n'entre jamais dans le conteneur.
5. **Réseau** : aucun accès direct. Le trafic fournisseur, s'il est autorisé, passera par un **broker du daemon** atteint par pipe nommé (le loopback est fermé aux AppContainers). Une exception par capacité `internetClient` est exclue de la v0.1, car elle ouvre tout Internet.
6. **Forme** : petit binaire natif sans dépendance, appelé par le daemon Node via `child_process` (pipes côté daemon, hors conteneur). Le spike est en C# / .NET Framework. Le langage de production (Rust, C ou C#) sera choisi en S10 ; le contrat attendu reste stable : événements JSON, commande `kill`, délai maximal, mort du contrôleur = arrêt.

**Délais proposés pour G1** (SPEC §9), sur la base des mesures du spike (≤ 3 ms observés, ≤ 22 ms noyau, 0 survivant) : la terminaison forcée de l'arborescence est bornée à **1 s** après la décision d'arrêt, marge incluse pour la charge. Une terminaison non confirmée à 1 s est journalisée comme incident. La session est alors bloquée jusqu'à vérification. Cette borne ne couvre pas la consommation résiduelle déjà engagée chez le fournisseur.

## Conséquences

- Fonctionne sur Windows 11 Famille sans droits administrateur et sans modification persistante du système, hors profil AppContainer et ACE sur les dossiers du produit. La désinstallation doit retirer les deux.
- Le daemon dépend d'un binaire natif à construire, signer et versionner. Node seul ne peut pas créer d'AppContainer.
- Les outils exécutés dans la sandbox doivent tolérer l'AppContainer. Node exige une copie du runtime, `--preserve-symlinks*` (ou un équivalent) et des sous-processus sans pipes stdio libuv. **La compatibilité de Codex est le risque principal de cette décision**, à lever en S10/S11.
- `HKCU\Environment` et une partie de `HKCU\Software` restent lisibles depuis le conteneur. Règle produit : aucune credential dans les variables utilisateur ni dans HKCU. `doctor` signale les noms de variables suspects sans afficher leur valeur. Le credential fournisseur est confié au broker ou au stockage de secrets du système, hors conteneur.
- Le contrôle réseau fin (liste de destinations) n'est pas disponible sans admin. Le broker devient un composant de sécurité à part entière : allowlist, journalisation et budget.
- S7 réutilise le mécanisme Job Object pour le kill switch ; S8 s'appuie sur le refus système des jonctions et hardlinks, en gardant la validation applicative des chemins comme seconde barrière.
- Tant que les points non démontrés (broker, Codex réel, symlink préexistant, évasions WMI/COM) ne sont pas couverts par des tests de refus, l'exécution autonome reste bloquée (AGENTS.md §3.6).

## Alternatives écartées

- **Windows Sandbox** : non disponible sur Famille, réseau activé par défaut, pas d'API de pilotage.
- **WSL2** : interop et `/mnt/c` actifs par défaut ; configuration modifiable depuis l'intérieur de la distribution ; réglage réseau global ; installation admin. Pourrait redevenir candidat avec une distribution dédiée et verrouillée, si le confinement Windows s'avère incompatible avec Codex.
- **Jeton restreint ou intégrité basse seuls** : lecture des fichiers de l'utilisateur et réseau non bloqués (mesuré).
- **WFP seul** : exige l'admin et ne couvre ni les fichiers ni les processus. Reste un complément possible pour des exceptions réseau fines.
- **Conteneurs Windows / Docker** : Hyper-V absent de Famille ; Docker Desktop ajoute une dépendance lourde et une installation admin.

## Critères de révision

Revoir cette décision si l'un des cas suivants survient :

1. Codex réel ne peut pas fonctionner en AppContainer ou LPAC (pipes, `realpath`, besoins réseau ou registre) sans affaiblir une frontière : évaluer alors une distribution WSL2 dédiée ou un compte local séparé, puis rouvrir l'ADR.
2. Un test de recette (A09) montre une sortie de racine, une lecture de secret, une connexion réseau ou un processus survivant au job.
3. Le canal broker ne peut pas être restreint au seul conteneur.
4. La cible s'élargit à des éditions Pro/Enterprise ou à un usage élevé, où Windows Sandbox, Hyper-V ou WFP deviennent disponibles.
5. Une évolution de Windows ou de la documentation Microsoft change le comportement d'AppContainer, des Job Objects ou des ACL par défaut (`ALL APPLICATION PACKAGES` sur HKCU notamment).
6. Les mesures de terminaison en recette dépassent la borne retenue à G1.

## Suivi S10 (29 octobre 2026)

Implémentation de production dans [`src/sandbox`](../../src/sandbox/README.md), sans changer la décision. Forme retenue : C# 5 compilé depuis les sources du dépôt par le `csc.exe` livré avec Windows (aucun binaire téléchargé). Profil AppContainer dédié sans aucune capacité, ACE posées par lancement et retirées à la sortie, Job Object nommé (limites de processus et de mémoire), environnement explicite.

Point non démontré par S2 désormais démontré : **canal broker restreint au seul conteneur** (critère de révision 3). Un pipe nommé créé hors du conteneur, avec ACE pour le SID du conteneur et étiquette d'intégrité basse, est joignable depuis le conteneur ; un pipe à DACL par défaut, le loopback et Internet restent refusés. Aucun droit administrateur ni règle pare-feu. Le relais fournisseur derrière ce canal reste à construire.

Restent non démontrés : Codex réel confiné, traversée d'un symlink préexistant (création impossible sans privilège sur le poste), évasions WMI/COM, comportement sous charge. L'exécution autonome reste bloquée tant que le runner ne lance pas via cette couche et que l'autotest de refus n'a pas réussi sur le poste.
