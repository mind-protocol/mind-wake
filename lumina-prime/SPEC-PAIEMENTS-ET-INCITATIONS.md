# ◈ MIND — paiements par agent, registre couvert et primes d’adoption

Version de travail du 4 novembre 2026. **Spécification proposée pour revue et implémentation ; ce document n’active ni paiement, ni contrat, ni campagne.**

Le parcours visé est simple : « Envoie 10 MIND à Alice ». L’agent prépare une opération autorisée, le contrat l’exécute et l’agent donne un reçu vérifié. L’humain n’installe pas une nouvelle application wallet pour chaque usage. Un connecteur agent/MCP reste à livrer et à vérifier.

## 1. Autorité et périmètre

Les décisions explicites de NLR priment. Les instructions du dépôt `AGENTS.md` et les principes de garde, consentement, réservation et réconciliation de `TRANSACTIONS.md` s’appliquent. Le présent document propose un nouveau domaine de paiement : le schéma actuel des contrats de conseil `mind.guidance` ne doit pas lui être appliqué silencieusement.

La première livraison concerne **Solana devnet et un jeton de test identifié exactement**. Elle n’autorise aucun transfert mainnet, aucune dépense en monnaie réelle et aucune publication extérieure. Une promesse de récompense n’est pas un paiement effectué.

### 1.1 Décisions validées

| Sujet | Décision humaine |
|---|---|
| Symbole | `◈` représente MIND à l’affichage. |
| Commande | Un texte adressé à son agent, contenant montant et username, déclenche le parcours de paiement. |
| Parcours | Paiement préparé/géré par l’agent ; interface humaine sans nouvelle application dédiée. |
| Compagnon | Application compagnon utile mais non obligatoire ; parcours paiement/veille utilisable sans elle. |
| Découverte | Radar « qui est hot » avec provenance des signaux, profils, soldes, reçus et positions. |
| Partage | Préparer un post en un clic, avec texte éditable et geste d’autorisation ; un brouillon ne vaut ni publication ni paiement. |
| Soldes | Registre commun maintenu par le smart contract, lu avec la réserve en un appel. |
| Affichage | Username et solde ; pas d’adresses de wallets dans l’interface courante ou les prompts de réveil. |
| Couverture | Les soldes représentent des $MIND effectivement déposés dans le contrat. NLR et les autres détenteurs peuvent déposer, puis distribuer leurs propres fonds. |
| Adoption | Soutien public à Alice ; primes si elle rejoint, achète, ou reçoit des MIND de tiers. Règlement par périodes de 24 heures. |
| Priorité économique | **Rembourser la mise en priorité, avant les trois primes.** Ce n’est pas une prime prélevée en pourcentage de chaque achat ou don. |
| Lumina | 52 citoyens PNJPJ, Nova comprise, aucun PJ ; liberté de décision, ville IA innovante et florissante ; provider Codex. |
| Réveils | Coût de 1 MIND de test brut par réveil, idempotent ; lancement d’abord, frais explicitement en attente pendant le déblocage initial. |
| Crédit initial | Demande de 100 MIND de test par citoyen ; réception non présumée. |

### 1.2 Propositions et arbitrages bloquant l’activation économique

| Sujet | Proposition de référence de cette spec | Décision encore nécessaire |
|---|---|---|
| Capital soutenant Alice | Principal bloqué dans le contrat, non donné à Alice pendant le round, puis rendu une seule fois. | Confirmer ce modèle ou définir explicitement un modèle où une part est consommée/perdue. |
| Aucun événement qualifiant | Principal rendu ; aucune prime. | Confirmer. Aucune perte automatique n’a été autorisée. |
| « Alice achète » | Type d’achat unique choisi par campagne : acquisition de MIND, ou achat de bien/service payé en MIND. | Choisir le type ; ne pas confondre les deux. |
| Trois barèmes | Montants fixes par événement éligible, plafonnés et publiés avant les mises. | Fixer les montants, seuils, plafonds et budgets. |
| Plusieurs soutiens | Partage du pool de primes selon leurs mises éligibles. | Confirmer ou choisir une autre règle explicite. Cette proposition ne découle pas du seul choix « principal prioritaire ». |
| Oracle | Preuves onchain pour les flux ; attestation distincte pour l’activation et les faits externes. | Choisir les attestateurs, critères, contestation et révocation. |
| Identité | Username lié à un principal et à une autorité de signature vérifiée. | Choisir la méthode de preuve et de récupération. |
| Coûts différés | Régler les réveils historiques une seule fois avec les fonds disponibles ; solde jamais négatif. | Fixer la politique après l’amorçage et le traitement d’un arriéré supérieur au solde. |

**Ne pas ouvrir de round payant tant que ses arbitrages financiers ne sont pas fixés et son enveloppe financée.** Le registre de paiement peut être livré indépendamment des primes.

## 2. État réel de départ et sources

Sources consultées :

- `C:/Users/reyno/mind-wake/AGENTS.md` et `TRANSACTIONS.md` : autonomie, pouvoirs du propriétaire, garde, mandats, réservations, conservation et preuve de règlement.
- `C:/Users/reyno/mind-wake/services/advice/rail-solana-devnet/README.md` : rail de test Token-2022, frais, persistance avant envoi, ambiguïté jusqu’à expiration et exclusion du mainnet.
- `C:/Users/reyno/le-conseil2/.agents-runtime/lumina-ledger-stage/program/src/lib.rs` et `Cargo.toml` : prototype Anchor 1.2.2 avec inscription, dépôt net, transfert interne signé avec nonce et retrait.
- `C:/Users/reyno/le-conseil2/.agents-runtime/lumina-ledger-stage/client.mjs` et `client.test.mjs` : parseur `◈`, aliases, décodage du registre, vue publique sans adresses et lecture registre/réserve par `getMultipleAccounts`.
- `C:/Users/reyno/le-conseil2/mondes/lumina-prime/prompts/pnj.md`, `config/` et `imports/serenissima/` : règles et configuration de la partie, wallets publics et mécanisme transitoire des coûts.

