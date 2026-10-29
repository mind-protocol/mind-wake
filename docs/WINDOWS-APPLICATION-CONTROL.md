# Lanceur Windows et Application Control

## Incident de première installation

Le rapport du poste d’Aurore signale un blocage Code Integrity 3033/3077 du lanceur
`mindwake-job-bc36d3610f8ff46b.exe`, compilé localement et non signé. Le MCP et la
jauge Codex peuvent fonctionner alors que ce composant reste bloqué : ils ne prouvent
pas qu’un réveil peut démarrer. Ce rapport vient du poste destinataire ; il n’a pas
été reproduit sur ce poste de développement.

Le lanceur crée le Job Object qui contient Codex et ses descendants. Il reste utilisé
pour Pause, Arrêt et la réconciliation. Aucun chemin de lancement direct sans ce
contrôle n’est ajouté.

## Vérifier avant d’activer

Après `npm run build`, exécuter sur le poste destinataire :

```powershell
node scripts/check-job-launcher.mjs --data-dir "$env:LOCALAPPDATA\mind-wake-aurore-live"
```

Ce test lance uniquement un Node et son descendant, puis termine leur Job Object.
Il n’appelle aucun modèle, n’active aucune policy et ne change aucun état de session.
Il peut compiler le lanceur de développement dans `runtime/` si aucun binaire distribué
n’est fourni. Le JSON donne le chemin exact, le SHA-256 et la confirmation d’arrêt.
`setup --apply` effectue désormais ce contrôle avant de préparer le profil et le hub.
Un succès prouve ce démarrage/arrêt sur ce PC à cet instant, pas un réveil Codex complet.

Si Windows bloque le fichier, conserver les événements 3077 et les événements 3089
corrélés par ActivityID, notamment PolicyID et VerificationError. Une signature
Authenticode valide n’est pas une garantie que l’éditeur est autorisé par cette policy.
Une autorisation par fichier/éditeur relève de l’administrateur du poste. Ne pas
désactiver globalement Code Integrity et ne pas importer un certificat auto-signé
pour présenter cela comme une distribution reconnue.

## Préparer une distribution signée (éditeur)

```powershell
npm run build
node scripts/native-launcher-release.mjs --build C:\releases\wake-native-NEW
```

Le répertoire doit être neuf. Signer ensuite le `.exe` annoncé avec le service de
signature ou le certificat de signature de code de l’éditeur, avec horodatage.
Les clés privées restent dans le service/coffre de signature ; aucun secret n’est
passé dans le chat ni commité. Puis :

```powershell
node scripts/native-launcher-release.mjs --seal C:\releases\wake-native-NEW
node scripts/package-windows.mjs --stage C:\releases\wake-stage-NEW --archive C:\releases\wake-NEW.zip --native-launcher C:\releases\wake-native-NEW
```

Le scellement exige une signature Authenticode `Valid` sur le poste de build et
enregistre le hash du fichier **après** signature. Le packaging existant exige aussi
le build desktop release et revérifie la signature du lanceur. Le champ global `signed:false` reste présent : signer le
lanceur ne signe pas l’app desktop ni tous les autres composants.

Le runtime choisit `bin/native/` avant toute compilation locale, valide le manifeste,
le hash du binaire et la version de la source. Un bundle présent mais incorrect est
refusé, sans substitution par un lanceur non signé. Le manifeste contrôle la cohérence
et la corruption ; il n’est pas une racine de confiance cryptographique indépendante.
Windows décide si le binaire peut s’exécuter. Une nouvelle source nécessite un nouveau
build signé. Sans `bin/native/`, le parcours de développement local reste disponible.
Une autorisation par hash doit viser le fichier exact utilisé : recompiler une même
source peut produire un hash binaire différent. Ne pas confondre le hash de la source,
celui de l’exécutable et celui de l’archive.

## Critère de résolution

Il reste à obtenir une signature éditeur acceptée sur le poste destinataire, ou une
autorisation administrative explicite, puis à exécuter le test local et un réveil
Codex réel avec réception de la réponse dans l’app. Vérifier aussi Pause et Arrêt sur
ce runtime réel. Aucun binaire signé ou réveil réussi chez Aurore n’est revendiqué ici.
Les autres exécutables, DLL natives et scripts restent soumis à la policy du poste ;
la correction de ce lanceur ne constitue pas une certification de tout le produit.

Sources Microsoft : [événements Code Integrity](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/operations/event-id-explanations),
[diagnostiquer les événements 3077/3089](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/operations/appcontrol-debugging-and-troubleshooting),
[signature de code et App Control](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/deployment/use-code-signing-for-better-control-and-protection).
