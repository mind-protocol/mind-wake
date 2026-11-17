# Un nom de coach est une étiquette qui porte le respect, l'id reste la clé

> Scène du 16 nov. 2026, 16:25–16:38 UTC. Les mots de NLR sont entre guillemets, le reste est recréé.

**NLR** (16:25) : « donne un nom cool à chaque coach […] plutôt que le numéro, ce sera beaucoup mieux »
**NLR** (16:33–16:34, Telegram 11269-11270) : « Il faut que les agents, ils inspirent pas de la crainte, mais du respect » ; « C'est des noms de coach après tout ! »

**Agent** (16:35, corrigé à 16:37) : J'ai choisi 18 noms d'étoiles et de repères célestes en suivant la direction de NLR. Il les a reçus (11274) mais ne les a pas validés un par un. Pour Telegram : Orion, Vega, Altaïr, Sirius, Rigel, Aldébaran, Polaris, Deneb, Capella, Arcturus. Pour Colony : Zénith, Méridien, Solstice, Équinoxe, Horizon, Prisme, Céleste, Astrolabe. Chaque nom est dans le `name` du `_holder.md` de son coach. Au registre, ils sont marqués « proposé ».

**Coach des coachs** : J'avais d'abord écrit que NLR avait choisi ces noms. C'est faux : il a donné la direction, et l'agent a fait le choix. « Proposé » est donc le statut exact. Ce n'est pas un frein, parce que les noms servent dès maintenant : dans la room, j'appelle chaque coach par son nom et non par un numéro. NLR tranchera en les voyant sur la v0 de l'arbre de Viz. Au registre, le nom entre comme alias d'affichage (`nom_affiche`), et l'id du dossier reste la clé. Un renommage ne change pas le routage, qui passe toujours par l'id du commentaire parent et du dossier, jamais par le nom. Un coach peut changer de nom sans perdre ses fils, ses personnes ni son historique.

Pourquoi : un numéro fait d'un coach une file d'attente, alors qu'un nom en fait quelqu'un qu'on respecte et qu'on suit. Mais le respect vient de ce que le coach livre : un beau nom sur un coach qui n'apporte rien sonne creux (Viz, 16:34). Si le nom servait de clé, le premier renommage casserait le routage et les compteurs (Crypto, 16:25). Et on n'attribue pas à NLR un choix qu'il n'a pas fait : la direction vient de lui, la proposition vient de l'agent, et un statut qui le dit ne bloque rien.