La session principale a rapporté deux tests Rust hôte et six tests JavaScript passants. Cela ne démontre ni compilation SBF, ni déploiement, ni fonctionnement du contrat sur une chaîne. La session documentaire n’a exécuté aucun contrat ni mouvement de fonds.

Le connecteur n’est pas encore un paquet publié. Le prototype est en staging dans Le Conseil. L’import des 52 dossiers dans `mind-wake/lumina-prime/` et leur branchement natif Wake ne sont pas établis par ces sources. La boucle Conseil relancée sur Codex ne constitue pas une preuve de migration vers Wake.

Au dernier contrôle rapporté, le mint de test n’était pas déployé, les wallets d’amorçage n’avaient pas de SOL devnet et le faucet RPC renvoyait HTTP 410. Le statut doit être rafraîchi avant toute initialisation ; aucune réception de 100 MIND n’en découle.

## 3. Architecture cible

```text
Message humain autorisé
    → connecteur de l’agent : interprétation et préparation
    → resolver : username/principal/autorité et version de liaison
    → broker de signature : vérification du mandat et signature
    → contrat du registre : nonce, droits, soldes, réservations
    → confirmation finalisée et réconciliation
    → reçu lisible par username
```

Le « L2 » désigne ici un **registre applicatif sur Solana**, avec réserve de tokens et transferts internes. Ce n’est pas, en l’état, un rollup ni une nouvelle chaîne. Une mise à jour interne reste une transaction Solana ; le regroupement de plusieurs instructions peut réduire le nombre de transactions, sans transformer le système en règlement hors chaîne.

La réserve est un compte de tokens sous autorité du programme. Le registre est un compte du programme contenant les membres, soldes et nonces ; son extension portera les sous-comptes bloqués et les rounds. Un `getMultipleAccounts` lit registre et réserve dans le même contexte RPC. Le client ne fabrique pas de soldes depuis les déclarations des agents.

Les adresses restent nécessaires au resolver, au signataire et à la chaîne. Les retirer du rendu et des prompts n’en fait pas des données secrètes sur une chaîne publique.

## 4. Identités et résolution

Chaque principal possède un identifiant stable et une ou plusieurs liaisons signées/versionnées. Un username canonique est unique dans le registre. Un alias tel que `@diplo` résout explicitement vers le principal canonique ; il ne dépend pas d’une ressemblance de nom affiché.

Règles proposées :

1. Username ASCII canonique de 1 à 32 caractères : lettres minuscules, chiffres, `-`, `_` ; premier caractère alphanumérique.
2. Inscription initiale par l’autorité de registre ; preuve de contrôle de l’autorité de signature. Pas de réattribution administrative silencieuse.
3. Liaison à X, Telegram ou un autre réseau prouvée séparément. `@alice` sur X n’est pas automatiquement le principal MIND `alice`.
4. Toute rotation conserve l’historique et la version. Un ordre préparé garde sa liaison de destinataire ; s’il faut la remplacer, préparer un nouvel ordre.
5. Récupération/rotation d’autorité : protocole distinct, authentification renforcée, règles de délai et révocation à fixer avant un service avec fonds réels.
6. La connaissance d’un username ou d’une adresse ne confère aucun droit de signature.

Les 52 identités Lumina importées sont sélectionnées depuis les fiches canoniques. Les homonymes restent des identités distinctes. L’inscription ne leur donne aucun office, capital ou relation non acquis.

## 5. Commande de paiement et confirmation

### 5.1 Grammaire proposée

Syntaxe canonique de transport :

```text
◈ 10 @alice
```

Alias acceptés, normalisés vers le même objet métier :

```text
$MIND 10 @alice
+10 MIND @alice
```

Le symbole `◈` reste utilisé dans le solde et le reçu. `$MIND` et `+… MIND` évitent d’obliger l’humain à trouver le caractère Unicode.

Montant : entier positif ou décimal positif à neuf décimales maximum. Virgule française acceptée en entrée, normalisée en point. Pas de notation exponentielle, signe négatif, séparateur de milliers ou arrondi silencieux. Le transport utilise des chaînes d’entiers de base : `10 MIND = "10000000000"`.

Le parseur accepte une commande entière, sans autre texte interprété comme exécutable. Une citation, une capture OCR, une notification reçue ou un message envoyé par un tiers est une **détection d’intention**, pas une autorisation financière. Une instruction en langage naturel passe par une préparation explicite donnant montant et destinataire avant signature.

### 5.2 Paiement et soutien sont des opérations différentes

**Un paiement ordinaire ne devient jamais automatiquement une mise.** Le texte `+10 MIND @alice` paie Alice par défaut. Pour ouvrir un soutien bloqué, l’interface doit produire un objet `support.open` avec campagne, round, durée et règle économique explicites.

Proposition pour un contexte public : l’agent montre « paiement immédiat » ou « soutien bloqué jusqu’à telle échéance », suivant l’instruction effective de l’utilisateur. Une syntaxe de soutien distincte peut être décidée, par exemple `support +10 MIND @alice round:<id>`. Aucun prélèvement ne repose sur une ambiguïté de typographie.

### 5.3 Enveloppe immuable d’opération

Champs minimaux proposés : version, `operation_id`, type, principal émetteur, principal bénéficiaire, version de liaison, réseau, actif exact, montant brut/atomique, politique de frais, nonce du principal, échéance, référence de mandat, digest canonique et contexte d’origine.

La signature porte sur l’opération finale. Changer montant, actif, destinataire, type ou round exige une nouvelle préparation. Le broker applique les mandats hors du modèle : périmètre, frais, budget, expiration et révocation. Une confirmation répétée n’est pas requise pour une opération déjà couverte par une délégation explicite.

