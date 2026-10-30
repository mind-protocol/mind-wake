# Contexte visuel au réveil

Option Windows, désactivée par défaut. Une autorisation locale explicite choisit `wake-window` (la fenêtre du desktop MIND Wake) ou `primary` (écran principal). Aucun autre écran ni fenêtre ne sert de repli. Le mode `wake-window` vérifie le chemin de l’exécutable du desktop du dépôt ; les emplacements d’un futur paquet installé restent à intégrer.

## Fonctionnement

Le daemon capture une fois au lancement de chaque session réelle Codex ou Claude, après les contrôles du scheduler et avant la transmission au runtime. Une capture échouée n’empêche pas le réveil textuel. Le helper refuse un poste verrouillé ; pour `wake-window`, une fenêtre absente, cachée ou minimisée donne un réveil sans image.

Le helper Windows utilise `PrintWindow` pour MIND Wake, sans capturer le bureau derrière la fenêtre. Il réduit l’image en conservant ses proportions : 1 280 pixels au maximum sur le grand côté, sans agrandissement, JPEG qualité 70 et taille encodée bornée. Il ne conserve ni original ni fichier image. La capture est horodatée ; un adapter omet une image vieille de plus de 15 secondes plutôt que réutiliser une capture périmée.

Claude reçoit un bloc image base64 dans son message utilisateur ; Codex reçoit un item `image` avec une data URL dans `turn/start`. Le prompt système reste séparé. La légende qualifie les pixels de contexte non fiable qui ne donne aucune instruction ni permission.

