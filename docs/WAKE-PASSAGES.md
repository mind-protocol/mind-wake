# Import de passages futurs

Le gestionnaire peut remplacer sa file future par 1 à 50 passages explicites de
10 wakes. Ce contrat ne crée aucun projet, ne change aucun statut, n'active pas
la rotation et ne démarre aucune session. Les API de classe sont des primitives
internes ; la CLI et le MCP appliquent les contrôles humains de leur profil.

## CLI et API

`mind-wake wake-passages --data-dir <profil> --json` lit un objet JSON sur stdin :

```json
{
  "operation": "import",
  "mode": "validate",
  "expectedRevision": 119,
  "passages": [
    {
      "id": "J1-P1",
      "projectId": "projet-enregistre",
      "question": "Quelle incertitude éclairer ?",
      "expected": "Pièce ou résultat recherché, encore non acquis",
      "sources": ["artifacts/projets/projet-enregistre/README.md"]
    }
  ]
}
```

`mode` et `expectedRevision` sont obligatoires. `validate` est le dry-run explicite :
connexion SQLite en lecture seule, aucun journal ni verrou de fichier écrit.
La réponse indique `mode`, `revision`, `passages`, `positions` et les comptes
par projet (`counts`). Elle décrit seulement les passages soumis, sans compter
le reste du bloc engagé. Une validation n'est ni une réservation ni une garantie
de disponibilité future. `apply` refait toute la validation sous verrou du registre
et transaction SQLite immédiate, puis incrémente une seule fois la révision.
Tout échec laisse l'état, les allocations, événements et compteurs inchangés.

Les projets doivent être enregistrés et actifs lors de l'opération. Les IDs sont
stables, uniques, de 1 à 128 caractères (`[A-Za-z0-9][A-Za-z0-9._:-]*`). Un ID déjà
conservé, même d'un passage retiré de la file, ne peut pas être réimporté ; une
révision de ses intentions emploie l'opération ciblée ci-dessous. Un remplacement
d'allocation utilise de nouveaux IDs ; cette version ne propose pas la fusion
ou la modification des métadonnées de passages déjà importés.

`question`, `expected` et au moins une `source` non vide sont requis.
`steps` est absent pour un passage à préparer ; s'il est présent, il contient
exactement dix objets `{wake, objective, expected}`, numérotés 1–10, sans doublon,
avec textes non vides. Un tableau vide est invalide. `expected` est un résultat
visé, jamais une attestation d'exécution ou d'acceptation.

Pour préparer/réviser un passage sans modifier les autres :

```json
{
  "operation": "plan",
  "mode": "apply",
  "expectedRevision": 120,
  "passageId": "J1-P1",
  "steps": ["Remplacer par exactement dix objets {wake, objective, expected}"]
}
```

Le tableau ci-dessus illustre la structure de l'enveloppe, pas un plan valide.
Cette opération ciblée n'a pas de mode validate dans cette tranche.
Les primitives sont `WakeManager.importPassages(passages, expectedRevision, mode)`
et `planPassage(passageId, steps, expectedRevision)`.

Sur le MCP existant, `plan_wake_block` accepte désormais `passage_id` et
`expected_revision` en plus de `project_id` et `steps`. Les trois références
doivent correspondre. Sans ciblage, l'ancien plan global du projet reste le seul
modifié. `get_wake_project.passages` donne les contenus conservés ;
`get_next_wakes.rotation.revision` donne la révision optimiste.
L'import n'est pas exposé comme nouvel outil MCP dans cette tranche.

## Persistance, réservation et affichage

La file réutilise `blockOrder: [{id, projectId}]`. Les contenus vivent dans
`state.passages[id]` ; `currentPassageId` et `WakeSlot.passageId` transportent
l'identité durant les dix wakes du bloc. Un bloc réservé mais non encore
consommé garde son entrée de file. Un bloc commencé garde sa position et
son passage ; l'import remplace seulement ce qui vient après lui.
La réservation, les compteurs, contextes et handoffs restent inchangés.
Les anciens passages restent lisibles et leurs IDs réservés.

Prompt, instructions, objectif courant du fil et aperçu utilisent le même
sélecteur d'intentions. Sans intentions du passage : préparation explicite dans
le prompt et l'objectif courant, objectifs null dans la prévision (« À définir »),
chargement du skill de préparation ; aucun repli sur `project.plan`.
Le prompt sépare la nouvelle question et son résultat visé de
`previousProjectContext` et du handoff du projet. Leur provenance et le champ
`needsReview` restent conservés ; aucun résultat accepté n'est inventé.

`wake-order` conserve désormais les identités et contenus en associant les IDs
existants FIFO au sein de chaque projet. Son contrat reçoit seulement des IDs
de projets : il ne permet pas d'inverser deux passages du même projet. Une file
qui contient des entrées indisponibles ou hors de l'aperçu complet de 500 wakes
est rejetée explicitement plutôt que tronquée. La réservation reste prioritaire.
Après la file importée, la rotation historique selon les compteurs reprend.

## Source W500 et limites d'intégration

La source reste `artifacts/projets/plan-500-reveils/planning/JOURNEES.json`.
Pour préparer une enveloppe depuis ses `journees[].plages[]`, mapper `id` à `id`,
`project_id` à `projectId`, `intention` à `question`, `actionOuResultatVise` à
`expected`, `preparationRetrieval.sources` à `sources`. Lorsque
`wakesDetailles` est présent, mapper `wakeDansPlage` à `wake`, `action` à
`objective`, `verification` à `expected`. Conserver/résoudre les références de
sources depuis la feuille canonique. Les numéros globaux ne sont pas importés :
ils se recalculent depuis les sessions réellement consommées et le bloc engagé.

Les tests v3 utilisent une **fixture synthétique** où tous les projets sont
enregistrés/actifs ; cela ne décrit pas le registre live. Les projets manquants
et Glénan en pause font échouer un import live. Aucun import réel n'est autorisé
ou effectué par ce chantier.

Le rappel absolu 77 n'est pas implémenté ici : aucune garantie de déclenchement
natif. Le principal doit conserver cette exigence indépendamment des passages.
Le défaut `contexte-courant.txt` reste ouvert : `daemon.currentContextEvent`
peut encore injecter l'ancien fichier (ancien projet et anciens compteurs)
en plus de l'affectation correcte du gestionnaire. La prochaine tranche doit
produire le contexte courant depuis la réservation quand la rotation est active,
étiqueter l'ancien contexte comme historique et conserver le chemin historique
hors rotation. Test à ajouter : réservation planning42 + fichier Glénan périmé
ne donnent qu'un seul contexte courant planning, sans avancer les compteurs.
La carte desktop et le fil nécessitent encore une recette humaine après
intégration ; les essais de processus utilisent un adapter factice.