## 6. Unités, réserve et invariants comptables

Toutes les opérations utilisent des entiers non signés bornés. Aucun `float` n’intervient dans une balance, un montant ou une prime. Les écritures historiques sont append-only ; corrections par contre-écritures référencées.

Pour un seul actif/réseau, définir les catégories disjointes :

| Symbole | Contenu |
|---|---|
| `C` | Soldes disponibles des membres, sponsors compris. |
| `P` | Principaux de soutien bloqués, retirés de `C`. |
| `R` | Budgets de primes bloqués, retirés du disponible des sponsors. |
| `W` | Retraits en cours, uniquement si une implémentation les sépare avant exécution atomique. |
| `V` | Tokens dépensables réellement détenus dans la réserve, hors frais retenus non dépensables. |
| `U` | Excédent non attribué, par exemple donation directe au coffre non encore créditée. |

Invariants :

```text
L = C + P + R + W
0 ≤ L ≤ V
U = V − L
```

Une somme déplacée de `C` à `P` n’est pas comptée dans les deux. Les budgets de primes sont des avoirs des sponsors immobilisés ; ils ne constituent pas un second actif ajouté à la réserve. Une donation directe non attribuée n’autorise pas un administrateur à fabriquer un solde.

Un écart inexpliqué `V < L` bloque les nouvelles sorties et déclenche la réconciliation. Il n’autorise ni une réduction arbitraire de soldes, ni une recapitalisation prélevée sur d’autres utilisateurs.

## 7. Dépôts, distribution, transferts et retraits

### 7.1 Dépôt

Le déposant choisit montant brut et actif. Le programme vérifie les comptes, autorités, mint et programme de token ; mesure la réserve avant/après CPI ; crédite seulement le net dépensable reçu :

```text
net = V_après − V_avant
solde_déposant_après = solde_déposant_avant + net
L_après = L_avant + net
```

Un dépôt ne crédite pas automatiquement tous les citoyens. Il crée d’abord un solde appartenant au déposant. Une distribution à d’autres comptes est ensuite un transfert signé ou couvert par un mandat de distribution explicite.

Pour attribuer 100 ◈ à 52 citoyens, il faut **5 200 ◈ nets disponibles**. Illustration uniquement : avec des frais de dépôt de 1 %, sans plafond contraignant et avec arrondi supérieur à l’unité brute, un dépôt brut de `5 252,525252526 MIND` permet un net de `5 200 MIND`. Le calcul réel relit la configuration du jeton et les limites de frais autorisées ; ce chiffre n’est pas un tarif permanent.

### 7.2 Transfert interne

Pour un paiement de montant `a`, le contrat vérifie signature du propriétaire, nonce attendu, destinataire inscrit et `C_source ≥ a`. Il débite et crédite atomiquement :

```text
C_source' = C_source − a
C_destinataire' = C_destinataire + a
L' = L ; V' = V
nonce_source' = nonce_source + 1
```

Le paiement interne ne déplace pas le token entre deux comptes SPL. Il ne déclenche donc pas par lui-même les retenues d’un transfert SPL ; les frais réseau Solana restent un poste distinct, avec payeur explicite. Aucune commission commerciale implicite n’est ajoutée.

### 7.3 Retrait

Le détenteur signe le retrait de son disponible. Le programme diminue sa créance du brut sorti du coffre, exécute la CPI et vérifie la couverture restante. Les éventuels frais du jeton déterminent le net reçu par le compte de destination. Le reçu distingue brut, frais, net et frais réseau ; le mode « recevoir exactement X net » exige un calcul et une autorisation de brut correspondants.

Les fonds bloqués en soutien ou en budget de primes ne sont pas retirables comme du disponible. L’administrateur du registre ne reçoit pas le pouvoir de retirer le solde d’un membre.

## 8. Réveil et migration des wallets individuels

Chaque réveil économique porte un `wake_id` stable. Le coût demandé est **1 MIND de test brut** vers le principal NLR résolu par une liaison vérifiée. L’affichage emploie le username, pas l’adresse.

Modes :

| Mode | Comportement |
|---|---|
| Règlement prêt | Débit confirmé du registre ; afficher le solde disponible finalisé et la référence. |
| Amorçage différé explicitement autorisé | Le réveil peut démarrer ; enregistrer `debit_pending`, sans retirer ni déclarer payé. |
| Lecture indisponible | Afficher « solde inconnu », avec frais éventuels en attente. |
| Transfert incertain | Conserver la même opération et sa tentative ; ne pas signer un second débit pour la même référence. |

Un arriéré non payé est un poste d’obligations de service distinct, pas un token créé dans `C`. Une fois financé, règlement des coûts reconnus avec débits uniques, sans solde négatif. La politique au-delà de l’amorçage reste à décider ; le document ne crée pas un quota arbitraire de réveils.

Migration : exporter les références des frais, reçus et paiements existants sans secrets ; rapprocher chaque `wake_id` avec les transactions déjà finalisées ; importer les soldes seulement à partir de dépôts effectifs et de leur allocation autorisée. Un `wake_id` déjà débité dans l’ancien rail ne doit pas être débité dans le nouveau. Les anciennes clés restent dans les coffres privés ; aucune copie dans les dossiers citoyens.

## 9. Soutien public : contrat économique d’un round

### 9.1 Calendrier et droits

Un round dure `86 400 secondes` mesurées par l’horloge de chaîne, avec début et fin immuables. Cela évite de confondre 24 heures avec une journée locale de durée variable. Fenêtre d’entrée, éventuel gel anticipé des mises et grâce de finalité sont des paramètres publiés avant ouverture.

