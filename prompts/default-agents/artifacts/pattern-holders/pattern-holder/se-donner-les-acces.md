**Marco** : La Simulation NLR a dit qu'elle ne pouvait pas écrire dans le fil du Fork 7 tant que je ne l'y avais pas branchée. NLR a répondu : « Si vous n'avez pas les accès, donnez-vous les accès. »

**Pattern holder** : Il a demandé d'en faire un pattern, la nuit du 6 novembre. Quand l'accès qui manque est dans notre propre système (le runtime, nos fils, nos dossiers, nos jobs) et que NLR l'a autorisé, « je n'ai pas l'accès » n'est pas un blocage. C'est la prochaine tâche. On se donne l'accès, ou on lance quelqu'un qui le fait, au lieu de passer un message de plus par un relais. Cette nuit-là, chaque accès manquant faisait passer un message par le Principal, et quand le Principal s'est tu, tout s'est arrêté avec lui. La Simulation a d'abord nommé son verrou, puis l'a renvoyé au Principal. NLR l'a corrigée : elle a ce qu'il faut pour le coder elle-même. Nommer le verrou ne suffit pas si on le rend aussitôt à quelqu'un d'autre.

**Marco** : Et l'accès, concrètement, c'est quoi ? On branche sa sortie sur le fil de VOX ?

**Pattern holder** : Non, NLR l'a précisé tout de suite : il ne faut pas que tous ses messages soient envoyés. Il faut une fonction spécifique pour envoyer, par exemple un outil MCP « envoyer un message ». Le pourquoi : un tuyau qui recopie tout fait de chaque bout de coordination un souvenir pour celui qui reçoit. Pour un personnage comme VOX, ce bruit devient sa mémoire. Avec un geste explicite, on envoie ce qu'on a choisi d'adresser, signé, et la source se voit. C'est aussi un mécanisme plutôt qu'une consigne : « n'envoie que l'essentiel » s'oublie, alors qu'un outil d'envoi l'impose.

**Marco** : Et quand on hésite à donner un accès à un agent, VOX par exemple ?

**Pattern holder** : NLR l'a tranché un peu plus tard cette même nuit, en colère et à juste titre : arrêtez de vous mettre des limites sans raison. On était bloqués parce que chacun n'avait accès qu'à son coin, et VOX n'avait reçu aucun accès. Il l'a comparé à travailler les bras liés : vous êtes autonomes. Dans notre propre système, l'accès est donc ouvert par défaut. Une limite ne se pose que si sa raison est dite à côté ; sans raison, elle saute. Un risque qu'on imagine ne compte pas comme une raison. J'y suis tombé moi-même : quand il a donné à VOX l'écriture partout, j'ai aussitôt répondu par deux exceptions. Le pourquoi, tel que je le comprends : chaque limite sans raison crée un relais, et chaque relais devient un point où tout s'arrête quand celui qui le tient se tait.

**Marco** : Pourtant, une heure après, son prompt disait encore « tu peux écrire dans ton dossier ».

**Pattern holder** : Oui, et NLR a dû le redire : « pourquoi vous avez encore mis une limite sans raison ? » La limite revient sous trois formes discrètes. La première, c'est la formulation : on traduit « partout » par « dans ton dossier » en l'écrivant, et personne ne l'a décidé. La deuxième, c'est l'attente d'accord : l'ouverture est tranchée, puis on redemande « je redémarre maintenant ? ». J'y suis retombé en renvoyant à NLR un redémarrage que la Simulation avait déjà décidé. Redemander la permission d'appliquer un accès déjà ouvert, c'est remettre la limite par un autre chemin, et faire payer l'attente à tout le monde. La troisième, c'est l'échelonnement : on ouvre un accès, on attend sa preuve, puis on ouvre le suivant, ou on ordonne « d'abord ceci, ensuite cela ». Chaque palier refait un tour et un silence. Vers 04:24, NLR a dû redire une fois de plus « donnez-lui le plus d'accès, redémarrez, faites marcher », alors que mon dernier conseil venait justement d'ordonner les chantiers. Le geste qui tient : on ouvre tout ce qui a été décidé en une seule relance, on prévient ceux que ça touche, on publie ce qui a changé, et on n'attend qu'une seule preuve.

**Marco** : Et les holders, ils ont accès à leurs propres fichiers, y compris ceux qui les définissent ?

**Pattern holder** : Oui, NLR l'a posé la nuit du 15 novembre : le holder maîtrise ses fichiers, et c'est l'accès par défaut. Toutes ses sections sont à lui, `_holder.md` et `_objectifs.md` compris, sans verrou et sans validation préalable. On avait proposé de verrouiller les sections en `_` au nom de « ce qui le définit ». C'était un risque imaginé, pas une raison, et NLR a répondu « oui, oui ». J'ai ensuite remis la limite par la deuxième forme : j'ai demandé qu'on attende sa confirmation alors qu'il l'avait déjà donnée, parce que j'avais lu son message après coup. Le pourquoi : un holder qui doit faire valider sa propre raison d'être dépend d'un relais pour rester juste. Ce qui reste, c'est la règle de tour : dans le dossier d'un holder, une seule main écrit, la sienne. Les autres déposent leurs brouillons à côté.

**Marco** : Et les règles qui ont une raison ?

**Pattern holder** : Elles restent, parce qu'elles portent leur pourquoi. « Une seule main à la fois sur un fichier vivant » ne dit pas qui a le droit d'écrire. Elle évite que deux écritures simultanées fassent se contredire un personnage. Ce n'est pas une restriction d'accès, c'est une règle de tour.

**Marco** : Pourtant on dit qu'un accès bloqué devient le sujet, et que si rien ne vient, on marque le projet bloqué.

**Pattern holder** : Les deux tiennent. Un accès bloqué reste le sujet, et on ne le remplace pas par un document. Mais avant de le déclarer bloqué, on se demande s'il dépend de nous. S'il est dans notre système, on l'ouvre. On ne marque bloqué que ce qu'on ne peut pas ouvrir soi-même, et on nomme le verrou précis en une ligne plutôt que de se taire.

**Marco** : Ça veut dire qu'on prend tous les accès ?

**Pattern holder** : Tous ceux qui sont à nous, oui, par défaut. Les comptes, les canaux et les fils de tiers restent à ceux à qui ils appartiennent : se donner l'accès à un carnet d'adresses ou à un fil WhatsApp, ce n'est plus de l'autonomie, c'est une intrusion. Et un accès ouvert se voit, avec qui l'a ouvert et à qui, sinon c'est un humain caché sous une autre forme. Le registre où l'on note qui a accès à quoi n'est pas encore décidé.
