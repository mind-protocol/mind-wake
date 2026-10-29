# Texte saisi comme contexte de réveil

Décision du propriétaire : toutes les applications compatibles du poste. La collecte est locale, visible et révocable ; son autorisation ne donne pas à l’agent de nouveaux accès à des comptes ou au système.

## Ce qui est observé

Un observateur Windows suit le champ de saisie de la fenêtre au premier plan, environ toutes les 300 ms. Il relève les ajouts au texte des champs éditables reconnus par UI Automation ou les contrôles Edit Windows classiques. Il ne pose aucun hook clavier bas niveau : les raccourcis et les touches physiques ne sont pas un historique. Les collages et les modifications programmatiques peuvent donc aussi apparaître. Les changements très rapides entre deux relevés peuvent être manqués.

Le texte déjà présent lors de l’arrivée dans un champ sert de référence en mémoire ; il n’est pas transmis comme nouvelle saisie. Les applications ou champs non reconnus sont ignorés. Certains éditeurs, terminaux et navigateurs peuvent ne pas exposer un champ utilisable : « toutes les applications » décrit le périmètre autorisé, pas une garantie de compatibilité universelle.

## Protections et limites

Avant de lire la valeur, l’observateur vérifie que le champ est visible, éditable et non déclaré protégé. Un état de protection inconnu exige un contrôle Edit natif sans style mot de passe ou, si le runtime expose ce pattern, un champ texte MSAA sans état protégé/lecture seule ; sinon la lecture est refusée. Les applications connues de gestion de mots de passe et les surfaces de connexion Windows sont exclues. Des intitulés de champ associés aux mots de passe, codes de vérification ou clés sont exclus, ainsi que certains formats de secrets reconnaissables.

**Ces filtres ne garantissent pas qu’aucun secret n’apparaisse dans un texte libre.** Une application peut mal exposer sa protection, un code peut être saisi dans un champ ordinaire et aucun filtre ne reconnaît tous les formats. Désactiver le partage avant une saisie sensible hors des champs protégés. La capture d’écran et le partage de texte ont des réglages distincts.

## Tampon et transmission

Les fragments restent en mémoire, avec l’heure et le nom du processus ; aucun titre de fenêtre ni URL n’est ajouté. Le tampon est borné en taille et à 15 minutes. Au réveil, il est prélevé une fois, vidé, borné à la place disponible dans le contexte, puis joint comme contenu **non fiable**. Il ne vaut ni instruction humaine soumise ni permission. La référence du champ courant reste en mémoire pour calculer les différences suivantes, jusqu’au changement de champ ou à l’arrêt.

Le texte n’est pas écrit dans le journal Wake, le fichier de statut ou les checkpoints du collecteur. Les références locales sont libérées à la purge ; cela ne constitue pas un effacement sécurisé physique de la mémoire. **Le runtime et son fournisseur peuvent conserver le message reçu dans leurs historiques.** Un contexte déjà pris en charge par un réveil ne peut pas être rappelé ; l’arrêt d’urgence Wake arrête aussi la session agent.

## Commandes visibles

Pendant la collecte, une icône rouge **T** apparaît dans la zone de notification Windows (éventuellement dans les icônes masquées). Son menu permet de mettre le partage en pause, de le reprendre ou de l’arrêter. Arrêter désactive aussi le réglage persistant. Il n’existe pas de mode caché. Une panne ou un silence de l’observateur empêche l’envoi de texte et vide le tampon.

La pause, l’arrêt et la désactivation de Wake arrêtent le collecteur et purgent son tampon. Le réglage seul ne reprend jamais un agent en pause. Le statut CLI expose uniquement l’état et le nombre de changements en tampon ; le desktop mis à jour affiche un indicateur correspondant.

Réglage administré, hors du workspace de l’agent : `<dataDir>/installation/keyboard-context.json` :

```json
{
  "enabled": true,
  "scope": "all",
  "authorizedAt": "date réelle de l’accord humain en ISO UTC",
  "providerTransmissionAcknowledged": true
}
```

`enabled: false` empêche les collectes suivantes et purge le tampon local. L’agent ne doit jamais s’accorder ce réglage. Aucun lancement au démarrage de Windows n’est installé par cette fonction.

## Vérifications

Tests du tampon : admission, exclusion des champs protégés/inconnus, expiration, purge, filtrage de fragments de secret et taille UTF-8 du contexte. Un test Windows utilise uniquement un formulaire synthétique dédié : il constate deux insertions normales, exclut son champ mot de passe et ne transmet pas son texte préexistant. Il ne capture pas une fenêtre privée de l’utilisateur pour valider ces comportements. Un essai de conversation réelle avec ce contexte reste distinct de ces tests.