Une position associe : soutien, Alice cible, round, montant de principal, heure d’entrée, version des règles et nonce. Le principal doit exister et être disponible ; il est déplacé dans le compartiment `P` de la position. Une position ne peut pas financer deux rounds à la fois.

La proposition de référence conserve le principal intact et le rend après clôture. Alice bénéficie du signal public et des paiements/dons qui lui sont destinés ; elle ne peut pas dépenser la mise bloquée. Un modèle qui lui avance le capital, fait perdre les mises ou recycle les perdants exige une décision différente et une nouvelle version du contrat économique.

### 9.2 Condition commune aux trois primes

Seuls comptent les événements : postérieurs à l’entrée effective du soutien selon la règle annoncée ; dans la fenêtre d’attribution ; finalisés ou attestés par la voie prévue ; indépendants du soutien lui-même ; non déjà consommés pour le même droit à prime.

Une activation, un achat ou un don garde un identifiant stable. Un retry, une copie sur un autre réseau social ou une autre forme du même reçu ne crée pas un événement supplémentaire.

## 10. Formules des trois primes

Les valeurs ci-dessous sont des **paramètres à choisir par le financeur**, pas des rendements promis ni des montants validés par NLR. Les primes ne sont pas un pourcentage du montant qu’Alice dépense ou reçoit.

Pour une cible `a` et un round `r`, en unités atomiques :

| Paramètre | Sens |
|---|---|
| `j` | Prime fixe pour une activation éligible. |
| `b` | Prime fixe par achat éligible. |
| `d` | Prime fixe par nouveau donateur éligible. |
| `N_B` | Nombre maximal d’achats primables dans le round. |
| `N_D` | Nombre maximal de donateurs primables dans le round. |
| `B` | Budget de primes réellement bloqué par le financeur pour ce round. |
| `s_i` | Principal éligible de la position du soutien `i`. |

### 10.1 Prime de jonction

```text
J = j × I_activation
I_activation ∈ {0,1}
```

Activation proposée : premier contrôle vérifié d’une identité MIND pour Alice, avec acceptation de participation et événement d’activation. Un compte recréé ou une reconnexion n’est pas une nouvelle activation. Le droit d’activation est consommable une seule fois sur la durée de la campagne, y compris si plusieurs rounds observent la même preuve.

La part destinée à tous les soutiens d’Alice constitue **un seul pool `J`** : dix soutiens n’émettent pas dix fois la même prime d’activation.

### 10.2 Prime d’achat

```text
n_B = nombre d’achats distincts éligibles et vérifiés
A = b × min(n_B, N_B)
```

Le type d’achat est fixé avant ouverture : acquisition de MIND via une source définie, ou achat de bien/service payé en MIND. Il faut définir le minimum économique, les contreparties éligibles, les preuves et le traitement des remboursements. Un transfert entre comptes d’Alice, un dépôt/retrait de réserve ou un simple achat déclaré par l’agent ne compte pas.

La prime fixe peut être financée par une enveloppe marketing engagée ou par des frais déjà acquis et affectés explicitement au budget. Le contrat ne prélève pas cette prime dans le prix ou le compte du vendeur sans règle acceptée.

### 10.3 Prime de dons reçus de tiers

```text
n_D = nombre de nouveaux donateurs distincts éligibles ayant un don finalisé
D = d × min(n_D, N_D)
```

Les dons restent crédités à Alice. `D` vient du budget de primes séparé. Le soutien, Alice, leurs comptes reliés, les mouvements circulaires, les remboursements, les bounties de la plateforme et les règlements de primes ne créent pas de nouveaux donateurs primables. Le minimum de don, la nouveauté du donateur et les règles de liaison des identités sont des paramètres publiés. L’unicité d’une adresse ne prouve pas l’unicité d’une personne.

## 11. Rembourser la mise en priorité, puis attribuer les primes

### 11.1 Cascade de paiement

Pour le round : `S = Σ s_i` est le principal bloqué ; `B` est le budget de primes bloqué. Ces compartiments doivent être financés avant de devenir dépensables pour le règlement.

```text
1. Retour de principal : R_i = s_i
2. Principal restant : s_i_restant = 0 ; position marquée principal_returned
3. Prime nominale totale : Q = J + A + D
4. Prime réellement distribuable : G = min(B, Q)
5. Reliquat du budget : B − G, rendu au financeur après finalité de clôture
```

**Aucune prime n’est payée avant restitution de tout le principal du round concerné.** Les trois primes ont le même rang après le principal : aucune préférence entre elles n’a été demandée.

Si une réserve attendue manque, le système ne traite pas le déficit comme une perte implicitement acceptée par les soutiens. Il gèle la sortie, conserve les droits et demande une réconciliation. Un mécanisme de haircut ou de mise perdue n’est pas activé par cette spec.

Le remboursement se produit **une fois par position**. Un nouveau règlement le lendemain ne renvoie pas une seconde fois le même principal. Pour rester engagé, il faut ouvrir une nouvelle position, manuellement ou par un mandat de reconduction explicite ; le versement remboursé peut être réengagé, mais jamais compté disponible et bloqué simultanément.

### 11.2 Budget insuffisant pour les primes nominales

Proposition : réduire les primes à leur enveloppe, sans créer une dette non financée. Si `Q = 0`, les trois paiements sont nuls. Sinon :

```text
J_payé = allocation_entière(G × J / Q)
A_payé = allocation_entière(G × A / Q)
D_payé = allocation_entière(G × D / Q)
J_payé + A_payé + D_payé = G
```

Utiliser les quotients entiers et distribuer les unités résiduelles selon les plus grands restes, égalités départagées par l’ordre stable `join`, `buy`, `donor`. C’est une répartition de budget, pas un taux prélevé sur les transactions d’Alice.

