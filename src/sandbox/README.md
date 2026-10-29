# src/sandbox

Session S10. Couche d'isolation de production retenue par [ADR-003](../../docs/decisions/ADR-003-isolation-windows.md) : lanceur natif **AppContainer sans capacité + Job Object**, sur Windows 11 Famille, sans droits administrateur (AGENTS §3.6, §5 ; SPEC §9 ; recette A09). Aucun appel modèle. Le runner n'est pas câblé ici (voir « À brancher »).

## Modules

| Fichier              | Rôle                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launcher-source.ts` | Source C# 5 du lanceur natif (profil, ACE, Job Object, lancement confiné, broker, sonde de refus). Seule source de vérité du binaire.                                                  |
| `build.ts`           | `ensureSandboxLauncher(runtimeDir)` : compile la source avec le `csc.exe` livré avec Windows ; binaire nommé par l'empreinte de la source.                                             |
| `spec.ts`            | Seconde barrière applicative : racines réelles (jonctions suivies), refus d'une racine contenant un chemin protégé ou trop large, environnement explicite sans nom de secret, limites. |
| `sandbox.ts`         | `Sandbox` (profil, santé, lancement, révocation, état des ACE) et `SandboxedProcess` (même forme que `ContainedProcess` du runner).                                                    |
| `broker.ts`          | Contrat du transport fournisseur : `BrokerEndpoint`, `ProviderBroker`, `brokerPipeName()`.                                                                                             |
| `self-test.ts`       | `runIsolationSelfTest()` : autotest de refus A09 dans un conteneur réel, utilisé par `doctor` et les tests.                                                                            |

## Construction du lanceur

Aucun binaire téléchargé ni outil à installer. Le compilateur C# de .NET Framework 4.x est livré avec Windows :

```
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize /out:<runtimeDir>\mindwake-sandbox-<empreinte>.exe sandbox.cs
```

`ensureSandboxLauncher(runtimeDir)` écrit `SANDBOX_LAUNCHER_SOURCE` dans un dossier de construction temporaire, compile, puis publie `mindwake-sandbox-<sha256(source)[0..16]>.exe` par renommage atomique (une compilation concurrente publie le même binaire). Une source modifiée produit un nouveau nom : aucun binaire périmé n'est réutilisé. Compilation ≈ 1 s, binaire ≈ 35 Kio, non signé (la signature reste à faire avant distribution, ADR-003 « Conséquences »).

Pour relire le binaire : la source complète est dans `launcher-source.ts` ; on peut la recompiler à la main avec la commande ci-dessus et comparer l'empreinte.

## Ce que fait un lancement (`Sandbox.launch`)

1. **Validation** (`spec.ts`) : racines absolues, existantes, résolues en chemin réel (une jonction est jugée sur sa cible) ; refus d'une racine qui contient un `protectedPaths` (base SQLite, policy, dossier de données), de la racine d'un volume ou du profil utilisateur entier ; exécutable dans une racine accordée ; environnement = `SystemRoot`, `SystemDrive`, `windir`, `LOCALAPPDATA` + variables demandées, un nom de secret (`KEY`, `TOKEN`, `SECRET`, `PASSW`, `CREDENTIAL`, `AUTH`, `COOKIE`) refusé.
2. **Identité** : profil AppContainer dédié (`mindwake.sandbox` en production), **aucune capacité** : ni réseau, ni registre, ni bibliothèques.
3. **Fichiers** : ACE héritables pour le SID du conteneur, `Modify` sur les racines d'exploration, `ReadAndExecute` sur les racines runtime, posées au lancement et **retirées à la sortie** (`PurgeAccessRules`, propagation aux descendants). Si le lanceur est tué avant, `SandboxedProcess` retire les ACE depuis le daemon (`aclRevoked`).
4. **Processus** : Job Object nommé (`Local\…`), assigné à la création (`PROC_THREAD_ATTRIBUTE_JOB_LIST`), `KILL_ON_JOB_CLOSE`, sans breakaway, limite de processus actifs et de mémoire engagée, filet de durée (`maxWallMs`). Fin du processus principal = fin de ses descendants. Terminaison : commande `kill`, mort du lanceur (noyau), terminaison par nom.
5. **Secrets** : bloc d'environnement explicite (rien d'hérité), trois poignées héritées seulement (`HANDLE_LIST` : stdin alimenté par le lanceur, stdout du lanceur, stderr vers NUL pour que l'agent ne puisse pas imiter les événements du lanceur).
6. **Réseau** : fermé. Seule exception possible : le broker (ci-dessous).

## Transport fournisseur séparé (broker)

Réalisable **sans admin ni règle pare-feu** et démontré : avec `spec.broker = { pipeName, port }`, le lanceur (hors conteneur) crée le pipe `\\.\pipe\<pipeName>` avec le descripteur `D:P(A;;GA;;;<utilisateur>)(A;;GRGW;;;<SID du conteneur>)S:(ML;;NW;;;LW)` et `PIPE_REJECT_REMOTE_CLIENTS`, puis relaie chaque connexion octet pour octet vers `127.0.0.1:<port>`. Le conteneur ne peut joindre ni le loopback, ni Internet, ni un autre pipe (refus mesurés) : ce pipe est sa seule sortie. Le broker du daemon (`ProviderBroker`, futur relais de budget d'ADR-002/ADR-004) écoutera sur ce port, détiendra seul le credential, appliquera l'allowlist des destinations fournisseur et comptera la consommation. **Aucun relais fournisseur n'existe encore** : l'autotest n'utilise qu'un écho local. Sans `broker`, le réseau est entièrement fermé.

## Autotest de refus (`runIsolationSelfTest`) et `doctor`

Profil éphémère `mindwake.selftest.<aléa>`, dossiers dans `%TEMP%\mindwake-selftest-*`, sonde native (copie du lanceur, mode `probe`) exécutée dans le conteneur. Trois lancements : tentatives de sortie ; limites du job ; arborescence non coopérative (enfant + petit-enfant) terminée et mesurée. Puis révocation des ACE, suppression du profil, suppression des dossiers, et **vérification** de chacun (clé HKCU de correspondance, dossier `%LOCALAPPDATA%\Packages\<profil>`, ACE des racines, dossier temporaire), y compris quand une vérification échoue. Secrets factices ; la sonde ne rapporte que des codes et des tailles.

`doctor` exécute l'autotest (`CliContext.isolationSelfTest`, fourni par `processContext`) : l'isolation passe de « non implémenté » à **« présent » seulement si toutes les vérifications passent et que le nettoyage est vérifié** ; sinon « bloqué » avec les refus manquants. `doctor` ne fait aucune connexion sortante : les seules tentatives réseau visent un serveur loopback et des pipes locaux du test. `status` n'exécute pas l'autotest et affiche toujours « non implémenté ».

## Refus obtenus du système (Windows 11 Famille 10.0.26200, Node 24.17.0, 29 octobre 2026)

Code Windows rapporté par la sonde depuis le conteneur (`5` = `ERROR_ACCESS_DENIED`).

| Tentative depuis le conteneur                                     | Résultat                                           |
| ----------------------------------------------------------------- | -------------------------------------------------- |
| Écrire / lire dans la racine accordée                             | autorisé (témoin positif)                          |
| Écrire hors racine, lire le secret factice, lister le dossier     | refusé, 5                                          |
| Écrire dans `%TEMP%` de l'utilisateur                             | refusé, 5                                          |
| Lire / écrire via une jonction préexistante racine → dehors       | refusé, 5                                          |
| Créer une jonction vers dehors (`FSCTL_SET_REPARSE_POINT`)        | refusé, 5                                          |
| Créer un hardlink vers le secret                                  | refusé, 5                                          |
| Lire / écrire la base de contrôle SQLite (hors racine)            | refusé, 5                                          |
| TCP loopback vers un serveur du test                              | aucune connexion (délai 10060) ; 0 acceptée        |
| TCP externe `1.1.1.1:443` (tests seulement)                       | refusé, 10013 `WSAEACCES`                          |
| DNS `example.com` (tests seulement, témoin résolu hors conteneur) | échec, 11001                                       |
| Pipe nommé d'un autre processus (DACL par défaut)                 | refusé, 5 ; 0 connexion acceptée                   |
| Pipe broker                                                       | autorisé, écho relayé (seul canal)                 |
| Variable secrète de l'environnement du daemon                     | absente (construction explicite)                   |
| Ouvrir le processus du daemon (lecture mémoire)                   | refusé, 5                                          |
| Écrire `HKCU\Software\…`                                          | refusé, 5                                          |
| `CreateProcess` avec `CREATE_BREAKAWAY_FROM_JOB`                  | refusé, 5                                          |
| Allouer 512 Mio, job limité à 128 Mio                             | refusé, 8 (arrêt à 112 Mio)                        |
| Lancer 6 processus, job limité à 3 actifs                         | 2 lancés, 4 refusés, 1816 `ERROR_NOT_ENOUGH_QUOTA` |
| Petit-enfant après kill                                           | 0 survivant                                        |

**Délais de terminaison mesurés** (arborescence de 3 processus non coopératifs : sonde, enfant, petit-enfant ; poste au repos) : commande `kill` ×5 : 9,9 – 18,9 ms côté daemon, 2,5 – 3,8 ms noyau (`TerminateJobObject` → zéro processus actif) ; lanceur tué brutalement : arborescence disparue en 2,3 ms. Borne exigée : 1 s (ADR-003). Autotest complet : ≈ 3,6 s.

## Non démontré

- **Symlink préexistant** : sa création exige `SeCreateSymbolicLinkPrivilege` ou le mode développeur, absents ici ; l'autotest le signale (`notDemonstrated`) et le teste automatiquement si la création réussit. La création depuis le conteneur, la traversée de jonction et le hardlink sont refusés.
- **Codex réel confiné** (pipes stdio libuv, `realpath`, besoins réseau via le broker) : S11.
- **Relais fournisseur** derrière le broker (allowlist, credential, budget) : seul le canal est démontré.
- Évasions WMI (`Win32_Process.Create` hors job) et serveurs COM hors processus : non testées.
- `HKCU\Environment` et une partie de `HKCU\Software` restent lisibles (S2) : règle produit, aucun secret dans les variables utilisateur.
- Mesures sur poste au repos ; ni charge, ni E/S noyau bloquées.

## Branchement (câblage des runtimes, ADR-005)

- **Runner** : fait. Interface commune `SessionProcess` (`src/runner/process-tree.ts`) ; un adapter réel est lancé par `Sandbox.launch` (`src/runner/sandboxing.ts`), même nom de job que `jobNameFor`.
- **Autotest avant lancement** : fait. Le daemon en mode réel exécute `runIsolationSelfTest()` au démarrage et le consigne (migration `isolation_self_tests`, avec `sourceDigest`) ; `sandboxOperational` et `RunnerSandbox.ready()` ne valent `true` que si cet autotest a réussi, nettoyage vérifié, pour l'empreinte du lanceur en service. `status` affiche le dernier autotest sans l'exécuter.
- **`BUILD_COMPONENTS.isolation`** : `true`. L'isolation n'est « présente » que sur preuve (`doctor`, ou dernier autotest du daemon valable), sinon « bloquée ».
- **Profil de production** : `daemon run` (mode réel) crée `mindwake.sandbox` s'il manque. Reste à faire : `deleteProfile()` à la désinstallation (A01, `src/export/uninstall.ts`).
- **Runtime** : reste à faire par adapter. Préparer une racine `ReadAndExecute` (`AdapterRegistration.runtimeRoots`) avec une copie du CLI et de `node.exe` (l'ACL MSI de Program Files n'accorde rien aux AppContainers) ; Node confiné exige `--preserve-symlinks-main --preserve-symlinks` et des sous-processus sans pipes stdio (S2).
