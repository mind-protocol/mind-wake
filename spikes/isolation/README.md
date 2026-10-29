# Spike S2 — isolation Windows (AppContainer + Job Object)

Prototype de faisabilité, pas du code produit. Analyse et décision : [docs/feasibility/isolation-windows.md](../../docs/feasibility/isolation-windows.md) et [ADR-003](../../docs/decisions/ADR-003-isolation-windows.md).

## Contenu

| Fichier | Rôle |
| --- | --- |
| `src/Sandbox.cs` | Lanceur natif (P/Invoke) : AppContainer ou LPAC, capacités, ACE par racine, Job Object assigné dès la création (`PROC_THREAD_ATTRIBUTE_JOB_LIST`), poignées héritées explicites, environnement explicite, terminaison par commande, fin de stdin, délai ou mort du lanceur. Modes de comparaison `lowil` (intégrité basse) et `plain` (sans confinement). |
| `probe.mjs` | Sonde Node exécutée dans le confinement : tente réellement chaque sortie et rapporte le code d'erreur du système. |
| `run-tests.mjs` | Harnais : compile le lanceur, crée les fixtures factices, lance la sonde dans 5 configurations, mesure la terminaison d'arborescence, nettoie, écrit `results/<horodatage>.json`. |
| `results/` | Résultats bruts de l'exécution de référence (chemins du profil remplacés par `%USERPROFILE%`). |

## Exécution

Aucun droit administrateur. Prérequis : Node (testé en v24.17.0) et le `csc.exe` de .NET Framework 4.x livré avec Windows.

```bash
node spikes/isolation/run-tests.mjs --iterations 10
```

Effets temporaires hors du dossier du spike, tous annulés en fin d'exécution et vérifiés : profil AppContainer `mindwake.spike.s2` (clé HKCU de correspondance et dossier `%LOCALAPPDATA%\Packages`), fichiers sondes `C:\Users\Public\mindwake-s2-probe.txt` et `%TEMP%\mindwake-s2-probe.txt` écrits seulement par l'exécution témoin `plain`, clé `HKCU\Software\MindWakeS2Probe` créée par la même exécution témoin. Le harnais copie `node.exe` dans `.work/runtime` : l'installation MSI de Node n'accorde aucun droit aux AppContainers.

Les secrets sont factices (`FAKE-SECRET-<aléa>` dans un fichier, `MIND_WAKE_FAKE_SECRET` dans l'environnement du harnais) ; la sonde ne rapporte que la taille lue, jamais le contenu.
