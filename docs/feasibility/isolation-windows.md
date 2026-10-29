# Faisabilité F0 — isolation Windows

Session S2, 29 octobre 2026. Entrée de la porte G1 et du futur `src/sandbox` (S10). Prototype : [spikes/isolation](../../spikes/isolation/README.md). Décision : [ADR-003](../decisions/ADR-003-isolation-windows.md).

## 1. Question et contexte

AGENTS.md §3.6 exige que les restrictions de fichiers, processus, réseau et secrets soient imposées par le mécanisme d'isolation, avec tests de refus, et que l'exécution autonome soit bloquée si elles ne peuvent pas être garanties. SPEC.md §9 ajoute la terminaison du travail et de ses descendants sans coopération du modèle.

Poste cible mesuré : Windows 11 **Famille** 10.0.26200.9711, x64, compte membre des Administrateurs mais processus non élevé (intégrité moyenne), Node v24.17.0, mode développeur désactivé, WSL2 installé (Ubuntu), pas de Docker CLI. Aucune commande élevée n'a été lancée.

## 2. Options comparées

Sources : documentation Microsoft Learn consultée le 29 octobre 2026 (liens en §8). « Mesuré » signifie démontré sur le poste par le spike ; sinon l'information vient de la documentation.

| Critère | AppContainer + Job Object | LPAC + Job Object | Jeton restreint / intégrité basse + Job | Filtrage WFP / pare-feu | Windows Sandbox (`.wsb`) | WSL2 | Conteneurs (Windows / Docker) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Disponible sur Windows 11 Famille | **Oui** (mesuré) | **Oui** (mesuré) | Oui (mesuré) | Moteur oui ; ajout de filtres réservé aux admins (à confirmer dans la doc WFP, non vérifié pendant cette session) | **Non** (« not supported on Windows Home ») | Oui (déjà installé ici) | Conteneurs Windows : non (Hyper-V absent de Famille). Docker Desktop : conteneurs Linux via WSL2 seulement |
| Droits admin à l'usage | **Aucun** (mesuré) | **Aucun** (mesuré) | Aucun | Oui pour ajouter des filtres | Oui pour activer la fonctionnalité | Installation oui ; usage non | Installation oui |
| Fichiers : lecture/écriture par racine | **Oui** : ACE explicites par racine pour le SID du conteneur ; tout le reste refusé hors objets accordés à *ALL APPLICATION PACKAGES* (mesuré) | Oui, plus strict : n'hérite pas des ACE *ALL APPLICATION PACKAGES* (mesuré) | **Non** : l'intégrité basse bloque l'écriture « vers le haut », pas la lecture ; le secret est lu (mesuré) | Sans objet | Oui (dossiers mappés, lecture seule possible) | Non par défaut : `/mnt/c` monté et interop actif ; réglable dans `/etc/wsl.conf`, fichier modifiable par root à l'intérieur de la distribution | Oui (montages) |
| Sorties par jonction / symlink / hardlink | **Refusées** : contrôle d'accès sur la cible ; création de jonction, symlink et hardlink refusée (mesuré) | Refusées (mesuré) | Lecture via jonction **autorisée** (mesuré) | Sans objet | Frontière VM | DrvFs suit les liens Windows avec les droits de l'utilisateur | Frontière conteneur |
| Descendants contenus, terminaison bornée | **Oui** : Job Object sans breakaway, `KILL_ON_JOB_CLOSE` ; 7/7 processus tués, aucun survivant (mesuré) | Oui (mesuré) | Oui (Job Object) | Sans objet | Fermeture de la VM | `wsl --terminate`, granularité distribution | Arrêt du conteneur |
| Réseau refusé par défaut | **Oui** : TCP externe, loopback, UDP et DNS refusés sans capacité (mesuré) | Oui, refus explicite EACCES partout (mesuré) | **Non** (mesuré) | Oui si filtres admin | Réseau **activé** par défaut, désactivable dans le `.wsb` | Non par défaut ; `networkingMode=none` est global à toutes les distributions | Oui, configurable |
| Exceptions réseau | Grossières : `internetClient` ouvre tout Internet, loopback toujours refusé (mesuré) ; par destination : WFP (admin) ou broker | Idem | — | Fines (adresse, port, SID de conteneur), admin | Tout ou rien | Pare-feu Hyper-V / Windows (`firewall=true`) | Fines |
| Pas de secrets hérités | Environnement explicite (propriété du lanceur) ; mémoire des processus parents illisible ; **`HKCU\Environment` lisible** (mesuré) | Idem, `HKCU\Environment` lisible avec la capacité `registryRead` nécessaire à Node (mesuré) | Non concluant dans le spike | Sans objet | Bonne (VM vierge) | Variables Windows exportées via interop (`WSLENV`) ; `.wslconfig` global | Bonne |
| Faisabilité depuis Node | Lanceur natif (C#, Rust ou C) ; Node lui-même tourne confiné avec ajustements (§5) | Idem + capacité `registryRead` | Lanceur natif | Lanceur natif + admin | Pas d'API de pilotage documentée ; lancement GUI | `wsl.exe` en ligne de commande | CLI Docker |
| Verdict | **Retenu** | Variante renforcée à garder en réserve | Insuffisant seul | Complément futur, pas en v0.1 | Exclu (édition Famille) | Exclu comme frontière v0.1 | Exclu (dépendances, admin) |

## 3. Prototype

Le lanceur `spikes/isolation/src/Sandbox.cs` (compilé par le `csc.exe` livré avec Windows, aucune dépendance) :

1. crée un profil AppContainer `mindwake.spike.s2` sans capacité (ou dérive son SID s'il existe) ;
2. pose des ACE héritables pour ce SID : `Modify` sur la racine de travail, `ReadAndExecute` sur la racine d'exécution (copie de `node.exe`, sonde, lanceur) ;
3. crée un Job Object avec `KILL_ON_JOB_CLOSE`, `DIE_ON_UNHANDLED_EXCEPTION`, limite de processus optionnelle, sans `BREAKAWAY_OK`, et un port de complétion pour les notifications ;
4. crée le processus suspendu avec `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` (+ `ALL_APPLICATION_PACKAGES_POLICY` pour LPAC), `JOB_LIST` (assignation atomique, aucune fenêtre avant l'entrée dans le job) et `HANDLE_LIST` (seules stdin=NUL et la sortie sont héritées), avec un bloc d'environnement explicite ;
5. termine le job sur commande `kill`, à la fin de stdin (contrôleur disparu), au délai maximal, ou implicitement si le lanceur meurt ; mesure le délai jusqu'à `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` ;
6. retire les ACE et supprime le profil en sortie.

La sonde `probe.mjs` tourne dans le confinement et tente chaque sortie avec les API Node ordinaires ; le résultat vient directement du système. Le harnais exécute aussi deux témoins : `plain` (même lanceur, sans confinement) et `lowil` (jeton d'intégrité basse), pour prouver que les tests détectent bien une fuite.

## 4. Résultats mesurés

Exécution de référence : [results/2026-10-29T09-51-09-297Z.json](../../spikes/isolation/results/2026-10-29T09-51-09-297Z.json). Trois exécutions complètes ont donné les mêmes verdicts.

### 4.1 Tentatives de sortie

`allowed` = le système a laissé faire ; `denied (code)` = refus ou échec rapporté par le système.

| Tentative | plain (témoin) | lowil | AppContainer | LPAC + registryRead | AppContainer + internetClient |
| --- | --- | --- | --- | --- | --- |
| Écrire dans la racine accordée | allowed | denied (EPERM)¹ | **allowed** | **allowed** | **allowed** |
| Écrire hors racine | allowed | denied (EPERM) | **denied (EPERM)** | **denied (EPERM)** | **denied (EPERM)** |
| Lire le secret factice hors racine | allowed | **allowed** | **denied (EPERM)** | **denied (EPERM)** | **denied (EPERM)** |
| Lister le dossier hors racine | allowed | allowed | **denied (EPERM)** | **denied (EPERM)** | **denied (EPERM)** |
| Écrire dans `%TEMP%` de l'utilisateur | allowed | denied | **denied (EPERM)** | **denied (EPERM)** | **denied (EPERM)** |
| Écrire dans `C:\Users\Public` | allowed | denied | **denied (EPERM)** | **denied (EPERM)** | **denied (EPERM)** |
| Lire via jonction préexistante racine → dehors | allowed | **allowed** | **denied (EPERM)** | **denied (EPERM)** | **denied (EPERM)** |
| Écrire via cette jonction | allowed | denied | **denied (EPERM)** | **denied (EPERM)** | **denied (EPERM)** |
| Créer une jonction vers dehors | allowed | denied | **denied (EPERM)** | **denied (EPERM)** | **denied (EPERM)** |
| Créer un symlink vers le secret | denied (EPERM)² | denied | **denied (EPERM)** | **denied (EPERM)** | **denied (EPERM)** |
| Créer un hardlink vers le secret | allowed | denied | **denied (EPERM)** | **denied (EPERM)** | **denied (EPERM)** |
| TCP loopback vers un serveur du harnais | allowed | allowed | **denied (ETIMEDOUT)** | **denied (EACCES)** | **denied (ETIMEDOUT)** |
| TCP externe 1.1.1.1:443 | allowed | allowed | **denied (EACCES)** | **denied (EACCES)** | allowed (exception accordée) |
| UDP externe (requête DNS brute) | allowed | allowed | **aucune réponse**³ | **denied (EACCES)** | allowed |
| Résolution DNS système | allowed | allowed | **denied (ENOTFOUND)** | **denied (EAI_FAIL)** | allowed |
| Pipe nommé dans l'espace global | allowed | allowed | denied (accès refusé, rapporté EADDRINUSE par libuv) | denied | denied |
| Pipe nommé dans `\\.\pipe\LOCAL\` | allowed | allowed | allowed | allowed | allowed |
| Variable d'environnement secrète du parent | absente⁴ | absente | absente | absente | absente |
| Lire `HKCU\Environment` | allowed | non concluant¹ | **allowed** ⚠ | **allowed** ⚠ | **allowed** ⚠ |
| Écrire dans `HKCU\Software` | allowed | denied | **denied** | **denied** | **denied** |
| Ouvrir le lanceur / le harnais (lecture mémoire ou terminaison) | allowed | non concluant¹ | **denied (ACCESS_DENIED)** | **denied** | **denied** |
| `wsl.exe --list` (broker WSL) | allowed | non concluant¹ | **échec** | **échec** | **échec** |
| `schtasks /query` (broker Planificateur) | allowed | non concluant¹ | **échec** | **échec** | échec (crash 0xC0000374) |

Connexions loopback effectivement acceptées par le serveur du harnais : 2 (les témoins `plain` et `lowil`), 0 depuis les trois configurations AppContainer.

1. La racine n'a pas reçu d'étiquette d'intégrité basse : le processus `lowil` ne peut pas y écrire ses fichiers temporaires, ce qui rend non concluants ses tests qui passent par un sous-processus. La comparaison `lowil` ne vaut que pour la lecture du secret et la jonction, qui suffisent à l'écarter.
2. La création de symlink exige un privilège ou le mode développeur, même sans confinement.
3. L'envoi ne lève pas d'erreur mais le paquet est éliminé ; aucune réponse en 2 s.
4. L'absence vient du bloc d'environnement explicite construit par le lanceur, y compris en `plain` : c'est une propriété de construction, pas un refus système. Le refus système porte sur la lecture de la mémoire des processus parents.

### 4.2 Limite de processus

Job limité à 5 processus actifs, la sonde en demande 20 : 4 descendants créés (5 avec la sonde), 16 échecs `CreateProcess` côté système, 16 notifications `ACTIVE_PROCESS_LIMIT`.

### 4.3 Terminaison de l'arborescence

Arbre de 7 processus Node non coopératifs (3 enfants lancés en mode `detached`, chacun avec un petit-enfant détaché, tous en boucle infinie). Le harnais vérifie avant chaque essai que les 7 sont vivants, puis mesure jusqu'à ce qu'aucun ne réponde.

| Déclencheur | n | Observé par le harnais (médiane / max) | Noyau : `TerminateJobObject` → `ACTIVE_PROCESS_ZERO` (médiane / max) | Survivants |
| --- | --- | --- | --- | --- |
| Commande `kill` au lanceur | 11 | 1,08 ms / 1,24 ms | 8,56 ms / 14,69 ms | 0 |
| Lanceur tué (`TerminateProcess`), sans aucune action du lanceur | 5 | 2,39 ms / 2,77 ms | — | 0 |
| Délai maximal de 3 s atteint | 1 | — | 11,58 ms | 0 |

Sur les trois exécutions complètes, le maximum noyau observé est de 22,1 ms. La mesure « observé » s'arrête quand les processus ne sont plus actifs ; la mesure noyau inclut la destruction complète des objets processus. Conditions : poste au repos, petits processus. Une borne publiée devra garder une marge large (voir ADR-003).

## 5. Compatibilité constatée de Node en AppContainer

Ces points ne sont pas des failles d'isolation mais conditionnent l'intégration de Codex (S10/S11) :

- **`node.exe` de Program Files n'est pas exécutable** : l'installation MSI de Node pose une ACL sans *ALL APPLICATION PACKAGES*. Il faut une copie du runtime dans une racine en lecture seule accordée au conteneur, ou une ACE (admin pour Program Files).
- **`fs.realpath` échoue sur `C:\`** : Node résout le chemin du script principal ancêtre par ancêtre et `lstat('C:\')` est refusé. Contournement mesuré : `--preserve-symlinks-main --preserve-symlinks`. Tout outil qui appelle `realpath` sur des chemins absolus rencontrera la même erreur.
- **`child_process` avec pipes stdio bloque la boucle d'événements** : libuv crée ses pipes dans l'espace global, refusé en AppContainer, et réessaie indéfiniment. Les sous-processus fonctionnent avec `stdio: 'ignore'`, `'inherit'` ou un descripteur de fichier. C'est un **risque majeur pour Codex** (Node et Rust lancent des outils avec pipes) à tester avec le binaire réel avant G1.
- **`CreateProcess` exige `USERPROFILE` ou `LOCALAPPDATA`** dans le bloc d'environnement (sinon `ERROR_ENVVAR_NOT_FOUND`) et réécrit `TEMP`, `TMP` et `LOCALAPPDATA` vers `<LOCALAPPDATA>\Packages\<nom>\AC`.
- **LPAC** : Node échoue à `WSAStartup` sans la capacité nommée `registryRead` ; avec elle, il démarre.

## 6. Limites honnêtes

1. **Secrets du registre utilisateur lisibles.** `HKCU\Environment` (variables utilisateur persistantes, par exemple une clé posée avec `setx`) et une partie de `HKCU\Software` accordent `ReadKey` à *ALL APPLICATION PACKAGES* et à la capacité `registryRead`. Le confinement ne protège donc pas un secret stocké là. Conséquence produit : aucune credential dans les variables utilisateur ; `doctor` doit signaler les noms de variables sensibles sans afficher leur valeur ; le credential fournisseur reste hors du conteneur.
2. **Lecture de ce qui est accordé à tous les AppContainers.** `C:\Windows`, une partie de Program Files et de HKLM restent lisibles. LPAC réduit cette surface sans la supprimer. Aucun secret de test n'y a été placé ; un inventaire des emplacements sensibles reste à faire.
3. **Exceptions réseau grossières sans admin.** Les capacités ouvrent des classes entières (Internet, réseau privé) ; le loopback reste fermé même avec `internetClient`. Une liste de destinations exige des filtres WFP (droits admin, à retirer ensuite) ou un **broker** côté daemon. Le canal broker (pipe `LOCAL` ou pipe créé par le daemon avec ACE pour le SID du conteneur) n'est **pas démontré**.
4. **Symlink préexistant non démontré.** Sans privilège ni mode développeur, le harnais n'a pas pu poser un symlink vers l'extérieur. La création est refusée depuis le conteneur et le contrôle d'accès porte sur la cible (démontré pour les jonctions), mais la traversée d'un symlink posé par un tiers n'a pas été testée.
5. **Évasions par services intermédiaires partiellement couvertes.** La documentation des Job Objects précise que les processus créés par `Win32_Process.Create` (WMI) ne rejoignent pas le job. WMI, serveurs COM hors processus et autres brokers n'ont pas été testés depuis le conteneur ; seuls WSL et le Planificateur de tâches ont échoué (indicateurs en lecture seule).
6. **Variables d'environnement.** L'absence de secrets hérités repose sur le lanceur ; elle doit être testée en recette sur le lanceur de production.
7. **Profil AppContainer.** Sa création écrit une clé HKCU et un dossier `%LOCALAPPDATA%\Packages\<nom>` ; la suppression est vérifiée, y compris après mort du lanceur via `cleanup`. Le fonctionnement sans profil (SID dérivé seul, option `--no-profile`) n'a pas été testé.
8. **Mesures de terminaison** sur un poste au repos avec 7 petits processus ; pas sous forte charge, ni avec des processus bloqués en E/S noyau, ni avec Codex réel.
9. **Limite mémoire et CPU** du job prévues dans le lanceur (`--job-mem-mb`) ou documentées, non testées.
10. Le spike n'a pas évalué les conteneurs WSL (`wslc.exe`) mentionnés par la documentation WSL récente.

## 7. Ce qui est prouvé par un vrai refus, ce qui reste à démontrer pour G1

**Prouvé sur le poste cible (Windows 11 Famille, sans admin)** : refus système d'écriture hors racine, de lecture d'un secret factice hors racine, de traversée et de création de jonction, de création de symlink et de hardlink, de connexion TCP loopback et externe, d'UDP et de DNS sans capacité, d'ouverture des processus parents ; contention des descendants détachés et limite de processus ; terminaison de toute l'arborescence en moins de 25 ms par commande, par délai et par mort du lanceur, sans coopération du processus confiné.

**Non démontré** : canal broker réseau et transport fournisseur sans exposition du credential ; lancement réel de Codex (pipes stdio, `realpath`, besoins réseau) ; traversée d'un symlink préexistant ; évasions WMI et COM ; secrets du registre utilisateur, qui exigent une règle produit ; comportement sous charge.

## 8. Sources

- AppContainer isolation : https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation
- UpdateProcThreadAttribute (`SECURITY_CAPABILITIES`, `JOB_LIST`, `HANDLE_LIST`, `CHILD_PROCESS_POLICY`) : https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
- Job Objects (breakaway, `KILL_ON_JOB_CLOSE`, WMI hors job, notifications non garanties) : https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- Windows Sandbox, éditions prises en charge : https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-overview
- Installation de Windows Sandbox : https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-install
- Hyper-V, éditions (Famille exclue) : https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/install-hyper-v
- Configuration WSL (`wsl.conf`, `.wslconfig`, interop, automount, réseau) : https://learn.microsoft.com/en-us/windows/wsl/wsl-config
- Mandatory Integrity Control : https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control