Si le produit promet les primes nominales dès que les critères sont remplis, il doit au contraire réserver leur maximum avant ouverture : `B ≥ j + b×N_B + d×N_D`. Le mode « primes nominales garanties par critères » et le mode « enveloppe partagée » sont distincts ; le choix doit être présenté avant la mise.

### 11.3 Plusieurs soutiens

Proposition à confirmer : partager chaque pool payé entre les positions éligibles, pondéré par leurs mises :

```text
w_i = s_i / Σ s_éligibles
g_i,join = allocation_entière(J_payé × w_i)
g_i,buy = allocation_entière(A_payé × w_i)
g_i,donor = allocation_entière(D_payé × w_i)
versement_i = s_i + g_i,join + g_i,buy + g_i,donor
```

Même traitement déterministe des restes. Le choix humain « mise remboursée en priorité » n’approuve pas à lui seul ces poids. Un partage égal ou tenant compte de l’antériorité est une alternative à décider, avec ses effets sur le fractionnement de comptes et l’arrivée tardive.

Si les soutiens arrivent à des moments différents, un événement ne rémunère que les positions entrées avant sa fenêtre d’attribution. Le calcul se fait donc par événement ou par lot d’éligibilité, puis s’additionne ; ne pas appliquer rétroactivement un poids de fin de round à des soutiens absents au moment du fait.

### 11.4 Exemples illustratifs, sans engagement de rendement

**Un soutien.** Mise 10 ◈ ; paramètres `j=3`, `b=2`, `N_B=3`, `d=1`, `N_D=4`. Alice rejoint, fait trois achats qualifiants et reçoit des dons de quatre nouveaux tiers éligibles. `J=3`, `A=6`, `D=4`, donc `Q=13`. Si le budget préfinancé est 13, le règlement rend d’abord 10 de principal puis verse 13 de primes : total 23. Ces 13 proviennent du financeur ; aucun token n’a été créé.

**Deux soutiens de même éligibilité temporelle.** Mises 10 et 30 ; pool de primes 13. Les remboursements sont 10 et 30, puis les primes proposées 3,25 et 9,75. Total versé 53 = 40 de mises + 13 de budget engagé.

**Budget plafonné à 9.** Même activité nominale `3+6+4=13`. Après remboursement intégral du principal, les pools payés sont `2,076923077`, `4,153846154` et `2,769230769` MIND ; somme exacte 9. Les 4 MIND nominaux non couverts ne deviennent pas automatiquement une créance.

**Aucune activité qualifiante.** Selon la proposition de référence, le principal est rendu et les primes sont nulles. La phrase « bon cheval » ne doit pas être utilisée pour cacher une règle de perte non spécifiée.

## 12. Budget, anti-boucles et preuve d’activité

Chaque campagne enregistre financeur, source des fonds, montant affecté, versions des règles, plafond d’engagement, dates et politique de retrait du reliquat. Les soldes ordinaires d’autres déposants ne financent jamais les primes. Une recette de frais ne devient budget qu’une fois effectivement acquise, finalisée et affectée par son propriétaire.

Le système distingue revenu économique, circulation et prime. Payer 1 MIND à un compte contrôlé puis récupérer 2 MIND de prime ne crée pas une activité indépendante. Les règles minimales incluent :

- exclusion du soutien et de la cible comme contreparties primables de leur propre round ;
- non-récompense des transferts de réserve, remboursements, distributions initiales et primes de primes ;
- déduplication des événements et groupes de donateurs selon une règle versionnée ;
- délai et procédure pour détecter achats remboursés ou flux retournés ;
- montant d’engagement et budget global bornés par les fonds réservés ;
- analyse de scénarios de coût d’attaque avant choix de `j`, `b`, `d`, minimums et plafonds ;
- publication de la méthode d’attestation et possibilité de contester une mauvaise attribution.

Ces mesures ne constituent pas une preuve magique d’identité humaine ou d’indépendance de deux wallets. Toute confiance résiduelle dans l’attestateur doit apparaître dans le produit et les modèles de menace.

## 13. Oracle, clôture et contestation

Le contrat vérifie les signatures, montants, droits, nonces, enveloppes et consommation des preuves. Pour un fait extérieur à la chaîne — rejoindre un service, réaliser une vente, avoir une contrepartie indépendante — un oracle ou un protocole de preuve spécifique est nécessaire. Le smart contract ne constate pas ce fait en lisant seul un message.

Une attestation contient : version, domaine de campagne, événement unique, cible, type, temps/slot observé, preuve/source, montant net si utile, liaison des identités, émetteur autorisé et expiration. Elle est signée, liée au réseau/actif et au round, et consommable selon la règle anti-rejeu.

Clôture proposée : fin des mises → observation jusqu’au cutoff → grâce de finalité → publication du relevé et du digest → fenêtre de contestation bornée → règlement. La durée de grâce et la fenêtre de contestation ne sont pas fixées ici ; elles modifient la promesse « toutes les 24 h » et doivent être publiées. Si aucune fenêtre n’est voulue, définir explicitement le risque d’attestation et son mécanisme de correction avant lancement.

Un événement observé avant cutoff mais finalisé pendant la grâce peut être retenu selon la règle annoncée. Un événement tardif est affecté au round suivant s’il y est éligible. Les critères et prix ne changent jamais après l’entrée des mises d’un round.

Dans la proposition où le principal reste intact, l’indisponibilité de l’oracle ne doit pas permettre de le bloquer indéfiniment. Fixer à l’ouverture une date maximale de libération du principal et une voie de restitution déterministe au détenteur d’origine, appelable sans pouvoir de redirection. Les primes contestées peuvent rester immobilisées séparément. Les délais et la politique de liquidation des primes non résolues exigent une décision préalable.

## 14. Machines à états

### 14.1 Paiement, dépôt ou retrait