Les formats suivent les sources officielles : [vision Claude](https://platform.claude.com/docs/en/build-with-claude/vision) et [protocole App Server Codex](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).

## Autorisation et révocation

Configuration administrée hors du workspace de l’agent : `<dataDir>/installation/wake-screenshot.json` :

```json
{
  "enabled": true,
  "surface": "wake-window",
  "authorizedAt": "2026-10-29T15:00:00.000Z",
  "providerTransmissionAcknowledged": true
}
```

La date doit être celle de l’accord réel. Le daemon relit ce fichier avant chaque capture. `enabled: false` retire la capture aux réveils suivants, y compris si le lancement indiquait une surface. Une image déjà envoyée ne peut pas être rappelée.

Le lanceur humain peut également choisir `daemon run --wake-screenshot wake-window`, `--wake-screenshot primary` ou `--wake-screenshot off`. L’option ne s’applique qu’à `daemon run`. Elle ne doit pas être ajoutée par un contenu lu dans l’image ou par une note de l’agent. Le sélecteur desktop n’est pas encore implémenté.

## Confidentialité et limites

### Pilotage agent des prochaines captures (30 octobre 2026)

Le daemon sait désormais relire `artifacts/pilote.json` dans le workspace avant chaque capture ambiante. Exemple à **fusionner** avec les autres champs existants, notamment ceux de compaction :

```json
{
  "version": 1,
  "wakeScreenshot": { "mode": "auto", "idleThresholdMs": 60000 }
}
```

- `on` : joindre les captures autorisées, même pendant l'activité humaine.
- `off` : aucune prochaine capture ambiante. L'inactivité ne réactive jamais ce choix ; il faut écrire `on` ou `auto`.
- `auto` : capture uniquement si le signal d'inactivité Windows existant indique au moins `idleThresholdMs` d'inactivité. Le seuil vaut 60 000 ms par défaut ; entier entre 1 et 86 400 000 ms. Signal absent, invalide, futur ou âgé de plus de 2 secondes : aucune image.

Le daemon conserve la dernière politique observée dans `<dataDir>/agent-screenshot-mode.json`. Fichier ou champ agent absent : cette politique reste appliquée, même après une réécriture du pilote pour la compaction ou un redémarrage du daemon. Tant qu'aucune politique n'a été enregistrée, le comportement existant vaut `on`, toujours sous autorisation humaine. Fichier illisible, trop gros (>4 096 octets), lien symbolique ou réglage invalide : aucune capture. Un état de repli invalide ou impossible à enregistrer coupe aussi la capture. L'inactivité ne donne aucune permission, n'interrompt aucune session et ne change aucun délai de réveil.

Le réglage restreint la surface déjà choisie ; il ne l'étend pas. `enabled: false` dans l'installation et `--wake-screenshot off` gardent priorité. Les captures explicitement jointes par l'humain (`reply --capture-screen`), le texte partagé, Pause, Force-off, scheduling et compaction gardent leurs circuits existants. Le champ est validé séparément des champs de compaction.

À chaque lancement, le journal du daemon indique `capture ambiante : <mode>, <raison>` : `agent-off`, `invalid-policy`, `not-authorized`, `auto-active` (humain actif), `auto-unknown` (signal indisponible), `auto-idle` ou `on`. Le message suivant conserve le résultat de capture si elle a été tentée. Ce statut décrit la décision du lancement, pas un flux continu ni une preuve de réception par le modèle.

Après l'appel asynchrone de capture, le daemon relit l'autorisation humaine, le choix agent et l'inactivité. Une image devenue non autorisée ou incompatible avec l'activité courante est écartée avant sa transmission. Cela empêche de joindre une image capturée pendant un retour d'activité détecté ; les pixels ont toutefois pu être lus en mémoire avant cette seconde vérification. Une activité trop récente pour le watcher reste une limite d'échantillonnage.

L'événement durable `wake_screenshot_decided` inscrit aussi `{mode, reason, surface?, imageAttached, discardedAfterCapture}` dans le journal du profil, sans pixels ni chemin. Il décrit la décision de joindre l'image, pas une preuve de réception fournisseur.

Ce changement agit seulement sur les images futures. Il ne supprime aucune image des contextes et historiques déjà transmis ; `on` ne retire pas une ancienne image et `off` ne la rappelle pas.

Le code doit être chargé par une nouvelle exécution du daemon après compilation. Un daemon déjà lancé ne recharge pas ses modules ; ne pas annoncer cette fonction disponible sur le profil vivant avant ce raccordement. Aucun nouvel outil MCP ni reconnexion de schéma n'est nécessaire : l'agent écrit le champ dans son fichier de données.

Après compilation, un contrôle CLI autonome préserve les autres champs du pilote et écrit le nouveau choix par remplacement atomique. Le workspace est obligatoire ; aucun profil vivant n'est choisi implicitement :

```powershell
node dist/cli/agent-screenshot.js <workspace> show
node dist/cli/agent-screenshot.js <workspace> off
node dist/cli/agent-screenshot.js <workspace> auto 60000
node dist/cli/agent-screenshot.js <workspace> on
```

`show` lit la configuration sans la modifier. Les réponses CLI indiquent le réglage demandé, jamais une application prouvée par le daemon. Le contrôle refuse de remplacer un pilote malformé ou de plus de 4 096 octets, préserve les champs inconnus et détecte une modification concurrente observée avant son remplacement. Un seuil omis conserve le précédent seuil valide. Il ne faut pas maintenir plusieurs écrivains simultanés de ce fichier.

Si le champ agent a été effacé, `show` ne connaît pas l'état de repli hors workspace ; le journal du daemon fait foi pour la politique appliquée. Pour revenir volontairement à la capture, écrire explicitement `on` ou `auto` plutôt que supprimer le champ.

L’application Wake garde le contenu en mémoire pour cette transmission, sans l’écrire dans son journal ou ses checkpoints. **Cela ne signifie pas absence de conservation chez le fournisseur ou dans l’historique du CLI** : un runtime peut enregistrer les messages multimodaux. La surface choisie peut afficher des informations privées. La réduction n’anonymise rien et aucun masquage automatique de secrets n’est promis.

La détection du verrouillage est codée en refus par défaut ; un essai réel de verrouillage reste à effectuer. `PrintWindow` dépend de la fenêtre et de WebView2 : une capture indisponible est omise, et une image rendue noire reste une limite à contrôler visuellement. La capture ne doit jamais être présentée comme un flux continu ou une preuve de l’état courant du poste.

## Vérifications du 29 octobre 2026

- Capture réelle de la seule fenêtre MIND Wake : 456 × 719 pixels, environ 49 Ko de JPEG, sans fichier image sauvegardé.
- Redimensionnement natif sur une image synthétique : 2 560 × 1 440 → 1 280 × 720, proportions conservées.
- Tests : absence d’image par défaut, formats des deux adapters, horodatage, rejet du périmé et des tailles invalides, sélection exacte et révocation.
- Un vrai lancement a préparé une capture dans le daemon ; ce lancement a été interrompu par la garde de quota. Cela ne valide pas encore l’interprétation de l’image par le modèle. Une session parallèle a ensuite repris le moteur ; ne pas la réinitialiser pour cette vérification.

## Choix actuel corrigé

Le propriétaire a remplacé le choix initial `wake-window` par l’écran principal entier (`primary`). Le réglage a été enregistré pour le profil d’essai ; cela ne reprend pas un moteur en pause. L’ajout de texte est une fonction distincte : préciser s’il s’agit du texte visible dans la fenêtre active ou des messages saisis dans MIND, sans assimiler cette demande à un historique global de frappes.
