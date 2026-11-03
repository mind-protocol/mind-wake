# Arbre technologique des agents

Carte locale des capacités des agents, indépendante de tout produit. Chaque fiche décrit une action, un exemple concret et un critère de réussite. Aucun accès externe ni dépendance.

Depuis la racine du dépôt :

```powershell
node docs/agent-tech-tree/serve.mjs
```

Ouvrir <http://127.0.0.1:8791>. `Ctrl+C` arrête le serveur. `TECH_TREE_PORT` permet de choisir un autre port.

`tree.json` est la source des contenus : branches, niveaux, types de capacités, prérequis, exemples (`example`) et critères de réussite (`proof`). `index.html` le charge à chaque ouverture ; modifier le JSON puis rafraîchir suffit. Il faut le serveur local, car les navigateurs bloquent généralement `fetch` entre fichiers `file://`.

Cliquer une capacité met en évidence ses ancêtres et ses prolongements et affiche ses détails. La recherche couvre aussi les exemples et les critères de réussite. Filtres, vue entière, retour à 100 % et touche Échap complètent la navigation. Le bouton « Objectif : colonie » rejoint directement le dernier jalon, aussi accessible avec `/#colony`.

La progression couvre neuf niveaux et six branches, jusqu’à une colonie autonome sur un serveur : processus supervisés, échanges persistants, file de tâches, connaissances communes, allocation des ressources, décisions collectives, sauvegardes, mises à jour et reprise après incident. Le scénario final vérifie un fonctionnement sur plusieurs jours et après interruption. Cette autonomie d’organisation ne suppose ni indépendance énergétique, ni ressources infinies, ni autofinancement.

La branche « Wallet & échanges » ajoute une septième branche et six capacités : wallet, réception de fonds, signature autorisée, paiement de service, rémunération et trésorerie commune. Elle figure comme extension économique dans le parcours. Ces cartes décrivent des capacités à construire ; elles ne créent aucun wallet, ne manipulent aucun secret et ne réalisent aucune transaction.

Les niveaux et les liens sont une proposition de lecture. « Brique de base », « Capacité composée » et « Capacité avancée » décrivent la composition des capacités ; ils ne revendiquent ni disponibilité commerciale ni maturité technique. La carte sert à concevoir ou comparer des agents à partir de comportements observables.

Pour ajouter une capacité : choisir un `id` unique, une `branch` existante, un `level` indexant `levels` (actuellement 0 à 8), un `status` défini et des `requires` existants sans cycle. Ajouter une description opérationnelle, un `example` et un `proof`. `slot: 1` permet une seconde carte dans une case. Les prérequis se placent au même niveau ou avant la capacité. La taille du canevas suit le nombre de niveaux et de branches ; les positions des cartes restent explicites pour garder la carte lisible. `goal` désigne l’identifiant du jalon final.