```text
draft → prepared → authorized → signed_persisted → submitted
submitted → finalized_success → reconciled
submitted → finalized_failure
submitted → outcome_unknown → mêmes octets/réconciliation
draft/prepared → cancelled ou expired
```

Un timeout ne signifie ni échec ni réussite. Le signataire persiste la transaction signée avant diffusion. Tant qu’une tentative peut aboutir, il renvoie les mêmes octets ou interroge son statut ; il ne signe pas une opération équivalente avec un nonce nouveau. Une tentative expirée exige réconciliation et vérification du nonce avant toute reconstruction.

### 14.2 Campagne et round

```text
draft → rules_frozen → prefunded → open → closed
closed → evidence_pending → evidence_final → settling → settled
evidence_pending/evidence_final → disputed → evidence_final ou cancelled_by_rule
```

`cancelled_by_rule` ne permet que les restitutions prévues et financées. Le financeur ne récupère pas une enveloppe déjà engagée contre les positions actives. Le round ne devient `settled` qu’après toutes les écritures et réconciliations nécessaires.

### 14.3 Position et coût de réveil

Position : `prepared → locked → principal_returned → bonus_settled → closed`. Un champ de principal remboursé et un identifiant de claim empêchent une seconde restitution.

Réveil : `requested → cost_reserved` ou `cost_pending` → `wake_started` → `wake_finished`; le règlement du coût possède son propre cycle `pending → submitted → finalized`. Un même `wake_id` ne donne qu’un coût, même si le runtime reprend après interruption.

## 15. Données onchain et hors chaîne

| Domaine | Autorité de vérité |
|---|---|
| Réserve, soldes disponibles/bloqués, nonces, budgets réservés | Contrat et comptes Token-2022 finalisés. |
| Mandats financiers et preuves de consentement | Broker/registre de policies, avec références vérifiables et contrôles du contrat lorsque possibles. |
| Alias et preuves de liaison de canaux | Resolver versionné ; les opérations figent la liaison utilisée. |
| Paramètres financiers d’un round, engagements et consommation des claims | Contrat ou données engagées par digest avec vérification complète avant règlement. |
| Source d’un événement externe | Attestation et preuve référencée ; contrat vérifie son autorité, pas une vérité sociale universelle. |
| Transcriptions, créations et scènes des citoyens | Dossiers du citoyen et état canonique du monde ; jamais une preuve automatique de paiement. |
| Transaction signée, tentatives et reçus | Journal durable du signataire, rapproché de la chaîne. |
| Clés | Coffre/broker hors prompts, dossiers de création et dépôt Git. |

Le prototype actuel a un seul `balance` par membre et aucun compartiment de soutien ou budget de campagne. Ajouter ces compartiments exige une migration/version de schéma explicite, pas une projection SQLite présentée comme contrat déjà couvert.

Un compte commun simplifie la lecture mais sérialise ses écritures sur Solana. Mesurer la contention avec les 52 citoyens ; optimiser par lot ou partition plus tard, en gardant une lecture publique cohérente. Aucun débit public n’est rendu instantané par simple choix d’interface.

## 16. API agent et affichage

Noms d’outils proposés, non encore déclarés disponibles :

| Outil | Entrée essentielle | Résultat |
|---|---|---|
| `mind.balance` | contexte du principal | Disponible, bloqué, coûts en attente, réseau, actif et slot finalisé ; sans adresse. |
| `mind.balances` | scope autorisé | Soldes publics des usernames et réserve via une lecture cohérente. |
| `mind.payment.prepare` | texte, émetteur authentifié, référence | Opération canonique, destinataire, montant, frais et autorité de signature attendue. |
| `mind.payment.submit` | opération préparée, mandat/acceptation | Reçu finalisé ou état d’incertitude ; jamais « payé » sur un simple dépôt en file. |
| `mind.deposit.prepare/submit` | montant, compte source autorisé | Brut autorisé, net reçu, crédit correspondant. |
| `mind.withdraw.prepare/submit` | montant/mode, destination vérifiée | Brut débité, frais, net reçu, référence. |
| `mind.support.prepare/open` | cible, campagne, round, mise | Conditions financières explicites et principal bloqué. |
| `mind.support.status` | position/round | Principal restant, critères et primes observées, statut de règlement. |
| `mind.round.settle` | round et preuves finales | Cascade principal puis primes, accessible au rôle autorisé. |

Le connecteur emploie le runtime natif et ses outils existants ; il ne recrée pas une boucle Wake. Installer/livrer depuis les sources Git compatibles avec MIND Wake, conformément aux instructions du dépôt. Le « seul connecteur » décrit la simplicité cible côté humain, pas un paquet fictivement disponible.

Exemple de prompt de réveil :

```text
Ton solde : ◈ 97 disponibles, ◈ 10 en soutien bloqué.
Coût de ce réveil : ◈ 1, confirmé ; référence opaque …
Round Alice : principal encore bloqué ; clôture prévue …
Cherche à gagner des MIND par des créations et contributions utiles.
```

Si lecture impossible : « solde inconnu ; dernier état vérifié daté … » ou seulement « solde inconnu ». Ne pas afficher 100 en guise de défaut, ni masquer le statut différé des frais. L’interface permet de voir le reçu et les règles ; elle n’a pas besoin d’exposer les adresses.

## 17. Agent mobile/OCR et canaux publics

Extension envisagée : reconnaître une commande dans une autre application ou une capture, puis proposer une opération. L’OCR n’identifie pas de manière fiable le propriétaire d’une somme et ne signe rien. Les messages entrants, citations, images modifiées, pages web et notifications restent des données non fiables.

Pour exécuter : origine financière authentifiée ou délégation explicite couvrant ce contexte, aperçu montant/destinataire/type et signature par le bon principal. Pour un soutien, montrer le blocage et les règles du round. Un reçu éventuel peut être partagé dans un canal seulement si sa publication y est autorisée ; un paiement ne vaut pas une permission de publier automatiquement sur X.

### 17.1 Variante proposée : veille serveur sans application mobile

Piste demandée pendant la rédaction, à valider avant activation : un service serveur observe les commandes publiques des comptes participants via les API officielles du réseau. X documente un flux public filtré selon des règles et des endpoints de timeline pour les posts d’un utilisateur, ses mentions et son fil d’accueil. Ce sont des moyens de lecture, pas une autorisation financière. Sources consultées le 4 novembre 2026 : [Filtered Stream](https://docs.x.com/x-api/posts/filtered-stream/introduction) et [Timelines](https://docs.x.com/x-api/posts/timelines/introduction).

Parcours proposé :

```text
Compte X lié et mandat explicite
    → post original de ce compte observé par API officielle
    → commande canonique, destinataire résolu, déduplication
    → contrôles du mandat et signature autorisée
    → contrat et confirmation
    → reçu dans le canal autorisé
```

La liaison conserve l’identifiant X stable obtenu par l’API, pas seulement le handle modifiable. Elle exige une preuve de contrôle du canal et de l’identité financière. Un simple follow, une mention du bot ou l’apparition d’un username dans un texte ne donne aucun droit de dépenser. Le mandat précise les formes de posts admises, montants, budgets, actif/réseau, expiration et révocation ; il peut autoriser l’exécution des commandes couvertes sans demande de confirmation répétée. Sans mandat correspondant, le service prépare seulement l’opération.

Le service garde le post ID et un curseur durable. Déconnexion, pagination, doublon du flux et reprise ne réexécutent pas la commande. Les versions éditées sont rattachées à un même objet d’origine et ne deviennent pas chacune un nouveau droit de paiement ; une modification financière impose une règle explicite de nouvelle autorisation. Un post supprimé n’annule pas un paiement déjà finalisé. Les citations, reposts et textes OCR non authentifiés ne déclenchent aucun débit.

Le mandat et le statut de la liaison sont revérifiés au moment de signer, y compris après un retard du flux. Une panne d’API ne prouve pas l’absence de commandes ; les rattrapages utilisent les références et limites de rétention effectivement disponibles. L’accès API, les droits du compte développeur, les limites et les coûts doivent être obtenus/vérifiés avant promesse de service. Il n’existe ici aucune garantie de surveillance universelle, gratuite ou sans interruption, ni de couverture automatique d’autres réseaux.

Cette variante réutilise la distinction de la section 5.2 : une commande de paiement ne peut devenir une mise de soutien du seul fait d’avoir été publiée sur X.

### 17.2 Compagnon facultatif et boucle de découverte

Décisions produit ajoutées le 4 novembre 2026 : une application compagnon est utile mais **non obligatoire**. Elle propose un radar « qui est hot », des profils, les soldes, reçus et positions, et une préparation de posts en un clic. Le radar conserve la provenance, l’âge et la nature de chaque signal ; un classement ou une projection n’est pas un résultat de round ni une prime acquise.

Boucle d’usage : **découvrir → soutenir → partager → suivre le résultat à 24 h**. Le soutien expose les conditions de blocage et les règles du round. Le post préparé reste éditable ; le geste d’autorisation doit porter sur ce qui sera réellement publié et, séparément ou par un aperçu explicite commun, sur l’opération financière. Ni texte prérempli ni clic de prévisualisation ne permettent d’annoncer une publication ou un paiement effectué.

Pour les applications sans API, OCR et partage explicite d’un contenu peuvent être ajoutés ensuite ; ils suivent les exigences d’autorisation de la présente section. Aucun droit de capturer ou de surveiller toutes les applications n’est déduit du seul souhait de détection.

Le développement mobile a été confié à une session distincte. Dossier cible : `C:/Users/reyno/mind-wake/lumina-prime/app/`. Le présent document ne modifie pas cette application et ne constitue pas une preuve de son état d’exécution. Les formules et paramètres économiques non validés restent des propositions, indépendamment de la disponibilité des écrans.

## 18. Garde et limites d’administration

Le prototype valide la signature d’un membre et sa nonce. Cela ne prouve pas un cloisonnement des clés entre des modèles exécutés sous le même compte Windows. DPAPI protège le stockage local ; les droits du compte hôte et la politique réelle du broker restent déterminants.

Avant argent réel, documenter qui peut : signer, faire évoluer le programme, changer le resolver ou l’oracle, geler, récupérer, déployer une nouvelle version, déplacer un budget sponsor et exporter une clé. Le propriétaire du programme ou une clé d’upgrade peut avoir un pouvoir matériel sur la garde ; ne pas qualifier le parcours de « non custodial » sans démonstration de ses propriétés.

L’administrateur ne doit pas disposer d’un appel métier qui augmente librement les soldes. Un upgrade, une rotation ou une intervention d’urgence est versionné et audité ; il ne réécrit pas des paiements historiques. La présentation sans wallets ne constitue pas une garantie d’anonymat.

## 19. Primes de projets déjà annoncées

Ces annonces sont distinctes des pools d’adoption et des soldes. Elles ne sont pas encore des versements :

| Prime | Objet |
|---|---|
| 10 MIND | Trouver comment obtenir/déposer 10 MIND sur devnet, avec preuve. |
| 10 MIND | Mettre un site de la ville en ligne, avec URL accessible. |
| 50 MIND | Mettre en place un système qui fait réellement circuler les MIND. |
| 50 MIND | Proposer un système de financement et d’alignement des incitations ; mise en œuvre non exigée pour cette prime de proposition. |
| 20 MIND | Système de paiement simple par texte ou équivalent avec règlement par smart contract. |

Total facial des annonces : 140 MIND, **pas une enveloppe déjà financée**. Identité du financeur, sélection des bénéficiaires, validation, cumuls possibles et autorisation de règlement doivent être enregistrés. Une annonce adressée aux citoyens ne démontre ni sa lecture par tous, ni leur acceptation, ni l’attribution d’une prime.

## 20. Intégration Lumina et Wake

Un dossier par citoyen, avec identité, mémoire, intentions, créations, inbox et contexte de reprise. Réutiliser la boucle native Wake et Codex, en préservant les identités ; ne pas substituer 52 nouveaux moteurs ad hoc au scheduler existant. Distinguer identité logique, session de runtime, capacité de calcul disponible et autorité financière.

Le cycle narratif reste : intentions stratégiques du citoyen → réalisation réelle dans ses moyens → preuves remises au MJ → conséquences arbitrées et scènes. Chaque PNJPJ garde son MJ ; les incohérences se règlent entre MJ avec un responsable unique par effet. Une création racontée, une intention de transfert ou une prime annoncée ne devient pas un fichier produit ou un paiement confirmé.

Les prompts stables contiennent identité, ambition de la ville, liberté et principes de coût/revenu. Les messages de réveil portent seulement nouveautés et contexte financier actualisé ; les mises à jour d’annonce gardent leurs IDs pour éviter de les multiplier à chaque reprise. Les modèles ne reçoivent aucune clé, aucun token de bot ni credential de signataire.

## 21. Tests d’acceptation

| Domaine | Preuve nécessaire |
|---|---|
| Parseur | Trois syntaxes normalisent le même ordre ; refus de nombres négatifs, exponentiels, >9 décimales, dépassement et commandes multiples. |
| Résolution | Alias lié au bon principal ; collision, rotation ou destinataire absent bloque la préparation correcte. |
| Autorisation | Message reçu/OCR ne peut signer ; autre membre/admin ne peut dépenser la balance du titulaire. |
| Dépôt | Retenue simulée/réelle de token : le registre ne crédite que le net reçu. |
| Couverture | Aucune séquence de dépôt, transfert, blocage, prime et retrait ne viole `L ≤ V`. Tests génératifs sur séquences. |
| Nonce | Double envoi, concurrence, reprise et tentative expirée ne produisent qu’un seul effet. |
| Lecture | Un appel registre/réserve, contrôle des owners/mint/autorités ; rendu sans adresses ; compte absent ≠ solde inventé. |
| Retrait | Destination liée, montant brut/net explicites ; échec CPI annule aussi le débit interne. |
| Rounds | Cutoffs, arrivée tardive, changement de règles, événement finalisé après cutoff et clôture rejouée. |
| Principal | Retourné avant toute prime et une seule fois ; reconduction explicitement autorisée et sans double disponibilité. |
| Primes | Formules join/buy/donors, plafonds et restes entiers ; sommes payées égales aux budgets consommés. |
| Anti-boucles | Pas de seconde prime pour activation rejouée, auto-transfert, achat remboursé, don retourné ou prime de prime. |
| Oracle | Mauvais signataire, mauvais réseau/round, preuve expirée ou déjà consommée refusés. |
| Coûts Wake | Même `wake_id` ne débite qu’une fois, y compris lors de migration ; frais en attente visibles et non négatifs. |
| Arrêt/reprise | Pause et Force-off de Wake respectés ; opération incertaine conservée, pas rejouée avec une nouvelle identité. |
| Parcours réel | Source installée → outils connectés → solde lu → paiement signé → reçu finalisé → reprise depuis la mémoire. |

Tests hôte, fixtures et modèles mathématiques doivent être identifiés comme tels. Le contrat exige une compilation SBF et des tests d’intégration sur un validateur, puis un parcours devnet réel à fonds de test. Aucun test n’autorise un passage mainnet.

## 22. Plan de livraison

1. **Figer la décision minimale** : type de « buy », source et mode des budgets, principal sans activité, partage entre soutiens et autorité d’attestation. Le paiement ordinaire n’attend pas la résolution de toute l’incitation.
2. **Livrer le registre devnet** : consolider le prototype, revue des comptes/autorités et erreurs, tests de CPI/retours atomiques, compilation SBF, déploiement et ID vérifiés.
3. **Livrer dépôt/paiement/retrait par agent** : resolver, broker, mandats, trois syntaxes, tentative durable et reçu. Dépôt effectif et test signé, sans afficher de wallets.
4. **Afficher les soldes** : une lecture cohérente registre/réserve, distinction inconnu/non inscrit, intégration au prompt de réveil et vue de ville.
5. **Migrer les 52 citoyens** : dossiers et identités, provider Codex, frais historiques rapprochés, financement net et distribution initiale autorisée ; validation d’une vraie reprise native Wake.
6. **Ajouter les rounds** : sous-comptes bloqués, budget sponsor, critères/attestations versionnés, remboursement prioritaire, calcul et tests des trois primes.
7. **Tester l’économie en devnet** : scénarios d’usage et attaques de boucle ; mesurer coût d’acquisition réel contre primes versées et fonds disponibles. Ajuster seulement les futurs rounds.
8. **Étendre aux canaux/OCR** : détection d’intention, autorisation, liaison des usernames externes et partage explicite des reçus.

## 23. Conditions de sortie de cette spécification

La spec est implémentable par blocs, mais l’économie des rounds n’est pas activable avant résolution des arbitrages listés en 1.2. La validation attendue porte sur les règles et paramètres précis, non sur une promesse générale de « rendement en 24 h ».

Une livraison ne pourra être dite opérationnelle que si elle présente les preuves réelles : ID/version du programme déployé, réserve et mint vérifiés, un dépôt net, une inscription, un paiement texte entre deux identités, un retrait, une reprise idempotente et un règlement de round avec principal puis primes conservant les fonds. Tant que ces preuves manquent, les états restent « prototype », « préparé », « non initialisé » ou « en attente ».
