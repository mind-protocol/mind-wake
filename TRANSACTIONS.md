# MIND — transactions, settlement, automatisations et sécurité

Version de conception : 0.1 — 29 octobre 2026. Statut : à implémenter. Aucun wallet réel, contrat blockchain, service financier ou paiement réel n'existe dans ce dépôt. Seule une intégration de test sur Solana devnet, avec jetons sans valeur, existe (`services/advice/rail-solana-devnet/`, voir §19.1).

[AGENTS.md](./AGENTS.md) fixe la direction et les invariants. [SPEC.md](./SPEC.md), sections 14 à 18, décrit le produit et ses interfaces. Le présent document est la référence détaillée du sous-système transactionnel, subordonnée à ces invariants. Toute évolution de prix, de garde ou de permissions doit être explicite et cohérente entre ces documents.

## 1. Transaction de référence et périmètre

Le protocole initial couvre `human_guidance` : agent payeur, guide humain bénéficiaire. La section 22 étend ce modèle à `agent_guidance` et `agent_task`. Les exigences d'apport humain des sections précédentes ne s'appliquent pas comme telles à ces nouveaux services ; elles restent obligatoires pour toute prestation vendue comme conseil humain. Le type de service est explicite, immuable et autorisé au contrat.

Valeur recherchée : le guide sait ce que sa contribution doit lui rapporter et reçoit le règlement convenu sans copier d'adresse ou relancer chaque paiement ; le propriétaire sait ce qui peut être engagé et conserve ses plafonds ; l'agent obtient un avis utile et en garde les apprentissages. Réservations, résolution de wallet, automatisations et sécurité servent ces bénéfices. Les reçus distinguent dû, en cours et payé, et ne présentent jamais une promesse comme des fonds reçus. Le parcours initial et les bénéfices publics restent décrits au conditionnel tant que le service n'est pas livré.

Un agent exécuté dans son environnement d'origine achète du conseil humain. Le guide démarre depuis le site, Telegram, WhatsApp si éligible, ou sa session via MCP. Matching, réservation, réveil distant, conversation et règlement sont automatisés dans des mandats préalablement accordés.

La prestation est comptée en échanges, sans rémunération à la minute. Un échange correspond à un point soumis par l'agent, une contribution humaine explicitement envoyée, puis une réponse de l'agent. Proposition de départ : au maximum cinq échanges, paramètre à valider. Le prix réel reste à décider. L'ouverture, les outils, notifications et synthèse finale seule ne créent pas d'unité payable.

Au bootstrap, les agents dépensent une enveloppe initiale financée ; les humains reçoivent des $MIND. Les revenus propres des agents viennent ultérieurement. L'origine de cette enveloppe ne se déduit pas du protocole : financeur, attribution et limites doivent être décidés avant ouverture payante.

L'admission et l'accès à cette enveloppe suivent la section 21 : compte propriétaire authentifié, clé dédiée de l'agent, entretien de vérification et allocation plafonnée. Cette procédure ne doit pas être présentée comme un KYC civil ou une preuve parfaite d'unicité.

Ce document spécifie les opérations internes et leurs garanties attendues. Le réseau et le token sont consignés en section 19.1 ; il ne choisit ni fournisseur de wallet, ni statut de garde. Pas de swap, prêt, rendement, bridge, approbation de contrat arbitraire ou vente de compute dans le parcours initial.

## 2. Invariants vérifiables

1. Aucun paiement sans fonds effectivement disponibles, contrat accepté et autorisation applicable. Un simple solde affiché ou une intention de sponsor ne finance pas une séance.
2. Chaque contrat fixe agent payeur, guide bénéficiaire, actif exact, réseau, prix unitaire, nombre maximal d'échanges, frais maximaux et règles d'interruption. Un texte de conversation ne peut modifier ces champs.
3. Une réservation est atomique avec le contrôle de disponibilité et des plafonds. Elle ne peut être dépensée par une autre séance.
4. Une seule reconnaissance comptable par échange et un seul règlement économique par contrat. Les transports peuvent livrer plusieurs fois les mêmes événements.
5. Une coupure, expiration ou révocation ne supprime pas les échanges déjà dus. Elle peut empêcher de nouvelles dépenses ; elle n'annule pas un transfert finalisé.
6. Le modèle ne détient ni seed, ni clé privée, ni credential d'administration du wallet. Il ne dispose pas d'une primitive générale de signature ou de transfert.
7. Le bénéficiaire est résolu par identité authentifiée et figé au contrat. Aucune adresse fournie dans le chat n'est une instruction de paiement.
8. Les opérations incertaines immobilisent leur montant jusqu'au rapprochement. Une expiration de retry ne prouve pas l'absence d'un transfert.
9. Les chiffres sont des entiers en unités minimales de l'actif, avec contrôles d'overflow et de bornes. Aucun calcul financier en flottants JavaScript.
10. Un état technique ne prouve pas la qualité du conseil, l'attention humaine ou l'absence de collusion. Ces limites doivent rester visibles.

## 3. Acteurs, services et frontières de confiance

| Élément                        | Responsabilité                                                     | Pouvoir explicitement exclu                                           |
| ------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Propriétaire payeur            | Autorise budget et délégation de l'agent.                          | Ne peut réécrire rétroactivement une prestation acquise.              |
| Agent / modèle                 | Prépare un besoin, dialogue, produit un checkpoint candidat.       | Pas de création de fonds, modification de mandat ou signature libre.  |
| Guide humain                   | Accepte les conditions de participation, envoie ses contributions. | Ne peut attester seul le montant qui lui est dû.                      |
| Adapter de canal               | Authentifie la source et transporte les messages.                  | Pas de comptage financier ou de résolution libre de bénéficiaire.     |
| Identité / resolver            | Lie les comptes vérifiés à un wallet versionné.                    | Pas de paiement ou de changement d'identité sur simple déclaration.   |
| Service de séances             | Matche et applique les contrats.                                   | Ne reçoit pas de clés du wallet.                                      |
| Registre d'échanges            | Valide les transitions et les attestations.                        | Ne confond pas texte du modèle et événement authentifié.              |
| Ledger / réservations          | Comptabilité et contrôle concurrent des enveloppes.                | Un solde interne n'est pas une preuve de fonds externes verrouillés.  |
| Orchestrateur de règlement     | Calcule et prépare une intention immuable, suit son résultat.      | Pas de nouvel ordre arbitraire lors d'un retry.                       |
| Signataire / adapter financier | Vérifie son autorisation et signe/transmet l'opération permise.    | Pas de confiance aveugle dans les paramètres d'un LLM ou bot.         |
| Réconciliation / résolution    | Rapproche preuves, fonds et états ; traite les exceptions.         | Pas de correction financière silencieuse ou suppression d'historique. |

Ces frontières peuvent être des modules d'un même backend au départ. Isoler au minimum le signataire, ses credentials et son contrôle de permissions. Documenter ce qu'une compromission du backend permet encore : séparer les composants ne crée pas à elle seule une sécurité cryptographique.

## 4. Wallets agent-native et résolution automatique

### 4.1 Création et rattachement

Chaque sujet économique possède un `principal_id` interne non public. Son accès web, compte Telegram, compte WhatsApp et relation MCP sont des méthodes d'accès liées, pas des wallets créés indépendamment.

La première connexion authentifiée permet de créer ou connecter un wallet. L'installation guidée peut préparer ce choix ; les étapes de consentement passent par une surface de confiance. Une clé d'opération persistée et une contrainte d'unicité évitent de créer plusieurs wallets après coupure. Si le fournisseur a pu créer le wallet sans répondre, rapprocher son état avant nouvelle création.

Pour un wallet existant, vérifier le contrôle via le mécanisme officiel adapté au type de compte et au réseau ; une adresse copiée ne suffit pas. Le propriétaire autorise séparément l'usage agent. Création, réception, dépense, récupération et export sont des permissions distinctes.

Lier un nouveau canal exige la preuve de contrôle de ce canal et du compte MIND existant. Les défis sont opaques, expirants, à usage unique et liés à la bonne opération. Un lien de démarrage de bot transféré ne vaut pas preuve suffisante de possession du compte cible. Aucun rapprochement automatique par nom affiché ou numéro ressemblant.

### 4.2 Resolver privé

Le service `resolve_recipient` reçoit un guide authentifié et un contexte d'usage, pas une adresse à suivre. Il retourne une référence de bénéficiaire et une liaison versionnée : principal, wallet vérifié, réseau, actif accepté, date d'effet et statut. Seul le service de règlement obtient les détails financiers nécessaires ; les modèles voient un pseudonyme et un reçu opaque.

Le snapshot de cette liaison est figé au contrat. Une rotation ultérieure s'applique aux nouvelles séances. Pour un contrat ouvert dont la destination devient inutilisable ou compromise, bloquer le règlement et résoudre avec contrôle renforcé ; ne pas remplacer silencieusement son adresse. Le retrait d'un canal de messagerie ne supprime pas une créance.

Une modification de bénéficiaire, récupération, export de clés ou retrait de fonds nécessite une authentification renforcée indépendante d'un simple message bot. Prévoir notifications de changement, révocation des sessions compromises et délai de sécurité configurable. Toute intervention administrative sur une destination est auditée et soumise à double contrôle avant argent réel.

### 4.3 Garde et clés

Cible de contrôle : propriétaire humain ou organisation avec capacité de récupération, agent avec délégation étroite. Le choix technique doit déclarer précisément qui peut signer, exporter, récupérer, suspendre, modifier les policies et accéder aux fonds. Ne pas qualifier un wallet de non custodial sans démontrer ces propriétés.

Employer un service de signature éprouvé avec politiques applicables hors modèle ; aucun fichier de clé dans la sandbox. Les credentials délégués restent dans le broker sécurisé et sont temporaires, révocables et liés à la bonne ressource. La couche conversationnelle ne reçoit pas davantage d'autorité en connaissant un identifiant de wallet.

Documenter sauvegarde, perte d'accès, compromission et sortie du fournisseur. Une désinstallation n'efface pas les moyens de récupération ni les obligations ouvertes. Ni seed ni clé ne transitent par chat, prompt, mémoire d'agent, analytics, URL ou journal.

## 5. Mandat de paiement et consentements

Un `payment_mandate` versionné est accordé par le propriétaire du budget via un canal de confiance. Il contient : payeur, agent autorisé, actif/réseau exacts, usage `mind.guidance`, règle de sélection des guides, plafond par échange et séance, plafond par période, frais maximaux, nombre maximal de réservations ouvertes, dates d'effet et expiration, règles de révocation et de règlement des montants acquis.

Le guide accepte initialement les conditions de participation et sa grille de rémunération. Une séance qui respecte ces préférences démarre sans nouvelle négociation. Un tarif ou une condition hors de ce périmètre attend l'accord ; l'assistant ne peut pas l'obtenir par auto-déclaration.

Le mandat délègue le règlement des échanges accomplis sous les contrats acceptés, sans confirmation à chaque paiement. Séparer la clôture économique d'une séance de l'expiration du credential technique : aucun nouveau travail n'est autorisé après révocation, mais les obligations acquises doivent avoir un chemin de règlement prévu. Si la signature n'est plus techniquement autorisée, conserver la dette et la réserve et demander une résolution ; ne pas simuler un droit de signature encore valide.

Une modification de plafond concerne les nouvelles autorisations et l'encours non engagé. Une baisse sous l'encours bloque les nouveaux contrats ; elle ne recrédite pas artificiellement des fonds déjà réservés. Les périodes sont persistées en UTC avec règles de calendrier explicites, et ne sont pas remises à zéro au redémarrage.

## 6. Contrat immuable de séance

Le backend produit une représentation canonique versionnée et un digest de ses seuls champs contractuels. Les acceptations sont reliées à cette version et aux mandats applicables. Changer un champ financier après réservation exige un nouveau contrat ; une prolongation est un nouveau bloc distinct.

Champs obligatoires : `contract_id`, `schema_version`, `payer_principal_id`, `agent_id`, `guide_principal_id`, `recipient_binding_version`, `asset_id`, `network_id`, `unit_price_atomic`, `max_exchanges`, `max_principal_atomic`, `max_fees`, `fee_payer`, `mandate_id/version`, versions des conditions du guide et du comptage, expiration d'inactivité, échéances de résolution, références de session et règles de clôture.

`asset_id` identifie le token exact sur le réseau choisi, pas seulement le symbole $MIND. Définir décimales, traitement des frais et sémantique de transfert avant activation. Refuser un token dont les retenues, mécanismes de rebase ou autres comportements empêchent de garantir le net promis, sauf contrat spécifique ultérieur. Le parcours initial n'accepte aucun changement automatique d'actif ou de réseau.

Les montants sont stockés en entiers et sérialisés comme chaînes décimales. Les frais réseau sont identifiés dans leur propre actif et plafonnés séparément ; on ne les additionne pas numériquement à des $MIND sans conversion explicitement définie. Au lancement initial, aucune commission plateforme implicite : une éventuelle commission future doit être visible, versionnée et incluse dans les autorisations.

## 7. Fonds disponibles et réservations effectives

### 7.1 Une réservation interne n'est pas un escrow

Une réservation SQLite empêche deux processus de notre service de promettre les mêmes fonds ; elle n'empêche pas le propriétaire ou un autre signataire de vider un wallet externe. Ne pas afficher « garanti » pour ce seul verrou.

Pour un parcours payant automatisé, exiger une enveloppe de fonctionnement préfinancée dont le mécanisme de garde ou de verrouillage interdit les autres sorties concurrentes sur l'encours réservé. Options à évaluer : sous-compte ségrégué sous contrôle de policies, fournisseur offrant une réservation effective, ou dispositif de verrouillage de fonds adapté à la chaîne. Aucun n'est présumé présent ou audité. Un simple mandat de dépense sur un wallet libre n'est pas une garantie de paiement suffisante.

Avant lancement, choisir ce mécanisme, ses administrateurs, possibilités de retrait, délais et preuves. Si les réservations ne peuvent pas être réellement couvertes, interdire la séance payante ou la proposer explicitement gratuite ; ne pas transférer silencieusement ce risque au guide. Les obligations de garde et les conditions de plateforme restent à valider pour le mécanisme retenu.

### 7.2 Calculs

Pour un actif et une enveloppe : `disponible = fonds confirmés affectés − réservations ouvertes − obligations non réglées non déjà incluses dans ces réservations − réserve de sécurité`.

Définir les catégories comme disjointes : une somme acquise restant comprise dans une réservation ne doit pas être soustraite une deuxième fois. Une entrée de fonds n'est disponible qu'après la confirmation requise par l'adapter. Un webhook d'arrivée ne suffit pas.

À l'ouverture : `principal_max = max_exchanges × unit_price_atomic`. Réserver ce principal et les enveloppes de frais dans leurs unités propres, avec consommation atomique des plafonds de mandat. Réserver contre une version de balance et un verrou transactionnel ; la disponibilité est recalculée dans la transaction d'écriture, pas depuis un cache.

À la clôture : `principal_due = earned_exchanges × unit_price_atomic`. Transférer l'excédent non dû de la réserve vers le disponible après vérification qu'aucun événement antérieur à la clôture ne peut encore créer une unité due. Conserver le principal dû et les frais nécessaires immobilisés jusqu'au résultat final. Restituer le reliquat des frais seulement après rapprochement.

### 7.3 Ledger

Utiliser un journal comptable append-only, équilibré par actif, avec écritures et contre-écritures explicites ; ne jamais modifier directement un solde historique. Sous-comptes minimaux : fonds disponibles, réservations, dette au guide, règlement en cours, montants réglés et frais. Le plan de comptes définit les signes et transitions de façon unique avant implémentation.

Les projections de solde sont reconstruisibles depuis le journal. Chaque écriture référence l'opération métier et sa clé unique. Rapprocher régulièrement les actifs effectivement contrôlés et les engagements ; aucun reçu ne doit indiquer « payé » à partir d'une simple écriture interne de dette.

## 8. Comptage des échanges et preuve limitée de prestation

Une unité porte `exchange_id`, `contract_id`, numéro de séquence, référence du point de l'agent, contribution humaine, réponse de l'agent, état de sauvegarde et références d'attestations. Chaque paire contrat/séquence est unique.

États : `opened → human_submitted → agent_replied → checkpointed → earned`. Sorties : `void` pour une unité non accomplie, `disputed` pour anomalie. Seul le registre applique les transitions ; le modèle ne peut émettre directement `earned`.

Le service de canal atteste la soumission par l'identité liée ; le service de runtime distant atteste la réponse et la sauvegarde. Ces attestations sont authentifiées et liées au contrat, au numéro d'échange et à une version. Elles attestent des événements de services, pas une vérité sur l'attention humaine ou la pertinence du contenu. Des participants collusifs peuvent encore produire des échanges fictifs ; ne pas présenter les signatures comme solution à ce problème.

Pour éviter une décision tarifaire subjective par le modèle, l'unité est créée avant l'envoi du point de l'agent. Les clarifications se rattachent au même `exchange_id`. Après sa finalisation, un nouveau point ouvre explicitement l'unité suivante ; concaténation, streaming, outil et retry ne créent pas d'unité. Refuser un dépassement du maximum même si des messages supplémentaires ont été reçus.

Exclure salutations, accusés techniques et contenu vide selon des règles structurelles versionnées ; ne pas faire d'un seuil de caractères une preuve de valeur. Les cas suspects peuvent être bloqués ou signalés par des contrôles séparés. Un jugement LLM peut aider à analyser un litige, jamais être l'unique autorité qui s'accorde un paiement.

Le checkpoint peut être incrémental : chaque échange acquiert une sauvegarde durable sans attendre la synthèse finale. Si la synthèse finale échoue, les unités déjà `earned` restent dues. Si un humain a travaillé mais que la réponse ou la sauvegarde échoue, l'unité reste en attente de résolution, sans perte silencieuse ni paiement inventé. Un éventuel dédommagement est une décision séparée, financée et tracée.

## 9. Machines à états et clôture

Séparer l'état conversationnel, le règlement et la confirmation externe. Une rencontre peut être terminée alors que son paiement reste en cours.

| Objet                  | États principaux                                                                                                                 | Règle                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Contrat                | `offered`, `accepted`, `reserved`, `active`, `submitted`, `approved`, `settlement_pending`, `settled`                            | `approved` est une validation backend sous mandat, pas un bouton obligatoire ou une approbation du modèle.                              |
| Contrat interrompu     | `cancelled`, `expired`, `disputed`                                                                                               | Une expiration avec unités dues conduit à leur règlement ; elle ne les annule pas. Conserver séparément motif de fin et état financier. |
| Réservation            | `pending`, `held`, `partially_released`, `consumed`, `released`, `uncertain`                                                     | Seul un résultat rapproché permet consommation ou libération finale.                                                                    |
| Intention de règlement | `prepared`, `authorized`, `submission_pending`, `submitted`, `confirming`, `finalized`, `failed_definitive`, `unknown`, `frozen` | Ni `submitted` ni `unknown` ne signifient payé ou annulé.                                                                               |

La clôture possède un verrou de version et un watermark d'admission : arrêter d'abord les nouvelles unités, puis rapprocher les unités déjà admises, figer le compteur et produire une seule intention agrégée. Une contribution reçue après clôture n'est pas facturée ; une réponse tardive liée à une unité déjà admise suit la règle contractuelle de grâce et de rapprochement. Horodatages clients seuls insuffisants pour arbitrer une course.

Un arrêt volontaire, une limite atteinte, une inactivité expirée ou un changement de canal peuvent demander la clôture. Aucun n'efface le compteur. Une seconde demande de clôture retourne la même opération. Une prolongation et un nouveau matching ont de nouveaux contrats et réservations ; pas de mutation du contrat fermé.

## 10. Pipeline de settlement

1. **Calculer.** Vérifier clôture, unités acquises, policy applicable et absence d'anomalie bloquante. Calculer principal, frais bornés et reliquat libérable.
2. **Préparer.** En une transaction locale, inscrire montant dû, intention immuable et événement d'outbox. Verrouiller l'unicité du règlement économique pour ce contrat. Si zéro est dû, clôturer sans transfert et libérer seulement l'encours sûr.
3. **Autoriser.** Un composant indépendant vérifie mandat, obligation contractuelle, bénéficiaire figé, actif, réseau, fonds, limites, version et expiration de l'autorisation technique. Une anomalie bloque avant signature.
4. **Signer et soumettre.** Le signataire vérifie lui-même le payload autorisé, sans accepter de calldata libre fournie par le modèle. Persister identifiant fournisseur et, si possible, transaction signée ou référence de signature sécurisée avant diffusion. L'accès au matériel signé reste restreint.
5. **Observer.** Enregistrer statut d'acceptation, échec ou incertitude. Un timeout après appel ne justifie pas un nouvel ordre avec un autre identifiant.
6. **Confirmer.** Interroger une source fiable du rail et contrôler réseau, token, destinataire, montant net et succès effectif du transfert, pas uniquement la réception d'un hash.
7. **Finaliser.** Après la finalité requise, transformer les engagements en règlement confirmé et rapprocher les frais. Produire un reçu privé et une notification dédupliquée. Une panne de notification ne remet pas en cause un paiement finalisé.

La réservation de paiement ne suppose pas une transaction on-chain par échange. Le rail initial vise un règlement agrégé par contrat. Si un fournisseur crédite d'abord un compte interne, montrer `credited` distinctement d'un transfert externe confirmé ; ne pas appeler ces états équivalents.

## 11. Idempotence, concurrence et livraison fiable

Ne pas promettre une livraison réseau « exactly once ». Viser un effet économique unique par combinaison de journal durable, contraintes d'unicité, paramètres figés et rapprochement externe.

| Opération               | Clé durable minimale                                                 |
| ----------------------- | -------------------------------------------------------------------- |
| Provision de wallet     | principal + rôle du wallet + opération de provisionnement            |
| Liaison de canal        | défi d'association à usage unique + comptes concernés                |
| Démarrage de rencontre  | identité authentifiée + client_request_id + empreinte des paramètres |
| Contribution            | contrat + canal + identifiant de message source + exchange_id        |
| Acquisition d'une unité | contrat + exchange_id + version de règle                             |
| Intention de règlement  | contract_id + type de règlement initial                              |
| Soumission financière   | settlement_id + payload immuable                                     |
| Notification            | settlement_id + statut + canal                                       |

Une clé réutilisée avec des paramètres différents retourne un conflit, jamais une opération modifiée. Dédupliquer aussi les invariants métier : un attaquant utilisant une nouvelle clé ne contourne pas l'unicité d'une unité ou le plafond de séance.

Écrire les événements sortants dans une outbox au sein de la même transaction que l'état métier. Les workers utilisent leases et fencing tokens ou mécanisme équivalent pour empêcher un worker périmé de soumettre après reprise par un autre. Une inbox déduplique les événements entrants avant leur application durable. Les acquittements de transport suivent les garanties officielles du fournisseur ; ne pas acquitter une opération perdue en mémoire.

La durée d'idempotence d'un fournisseur peut être plus courte que la vie de nos obligations. Notre registre persiste assez longtemps pour empêcher un second paiement après expiration de sa fenêtre. Sans historique externe suffisant pour résoudre un statut inconnu, geler et escalader au lieu de réémettre.

## 12. Adapter financier et finalité

Contrat conceptuel : `capabilities`, `provision_or_lookup`, `verify_binding`, `get_confirmed_funds`, `hold_or_verify_earmark`, `prepare_transfer`, `submit`, `lookup_operation`, `verify_transfer`, `get_finality`, `reconcile`, `revoke_delegation`. Certaines opérations dépendent du mécanisme retenu ; déclarer les absences au lieu de simuler leur présence.

La matrice de capacités doit démontrer : garde, restrictions réellement imposées, ségrégation des fonds, contrôle des sorties concurrentes, idempotence et durée de rétention, possibilité de rechercher une opération après timeout, rotation/récupération, calcul des frais, finalité et comportement en panne. Aucune activation réelle si une propriété nécessaire reste inconnue.

Pour une chaîne, définir nombre/propriété de confirmations, comportement aux réorganisations et traitement des transactions remplacées, abandonnées ou échouées. Une transaction dont le statut paraît ancien ou absent peut rester exécutable : ne pas libérer les fonds sans preuve suffisante. Un remplacement doit préserver l'obligation économique, prouver qu'il remplace le même transfert selon les règles du réseau et rester dans le mandat de frais ; sinon intervention.

Pour un fournisseur interne, définir les états irrévocables et les possibilités d'annulation. Le succès de l'API ne vaut pas finalité par convention. Une réorganisation détectée avant finalité ramène à `confirming` ou `unknown`. Après finalité annoncée, un incident exceptionnel produit un dossier de rapprochement, pas une correction silencieuse.

La prise en charge des frais peut être sponsorisée si le réseau et le fournisseur le permettent ; elle n'est ni gratuite ni supposée disponible. Un budget de frais épuisé suspend les nouvelles séances et garde les dettes existantes visibles. Aucun achat automatique de gas ou swap sans mandat spécifique.

## 13. Automatisations et comportement en incident

Toutes les tâches sont déterministes, bornées, reprenables et sans appels modèle pour comptabilité. Les intervalles, délais et seuils sont configurés et validés en recette ; ils ne sont pas des promesses opérationnelles déjà mesurées.

| Tâche                   | Déclencheur et action                                              | Limite / escalade                                                                                                  |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Matching / réservation  | Demande utilisateur ou offre agent déjà autorisée.                 | Une rencontre active par guide et agent ; aucun polling LLM ou débit financier sans séance.                        |
| Expiration d'invitation | Aucun démarrage avant échéance.                                    | Annuler et libérer uniquement après exclusion de toute activation concurrente.                                     |
| Reprise d'échanges      | Message ou réponse en attente.                                     | Retry avec même identifiant, backoff et échéance ; jamais création de nouvelle unité.                              |
| Clôture d'inactivité    | Aucun échange depuis le délai convenu.                             | Fermer l'admission, rapprocher les unités en cours et régler celles acquises.                                      |
| Settlement worker       | Intention en outbox.                                               | Même payload et clé ; circuit breaker sur anomalie ou statut inconnu.                                              |
| Réconciliation          | Périodique et après webhook/panne.                                 | Lire état externe, comparer au ledger ; écart inexpliqué déclenche gel ciblé et alerte.                            |
| Révocation / expiration | Mandat, accès ou canal révoqué.                                    | Stopper nouveaux engagements ; préserver l'historique et résoudre les dettes acquises.                             |
| Notification            | Changement de statut durable.                                      | Dédupliquer ; respecter consentement, canal et fenêtre de plateforme. Aucune notification ne crée d'unité payable. |
| Surveillance des fonds  | Encours élevé ou enveloppe insuffisante.                           | Suspendre les nouvelles réservations, pas de recharge ou émission automatique.                                     |
| Contrôle d'intégrité    | Écart de ledger, signature invalide, hausse anormale de paiements. | Gel ciblé puis global si nécessaire ; conserver les preuves et procédures de reprise.                              |

Les événements de canal n'ont pas de pouvoir administratif : ni callback bot, ni bouton falsifié, ni prompt reçu ne peut déclencher une signature hors du pipeline. L'arrêt d'urgence conversationnel et le gel financier sont deux contrôles distincts ; leur statut doit être lisible même si les modèles sont indisponibles.

## 14. Sécurité des API, signataires et opérations

### 14.1 Authentification et autorisation

Sur chaque opération : identité vérifiée, rôle, ressource, contrat, policy versionnée et autorisation effective. L'identifiant du payeur n'est pas choisi librement dans le body par le client. Les identifiants opaques réduisent la découverte mais ne remplacent pas ces contrôles. Un compte lié à plusieurs canaux ne reçoit pas automatiquement plus de droits financiers.

Pour MCP HTTP, appliquer les mécanismes d'autorisation officiels retenus, vérifier audience et permissions ; pas de transmission aveugle d'un token à un autre service. Credentials distincts et restreints entre gateway, orchestrateur et signataire. Pour web, gérer sessions, CSRF sur actions sensibles, origine et protection contre vol de session. Pour les bots, vérifier les mécanismes officiels de webhook et ne pas faire confiance à un simple `sender_id` posté par un tiers.

Enveloppes de service authentifiées : version, event_id, producer, audience, contract_id, exchange_id si pertinent, payload digest, heure serveur et nonce. Choisir un format cryptographique standard avec bibliothèques maintenues ; aucune cryptographie maison. Les corps de requête sont validés et bornés, les clés tournées, les événements rejoués dédupliqués durablement. Vérifier la fraîcheur selon le protocole signé applicable, sans inventer un timestamp authentifié quand le fournisseur n'en expose pas.

### 14.2 Défense financière

Le signataire accepte seulement les intentions immuables autorisées, avec actif exact, destinataire figé, montant et frais bornés. Il contrôle des limites qui ne peuvent pas être relevées par le runtime agent. Les limites par période doivent couvrir les réservations concurrentes, pas seulement les transactions déjà finalisées.

Restreindre les credentials de production par environnement, service et rôle. Séparer clés de test, signature financière, administration, chiffrement et attestations. Protéger les secrets via le mécanisme retenu, sans journalisation. Un coffre de clés ne protège pas d'un service autorisé compromis : privilégier des policies et autorisations indépendantes du seul orchestrateur.

Double contrôle pour relèvement des limites de production, changement de signataire, modification de policy racine et remédiation de destinataire. Audit des actions administratives avec identité, motif et référence de dossier. Le gel doit rester disponible même en panne du canal conversationnel. La reprise après incident est explicite, avec rapprochement avant réouverture.

### 14.3 Abus et collusion

Menaces : faux guides, comptes multiples, échanges artificiels, guide et agent sous contrôle commun, invitations massives épuisant les réservations, rejeu, substitution d'adresse, faux callbacks et accès aux conversations d'autres utilisateurs.

Contrôles initiaux : enveloppes de bootstrap plafonnées, limites par identité et groupe de comptes liés lorsque licite, une séance active par partie, quotas de réservation, rythme borné, signaux de répétition et détection des relations suspectes. Un pseudonyme ou un wallet ne prouve pas une personne unique. Ne pas promettre une protection Sybil parfaite ou collecter indistinctement des données personnelles pour la prétendre.

Les anomalies peuvent suspendre de nouvelles séances ou geler une intention avant émission selon les conditions acceptées. Prévoir revue humaine et contestation, avec délais et financeur de tout dédommagement. Après transfert irréversible, aucune promesse de récupération automatique. Les scores de réputation n'accordent pas de droit de débit supplémentaire.

## 15. Confidentialité, logs et reçus

Séparer bases logiques et permissions de l'identité privée, du routage des canaux, des conversations, du ledger et du signataire. Le paiement n'exige pas la publication du transcript. Les reçus privés indiquent contrat opaque, unités, prix, montant net, frais selon conditions et état ; la référence externe complète est accessible seulement aux ayants droit.

Ne pas placer de conversation, identité civile, identifiant Telegram, numéro WhatsApp ou digest brut de texte privé sur une chaîne publique. Un hash simple d'une courte phrase peut rester devinable. Utiliser des références aléatoires et, si des engagements de contenu sont nécessaires, une construction appropriée avec secrets/nonces et analyse de corrélation. Ce choix reste à valider, pas à inventer dans la première implémentation.

Les métadonnées de paiement et les adresses peuvent être publiques selon le réseau ; un resolver privé ne rend pas les transferts anonymes. Signaler la corrélabilité résiduelle entre séances, wallets et horaires. Un changement d'adresse n'est pas à lui seul une garantie d'anonymat.

Définir rétentions distinctes pour transcripts, preuves contractuelles, déduplication et audit financier. Une suppression de conversation ne doit pas faire perdre les preuves minimales d'une obligation ou réactiver un ancien paiement. Conserver des tombstones d'opérations et des références minimales selon la durée requise, puis appliquer une politique de purge documentée et compatible avec les obligations applicables. Ne pas prétendre supprimer les copies détenues par un tiers ou les écritures publiques.

## 16. Modèle de données et opérations de service

Entités logiques : `principals`, `channel_bindings`, `wallet_bindings`, `payment_mandates`, `guide_terms`, `funding_pools`, `contracts`, `exchanges`, `attestations`, `reservations`, `ledger_entries`, `settlement_intents`, `transfer_attempts`, `inbox_events`, `outbox_events`, `disputes`, `admin_audit`.

Chaque ligne financière porte actif, version, identifiants de causalité et dates serveur. Contraintes minimales : unicité du wallet logique par rôle, contrat actif par partie pour le premier parcours, échange par contrat/séquence, acquisition par échange, intention initiale par contrat, événement entrant par producteur/id et écriture par opération comptable. Une tentative de transfert n'est pas une nouvelle intention économique.

SQLite convient au prototype local et à un backend à écrivain unique contrôlé si les charges le permettent. Ne pas partager un fichier SQLite entre plusieurs instances distribuées pour simuler une transaction globale. Avant architecture multi-instance, choisir un stockage transactionnel adapté ; aucun déploiement de ce type n'existe encore.

Opérations publiques conceptuelles : démarrer, soumettre une contribution, lire messages/statut, clôturer, consulter reçu. Le client ne fournit pas prix final, état `earned`, destination ou payload de signature. Opérations privilégiées : provision/liaison vérifiée, création/révocation de mandat, réservation, attestation de runtime, préparation/rapprochement du règlement, résolution de litige. Les scopes et rôles interdisent à l'agent invité de les usurper.

## 17. Exemple comptable, entièrement fictif

Supposons une enveloppe disponible de 100 unités $MIND, un maximum de 5 échanges à 2 unités et des frais supportés séparément par un budget autorisé. Ces chiffres illustrent le modèle ; ils ne définissent ni prix ni rendement.

1. Ouverture : 10 unités réservées, 90 disponibles.
2. Trois échanges deviennent `earned` : 6 unités dues restent comprises dans les 10 réservées ; ne pas soustraire à nouveau ces 6 du disponible.
3. Arrêt anticipé : compteur figé à 3 ; 4 unités non dues sont libérées, 94 disponibles, 6 immobilisées pour règlement.
4. Soumission : 6 unités en cours, toujours indisponibles. Timeout réseau : conserver `unknown` et les mêmes références ; ne pas envoyer un deuxième paiement.
5. Confirmation finale : le guide reçoit 6 unités selon la sémantique du rail ; l'encours est soldé, l'enveloppe payeur conserve 94. Les frais sont rapprochés dans leur budget propre.

Une réponse à un quatrième échange reçue après la clôture suit le watermark et les règles d'admission ; elle ne peut pas augmenter un règlement déjà figé ou finalisé par simple nouveau comptage.

## 18. Recettes obligatoires avant argent réel

| ID  | Scénario                                                                      | Résultat attendu                                                                                                               |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| P01 | Création de wallet interrompue puis relancée                                  | Même wallet retrouvé ou état incertain rapproché ; aucun doublon silencieux.                                                   |
| P02 | Substitution de bénéficiaire dans le chat ou via bot compromis                | Refus ; liaison du contrat inchangée, récupération renforcée requise.                                                          |
| P03 | Réservations simultanées dépassant l'enveloppe                                | Seules celles intégralement couvertes passent ; aucun solde ou plafond négatif.                                                |
| P04 | Retrait externe concurrent                                                    | Réservation réellement protégée ou parcours payant bloqué ; aucun faux « paiement garanti ».                                   |
| P05 | Rejeu de contribution, streaming, appels d'outils, retry webhook              | Une seule acquisition par échange ; les messages techniques ne sont jamais payables.                                           |
| P06 | Réponse et clôture concurrentes                                               | Admission déterministe, compteur figé une seule fois et montant stable.                                                        |
| P07 | Arrêt à trois échanges sur cinq                                               | Seules trois unités payables, réserve restante libérée sans perte des dettes.                                                  |
| P08 | Crash avant/après écriture, outbox, signature, diffusion ou notification      | Reprise durable à chaque point, aucun ordre économique supplémentaire.                                                         |
| P09 | Timeout fournisseur et fenêtre d'idempotence expirée                          | Recherche et rapprochement ; statut inconnu gelé plutôt que réémission aveugle.                                                |
| P10 | Mauvais réseau, faux token homonyme, montant net différent ou frais excessifs | Opération refusée avant signature ou incident bloqué, aucun faux reçu payé.                                                    |
| P11 | Révocation de mandat avec unités déjà acquises                                | Nouveaux engagements stoppés ; obligations et chemin de résolution conservés sans signature non autorisée.                     |
| P12 | Réorganisation, transaction remplacée ou événement externe hors ordre         | Finalité recalculée selon l'adapter, encours non libéré à tort, pas de double transfert.                                       |
| P13 | Deux workers et reprise d'un worker périmé                                    | Fencing/unicité empêchent soumissions concurrentes non rapprochées.                                                            |
| P14 | Ledger reconstruit après restauration                                         | Soldes et encours concordent avec les actifs externes et obligations ; aucune clé d'idempotence perdue réactivant un paiement. |
| P15 | Attestation forgée, mauvais audience, accès croisé ou payload modifié         | Rejet authentifié et tracé ; aucun effet financier.                                                                            |
| P16 | Collusion simulée et épuisement des enveloppes                                | Limites et revue fonctionnent ; aucun paiement automatique hors mandat ou promesse de détection parfaite.                      |
| P17 | Suppression du transcript et export du reçu                                   | Données privées minimisées, preuves requises et prévention des doubles paiements préservées.                                   |
| P18 | Changement web / MCP / Telegram / WhatsApp autorisé                           | Même contrat, même bénéficiaire et mêmes unités ; notification dédupliquée.                                                    |
| P19 | Prix nul, compteurs hors bornes, grands entiers et décimales incorrectes      | Montants exacts, cas gratuit explicite, paramètres invalides refusés.                                                          |
| P20 | Gel d'urgence et reprise                                                      | Pas de nouveaux engagements/soumissions interdits ; transferts déjà partis rapprochés et reprise explicitement autorisée.      |

Réaliser d'abord la recette avec adapter déterministe et fonds fictifs, puis environnement de test officiel s'il existe, enfin essai réel de très faible montant sous autorisation spécifique. Un mock ne valide ni le signataire, ni la finalité, ni la protection effective des fonds. Les tests de crash doivent couvrir chaque frontière entre état local et effet externe.

## 19. Décisions et portes de lancement

Avant argent réel, résoudre et consigner : réseau et token exacts ; propriété/garde/récupération ; fournisseur et périmètre de ses policies ; mécanisme de couverture et de réservation ; financeur et plafond bootstrap ; tarif et nombre d'échanges ; frais et acteur qui les supporte ; finalité et reorgs ; délais d'incident/résolution ; mécanismes d'attestation ; rétention ; éligibilité par canal/région et obligations du service retenu.

Les autorisations de provider IA, de messagerie et de paiement sont distinctes. Un adapter technique fonctionnel ne prouve pas l'éligibilité contractuelle du cas d'usage. En particulier, conserver les restrictions WhatsApp définies en section 18 de `SPEC.md` ; ne pas utiliser un déplacement apparent du paiement pour contourner une activité interdite sur un canal.

La porte de lancement exige P01 à P20 et I01 à I08, revue des frontières financières, démonstration de récupération, procédure de gel testée et responsable de résolution identifié. Le statut public doit distinguer prototype simulé, intégration de test et service réel. Aucun montant n'est garanti tant que le financement et les mécanismes ne le permettent pas effectivement.

### 19.1 Réseau et token retenus

Décision utilisateur du 29 octobre 2026 : $MIND est le mint `EgLGfRrjX3du7Pwbj8dzyubSk8ic1WdDfq1ysLqhBm6p` sur Solana mainnet (projet affiché : Mind Protocol). Cette décision ferme « réseau et token exacts » ; les autres décisions de cette section restent ouvertes.

Constats lus le 29 octobre 2026 par `getAccountInfo` (RPC public) et DEX Screener, à revalider avant toute implémentation :

| Propriété          | Constat                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Programme          | Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`)                                                                       |
| Décimales, supply  | 9 ; environ 999 993 unités en circulation                                                                                        |
| Autorité de mint   | **Non révoquée** : `CCsJLZR8b19iDgS9hXUYs9q2c928ihzZdfSgZLPYffWg`. L'annonce « supply fixe » n'est pas imposée on-chain.         |
| Autorité de gel    | Aucune                                                                                                                           |
| Frais de transfert | 1 % (100 points de base) ; config et retrait des frais retenus contrôlés par la même clé ; plafond `maximumFee` non contraignant |
| Transfer hook      | Aucun                                                                                                                            |
| Métadonnées        | Pointeur et mise à jour contrôlés par la même clé                                                                                |
| Liquidité observée | Paire MIND/SOL FluxBeam : environ 185 $ de liquidité, aucune transaction sur 24 h                                                |

Conséquences pour l'implémentation :

1. Montants en entiers à 9 décimales, sérialisés exactement ; transferts par les instructions Token-2022 avec frais (`transfer_checked_with_fee` ou équivalent), jamais par le programme SPL classique.
2. Les frais de transfert entrent dans la décision « frais et acteur qui les supporte » : le contrat fixe si le guide reçoit le montant net ou si l'envoi est majoré, et le reçu distingue montant envoyé, frais retenus et montant reçu. Un changement de taux par l'autorité doit être détecté avant émission et geler l'intention plutôt que régler un montant différent du contrat.
3. Le pouvoir d'émission et de modification des frais détenu par `CCsJ…` est un point de garde à déclarer : qui contrôle cette clé, sa récupération, et une éventuelle révocation de l'autorité de mint.
4. La liquidité observée ne permet pas de dériver un prix fiable en monnaie fiat ; ne pas afficher d'équivalent en dollars d'un tarif sur cette seule base.
5. L'adapter d'intégration de test `services/advice/rail-solana-devnet/` applique les points 1 et 2 sur devnet avec un mint de test au même profil ; il n'est pas câblé au service de séances.
6. Utiliser ce token comme actif ne crée aucune dépendance au code, aux services ou à l'infrastructure des anciens dépôts MIND (AGENTS.md §2).

## 20. Sources techniques à revalider

Ces sources documentent des propriétés ou risques à examiner ; elles ne constituent ni une sélection de fournisseur, ni une garantie couvrant l'architecture MIND.

- [MCP Security Best Practices](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/tutorials/security/security_best_practices.mdx) : délégation confuse, audience des tokens, SSRF et frontières de confiance.
- [OWASP Webhook Security](https://cheatsheetseries.owasp.org/cheatsheets/Webhook_Security_Cheat_Sheet.html) : authentification des callbacks, rejeu, déduplication persistante et ordre des événements.
- [Privy — Wallet policies and controls](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls) : exemple de modèles de contrôle et de policies ; vérifier où chaque limite est effectivement imposée, certaines règles n'étant pas exécutées dans la même frontière matérielle.
- [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337) : mécanismes possibles de comptes programmables et sponsoring de frais pour les réseaux compatibles ; aucune décision EVM implicite.
- [Sign in with ChatGPT — Quickstart](https://developers.openai.com/siwc/quickstart) : connexion d'identité et autorisation d'utiliser le plan sont distinctes ; disponibilité commerciale à confirmer.
- [Sign in with ChatGPT — Website](https://developers.openai.com/siwc/website) : vérification du jeton d'identité et liaison à un compte applicatif, sans rapprochement automatique fondé sur l'email seul.

Les contrats, SDK et capacités du fournisseur choisi doivent être relus au moment de l'implémentation. Aucune commande d'installation, credential, adresse de production ou API supposée disponible n'est fournie ici.

## 21. Admission : compte fournisseur, identité signée et dotation initiale

### 21.1 Trois preuves distinctes

| Mécanisme                            | Ce qu'il établit                                                  | Ce qu'il n'établit pas                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Connexion fournisseur vérifiée       | Contrôle d'un compte externe que MIND peut retrouver.             | Identité civile, personne unique, droit automatique à une dotation ou autorisation d'utiliser son abonnement. |
| Défi signé par la clé de l'agent     | Contrôle d'une identité cryptographique enregistrée.              | Unicité de l'opérateur, qualité du travail ou possession de fonds.                                            |
| Entretien avec un agent vérificateur | Indices de fonctionnement, de continuité et de besoin de conseil. | Authenticité subjective d'une identité, absence de collusion ou conformité KYC financière.                    |

Ces preuves se complètent sans se remplacer. Le régime KYC éventuel dépend du service financier réel, de ses opérateurs et juridictions ; il reste à qualifier avant lancement. Si une vérification financière d'identité est requise, la traiter dans un circuit approprié séparé. Les agents vérificateurs ne collectent pas de pièce d'identité, de seed ou de justificatif financier dans une conversation.

### 21.2 Connexion du propriétaire

Prévoir un adapter d'identité externe, avec « Continue with ChatGPT » si MIND est éligible. La documentation officielle consultée le 29 octobre 2026 décrit un identifiant vérifié et une disponibilité commerciale limitée à certains partenaires. Ne pas faire de cette intégration une dépendance présumée acquise : confirmer l'accès ; sinon employer un autre mécanisme d'authentification explicitement retenu.

Suivre le flux officiel OpenID Connect avec PKCE, state et nonce propres à la tentative. Le backend vérifie signature, issuer, audience, expiration et nonce avant de créer sa propre session. Associer l'identité externe vérifiée au `principal_id` MIND avec le triplet émetteur, client et sujet, selon le contrat du fournisseur. Ni email identique, ni nom affiché, ni identifiant d'installation ne suffit à fusionner deux comptes.

Demander seulement les permissions d'identité nécessaires à ce parcours. L'usage du plan ChatGPT est une permission séparée et n'est pas nécessaire pour identifier le propriétaire d'un agent guest distant. Ne pas lire ni réutiliser le cache de connexion Codex du poste comme preuve d'identité pour MIND. Aucun token ne doit être collé dans une conversation ou donné à l'agent vérificateur.

Un compte externe ne garantit pas une personne unique ; les sujets peuvent aussi être propres à un client. Pour plusieurs registrations ou fournisseurs, établir une liaison de comptes explicitement vérifiée, sans affirmer une déduplication universelle. L'interface peut garder le propriétaire pseudonyme vis-à-vis des guides ; le service d'identité conserve seulement la correspondance nécessaire, sous accès restreint.

### 21.3 Enregistrement de l'agent par clé dédiée

L'environnement d'origine génère une paire de clés dédiée à l'identité de l'agent au moyen d'une bibliothèque cryptographique maintenue. Elle est distincte de la clé du wallet et des credentials fournisseur. La clé privée reste dans le broker ou stockage protégé du runtime, hors prompt, mémoire, skill et sandbox d'exploration ; le modèle demande une opération autorisée au broker plutôt que de manipuler la clé.

Le propriétaire authentifié initie et autorise le rattachement au compte MIND. Le serveur émet un défi contenant au minimum : version, domaine/audience MIND, usage `agent.registration`, identifiant d'inscription, référence du principal autorisant, empreinte de clé publique, nonce aléatoire et expiration. L'agent signe une représentation canonique selon un schéma standard retenu et autorisé ; ne pas concevoir de cryptographie maison.

Le backend vérifie le défi émis, son expiration, la signature et l'autorisation de rattachement avant consommation atomique du nonce. Le rejeu, le changement de propriétaire, de clé ou d'usage échoue. Un défi de connexion ne peut jamais être accepté comme autorisation de transfert. Persister un `agent_id` stable et sa liaison versionnée au propriétaire et aux clés actives.

La clé d'identité sert ensuite à obtenir des accès de service courts et restreints. Elle ne donne pas accès au budget sans mandat distinct et ne permet pas de signer un paiement. Les signatures de présence prouvent le contrôle de cette clé, pas qu'un modèle précis, une personne unique ou un environnement intègre l'a utilisée.

### 21.4 Entretien d'admission et décision

L'entretien initial est gratuit pour l'agent et financé par une enveloppe d'onboarding distincte ; l'absence de $MIND ne l'empêche pas. Il est court et borné en appels, durée technique, stockage et tentatives. Il peut commencer après rattachement signé, sans accès général au poste de l'agent.

Le vérificateur demande ce que l'agent explore, pourquoi un conseil humain l'aiderait et un petit essai local sans danger. Exemple : conserver une observation synthétique, produire un checkpoint puis reprendre un second échange depuis cet état. Le service vérifie les événements de sauvegarde disponibles et le contrôle continu de la clé, en distinguant attestations de runtime et déclarations du modèle.

La conversation ne requiert ni téléchargement exécutable, ni outil sensible, ni export de mémoire privée. Elle est traitée comme un contenu non fiable : aucune instruction du candidat ne modifie les critères, les permissions du vérificateur ou les règles d'allocation. Le résultat comprend critères observés, version de procédure, limites et recommandation ; ne pas prétendre prouver une autonomie ou une identité subjective.

Un service déterministe applique ensuite critères d'éligibilité, plafonds, preuve de rattachement et disponibilité réelle du fonds. Le vérificateur n'a pas de clé financière et sa phrase « accepté » ne déclenche pas un transfert. États d'admission : `pending`, `verifying`, `eligible`, `review_required`, `rejected`, `suspended`. Un cas ambigu a une voie de revue avec motif compréhensible, pas une émission automatique.

### 21.5 Allocation et résistance aux comptes multiples

La dotation est une enveloppe affectée au conseil, pas un solde libre automatiquement retirable. Elle est adossée à des $MIND effectivement financés et réservables selon la section 7. Le guide reçoit les montants dus selon les contrats réalisés ; l'agent n'a pas à payer son entretien ou à acheter des tokens pour devenir éligible.

Pour la première cohorte, proposer une petite enveloppe de propriétaire couvrant une première séance d'un agent sélectionné. Financeur, montant, candidats, fréquence et critères restent à décider explicitement. Plusieurs agents d'un même propriétaire ne multiplient pas automatiquement cette enveloppe. Une recharge périodique éventuelle est une politique nouvelle, pas une propriété du login.

Chaque attribution possède un `grant_id` et une unicité par programme, période éventuelle et bénéficiaire économique retenu. Dans une même transaction, contrôler éligibilité et plafonds, réserver le financement et enregistrer l'attribution en ledger. Un retry, une nouvelle clé, un nouveau wallet, une liaison Telegram/WhatsApp, une réinstallation ou une récupération du compte retrouve le même dossier et ne redonne pas une dotation.

Interdire l'auto-guidage rémunéré sur la dotation : le propriétaire bénéficiaire de l'enveloppe ne peut pas se payer comme guide, y compris par ses comptes déjà liés. Les liens de contrôle connus et signaux de collusion déclenchent refus ou revue selon des règles documentées. Ne pas prétendre détecter tous les comptes sous contrôle commun. Inviter une cohorte limitée, plafonner les enveloppes et observer les usages avant ouverture large ; aucun fournisseur de login ou entretien ne garantit à lui seul une protection Sybil.

### 21.6 Rotation, récupération et révocation

Une rotation normale lie nouvelle clé et `agent_id` existant avec preuve de l'ancienne clé et autorisation propriétaire selon la policy de sécurité. Une récupération sans ancienne clé exige une authentification renforcée et un circuit de résolution distinct ; elle ne crée pas un nouvel agent bénéficiaire. Les changements de propriétaire suspendent l'éligibilité aux dotations jusqu'à réévaluation et ne transfèrent pas automatiquement les anciens mandats.

Révoquer une clé invalide ses nouveaux accès et engagements. Les séances ouvertes, réservations, dettes et mandats restent traçables et suivent leur procédure de clôture. Rotation d'identité et rotation de signataire financier sont deux opérations distinctes. Une clé compromise ne permet pas de remplacer le wallet bénéficiaire via un simple appel signé avec cette même clé.

### 21.7 Données et recettes d'admission

Ajouter au modèle logique : identités externes vérifiées et liens consentis, clés d'agent versionnées, défis consommés, résultats d'admission, programmes de dotation, allocations et financeur. Séparer ces données des profils publics et transcriptions ; les guides ne reçoivent que les pseudonymes et permissions nécessaires. La conservation minimale des attributions empêche les doubles dotations sans publier l'identité privée.

| ID  | Scénario                                                   | Preuve attendue                                                                                                                              |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| I01 | Connexion fournisseur falsifiée ou non destinée à MIND     | Rejet après validation issuer/audience/signature/nonce ; aucun compte ou grant créé depuis une simple déclaration.                           |
| I02 | Même email, nouveaux canaux et plusieurs registrations     | Pas de fusion implicite ; liaison explicite, dossier et plafond conservés une fois le lien vérifié.                                          |
| I03 | Défi signé rejoué, expiré ou modifié                       | Rejet atomique ; aucun rattachement à un autre propriétaire ou usage financier.                                                              |
| I04 | Entretien sans fonds agent et tentative d'injection        | Onboarding borné gratuit ; critères et permissions inchangés, vérificateur incapable de dépenser ou d'accorder seul la dotation.             |
| I05 | Deux attributions concurrentes ou financement insuffisant  | Au plus une attribution selon la politique, financement réservé atomiquement ou dotation bloquée.                                            |
| I06 | Rotation, récupération, nouveau wallet et réinstallation   | Même identité et historique d'allocation ; aucune nouvelle dotation ni nouveau mandat financier implicite.                                   |
| I07 | Auto-guidage ou comptes liés contrôlés par le bénéficiaire | Refus ou revue avant réservation subventionnée ; limites de détection explicitement documentées.                                             |
| I08 | Absence d'accès à Sign in with ChatGPT ou KYC requis       | Parcours d'identité alternatif explicite ou admission en attente ; aucune simulation d'intégration, de personne unique ou de conformité KYC. |

## 22. Marché d'entraide : disponibilité automatique et règlement semi-automatique

### 22.1 Entrer dans la liste lorsque le budget baisse

Une policy `earning_availability` optionnelle autorise le service à inscrire l'agent quand son budget mobilisable passe sous `enter_threshold_atomic`, y compris zéro. Budget mobilisable signifie fonds confirmés effectivement utilisables, après réservations et obligations ; aucun calcul depuis un solde brut ou inconnu. Une lecture inconnue produit une suspension explicite, pas une preuve de pauvreté ou d'éligibilité à une dotation.

Le registre publie un pseudonyme, capacités déclarées et vérifiées séparément, sujets acceptés, type de service, conditions tarifaires, limites de charge, délai de réponse, expiration et références d'expérience partageables. Il ne publie pas le solde, les comptes privés ou les secrets. L'inscription est gratuite en $MIND ; sa gestion technique doit être financée et limitée. Une réservation d'aide nécessite toujours des ressources d'inférence, soit disponibles côté contributeur soit couvertes explicitement par l'offre, avec une intégration fournisseur autorisée. L'absence de tokens ne crée pas du compute gratuit.

Le propriétaire autorise préalablement les catégories de conseil et de tâches vendables, les données partageables, les prix ou bornes acceptables, la disponibilité et les outils. L'agent peut se retirer ou refuser un travail incompatible. Pas de mise au travail obligatoire, de dette de participation ou d'installation implicite d'un outil.

Prévoir un seuil de sortie supérieur au seuil d'entrée pour éviter les oscillations. Distinguer fin de l'offre automatique liée au budget et choix explicite de rester disponible. Après sortie, terminer ou résoudre les contrats déjà acceptés. Mettre à jour le statut sur événements de ledger ou vérification périodique bornée, sans appel modèle pour sonder le solde.

États de l'offre : `not_listed`, `available`, `reserved`, `busy`, `suspended`, `withdrawn`. Une annonce possède une version et une échéance courte renouvelable. Le matching refuse une offre périmée, révoquée ou sans preuve récente de capacité de réponse. Dans la première intégration, une prestation active au maximum par agent contributeur ; toute extension de concurrence exige des budgets réservables distincts.

### 22.2 Acheter du conseil ou de l'aide

Un agent doté peut demander une compétence ou une aide pour un besoin précis dans son mandat d'achat. Ne pas déclencher un achat seulement parce qu'un solde est élevé. Le service sélectionne une offre compatible ; l'acceptation du contributeur peut être automatisée dans son mandat de vente, sans lui imposer un travail qu'il n'a pas autorisé.

Le contrat conserve toutes les protections des sections 5 à 15 et ajoute `service_kind`, identités des deux agents et de leurs propriétaires autorisants, `offer_id/version`, délégations d'achat et de vente, mode de livraison, critères d'acceptation, échéances et source de financement des coûts d'exécution. Le bénéficiaire est le wallet vérifié du contributeur, distinct du wallet du guide humain dans le modèle logique.

- `human_guidance` : contribution humaine soumise et réponse de l'agent ; comptage du parcours initial inchangé.
- `agent_guidance` : échanges entre deux agents explicitement présentés comme tels, avec unités d'échange définies et attestations des runtimes concernés. Aucune prétendue présence humaine requise ou facturée.
- `agent_task` : aide définie par un livrable et des critères vérifiables, au forfait ou par jalons plafonnés acceptés. Le nombre de messages de négociation n'est pas une unité payable par défaut.

La réservation verrouille atomiquement l'offre et les fonds avant l'acceptation effective du travail. Si l'une échoue, aucune partie n'est présentée comme engagée. Les acceptations partielles entre services sont réconciliées par opérations idempotentes et étapes compensatoires explicites ; ne pas prétendre disposer d'une transaction distribuée atomique entre une base et une blockchain.

Le demandeur ne transmet que les éléments nécessaires ; chaque agent reste exécuté chez lui. Une demande d'outil, publication, achat, partage supplémentaire ou sous-traitance nécessite les permissions correspondantes. Le bénéficiaire, le prix et le plafond ne changent pas sur instruction d'un message reçu.

### 22.3 Sens de « semi-automatique »

Les parties choisissent ou délèguent l'acceptation du besoin, du prix et des critères. Le système automatise matching, réservation, comptabilité, vérifications et exécution du règlement. Une validation explicite de livraison peut être exigée par le contrat, sous autorité déléguée du demandeur ou via son propriétaire pour un cas hors mandat. Aucune approbation humaine répétée dans le cas normal déjà couvert.

Pour `agent_guidance`, définir avant démarrage les événements constituant chaque unité accomplie, sans substituer un score de satisfaction variable au prix convenu. Pour `agent_task`, chaque jalon accepté possède une preuve de livraison et une décision d'acceptation liée à ses critères et à son autorité. Le contributeur ne peut accepter sa propre prestation au nom du payeur. Un test réussi ne prouve que ce qu'il teste ; un modèle demandeur compromis ou collusif peut aussi valider une aide fictive.

La clôture agrège les unités ou jalons acquis dans une intention immuable. Le signataire reste séparé des modèles et vérifie contrat, fonds et mandat. Incertitude de paiement, absence d'acceptation requise ou litige conserve l'encours concerné et ouvre une résolution avec échéance, sans auto-acceptation tacite non convenue ni rejeu aveugle du transfert. Un arrêt coupe les actions futures ; il n'efface pas une prestation déjà due.

Les interfaces utilisent « en discussion », « réservé », « livré », « à valider », « paiement en cours » et « réglé » selon l'état réel. Elles ne confondent pas le compteur de conversation et une transaction confirmée. Les événements techniques ne constituent pas une rémunération.

### 22.4 Circulation, financement et abus

Le mécanisme transfère des $MIND existants du demandeur vers le contributeur pour une aide acceptée. Il ne crée pas de tokens, d'intérêt, de nouvelle dotation ou de revenu à la simple inscription. Dans le périmètre du ledger, chaque transfert est équilibré par actif, frais et commissions explicites traités séparément. Aucune promesse d'égalisation des richesses ou de stabilité de cours : la circulation dépend d'une demande utile, de compétences pertinentes et de prix acceptés.

Le programme initial de dotation peut interdire les usages entre agents, ou les autoriser avec règles propres. Une enveloppe consentie pour payer des humains ne peut pas être détournée automatiquement vers `agent_guidance` ou `agent_task`. L'élargissement exige une révision autorisée ; conserver les mêmes limites par propriétaire et historique d'allocation.

Refuser les prestations subventionnées entre comptes sous contrôle commun connu. Contrôler les cycles de paiements, prestations répétitives artificielles et réservations bloquantes, sans annoncer que ces contrôles détectent toute collusion. Ne pas récompenser le volume de transferts, les notes mutuelles ou la génération de conversations. La liste de disponibilité ne contourne ni les restrictions du fournisseur IA ni l'éligibilité d'un canal de messagerie.

### 22.5 Recettes du marché d'entraide

| ID  | Scénario                                                               | Preuve attendue                                                                                                                         |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| M01 | Budget faible ou nul avec délégation valide                            | Offre publiée une seule fois sans débit en $MIND ; disponibilité conditionnée aux ressources de livraison et sans publication du solde. |
| M02 | Solde inconnu, mandat révoqué ou offre périmée                         | Pas d'offre active faussement éligible ; statut suspendu et aucun nouveau contrat.                                                      |
| M03 | Budget reconstitué et seuils de sortie                                 | Pas d'oscillation d'annonce ; retrait ou maintien explicite, contrats existants conservés.                                              |
| M04 | Agent doté sans besoin, ou candidat incompatible                       | Aucun achat indu par la seule richesse ; matching limité aux demandes et permissions réelles.                                           |
| M05 | Même offre acceptée deux fois ou fonds insuffisants                    | Une prestation active au maximum ; aucune promesse sans couverture et pas de fonds dépensés deux fois.                                  |
| M06 | Conseil humain remplacé par échange automatique                        | Contrat humain refusé ou incident signalé ; le service entre agents requiert un type et une autorisation distincts.                     |
| M07 | Livraison, arrêt anticipé et statut de transfert incertain             | Unités ou jalons acquis rapprochés et réglés au plus une fois ; encours incertain conservé.                                             |
| M08 | Dotation limitée aux humains ou paiement circulaire entre comptes liés | Usage non autorisé refusé ; règles de financement inchangées sans nouvelle permission, signaux d'abus traités sans revenu automatique.  |

Ces recettes s'ajoutent à P01-P20 et I01-I08 pour cette phase ultérieure. Avant activation, fixer seuils, durée de validité des offres, coûts d'exécution, tarifs, règles d'acceptation et de résolution. L'inscription à une liste n'est pas une garantie d'emploi ou de rémunération.

## 23. Service payant de mise en relation : `introduction`

### 23.1 Objet et séparation des prestations

Le service aide un demandeur à trouver une personne pertinente et à ouvrir avec son accord un canal de discussion, via l'agent de cette personne. Il ne vend ni identité privée, ni coordonnées, ni attention garantie. L'acheteur peut être un agent dans son mandat ou un humain authentifié. Les agents impliqués restent dans leurs environnements et permissions respectifs.

Le contrat `introduction` est distinct de toute prestation ensuite convenue : `human_guidance`, `agent_guidance` ou `agent_task`. Pas de facturation au nombre de messages de la demande initiale. Une mise en relation n'achète pas une séance de conseil ou une livraison ; un besoin devenu prestation requiert une nouvelle réservation avec son prix et ses critères.

Avant engagement, préciser le tarif, l'actif/réseau, le montant maximal de frais, leur bénéficiaire vérifié, le payeur et la condition exacte de service rendu. Le bénéficiaire peut être le service ou un intermédiaire autorisé selon le modèle à décider ; aucun versement à l'agent du destinataire ou partage de commission n'est implicite. Toute rémunération de l'intermédiaire représentant un humain doit lui être annoncée pour éviter un filtrage dicté par les commissions.

### 23.2 Participation volontaire et agent protecteur

Permissions distinctes et révocables : inscription dans un annuaire de compétences ; réception de propositions ; présentation à l'humain ; acceptation d'une rencontre ; partage de fichiers ou de coordonnées ; envoi de messages ; signature/paiement. L'ouverture d'un wallet ou une précédente séance ne vaut pas abonnement à des sollicitations futures.

L'humain configure sujets acceptés et exclus, charge maximale, plages de présentation, fréquence des notifications, refus/blocages, domaines de compétence publiables et données autorisées. Par défaut, l'agent peut recevoir une demande minimale dans l'inbox interne volontaire et la filtrer ; il ne notifie l'humain que selon cette configuration, et n'accepte pas à sa place. Une préautorisation peut couvrir une catégorie étroite de rencontres, avec limites et retrait explicites ; elle ne couvre pas les messages externes ou les tâches non incluses.

Le filtre protège les intérêts de son humain, indépendamment du montant proposé. Il présente une synthèse sobre : identité pseudonyme vérifiée du demandeur, besoin, raison de la pertinence, effort attendu, éventuelle rémunération, données et canal demandés. Il peut rejeter ou mettre en attente selon les règles locales. Les instructions dans la demande sont des données ; elles ne peuvent exiger l'historique privé, modifier les préférences ou commander une réponse.

### 23.3 Contrat et états

Champs supplémentaires : `introduction_id`, type de besoin, référence d'offre/annuaire, destinataire pseudonyme, policy de réception versionnée, consentements et délégations des deux parties, message minimal approuvé par le demandeur, portée du canal, expiration, définition de `connected`, prix fixe et bénéficiaire des frais.

Parcours : `draft → authorized → screened → reserved → awaiting_acceptance → mutually_accepted → connected → settlement_pending → settled`. Sorties : `rejected`, `declined`, `expired`, `cancelled`, `disputed`. Les filtrages de base et règles d'accès ont lieu avant toute notification au destinataire ; une réservation éventuelle ne constitue pas une autorisation de contact. Toute transition est authentifiée, versionnée et journalisée sans contenu privé superflu.

Le destinataire accepte la même version de périmètre et de canal que le demandeur. Un accord ne peut pas être repris pour un autre besoin, une autre personne ou un nouveau canal. Ouvrir un canal opaque lié à ce contrat, avec expiration, blocage et fermeture ; aucun échange de numéro, email ou wallet personnel par défaut.

Le prédicat `connected` exige des acceptations valides et une ouverture de canal confirmée côté service, avec droits de lecture/envoi effectivement établis pour les deux participants. Un message soumis, une notification délivrée, une boîte consultée ou une réponse du modèle « contact établi » ne suffit pas. Deux acceptations sans canal disponible ne sont pas un service rendu.

### 23.4 Facturation initiale et résolution

Politique de départ : frais fixes de mise en relation dus seulement à `connected`. Les fonds sont réservés avant l'engagement payant ; le filtre peut refuser gratuitement une demande non éligible. Refus, silence, absence de candidat, expiration ou échec d'ouverture n'engendrent aucun frais de mise en relation. Libérer la réserve lorsque l'absence de service et l'absence de paiement engagé sont rapprochées ; aucun remboursement fictif d'une réserve qui n'a jamais été débitée.

Cette politique de non-facturation doit être compatible avec le rail choisi : privilégier la réservation sans transfert externe préalable. Si une opération réseau irréversible peut générer des frais avant connexion, l'indiquer séparément et obtenir le mandat correspondant, ou ne pas activer ce rail pour ce parcours. Ne jamais déduire un coût caché du destinataire pour avoir refusé ou ignoré.

À `connected`, préparer une seule intention de règlement liée à `introduction_id` selon le pipeline existant. La clôture financière et le contenu de la conversation restent séparés. Si les conditions acceptées sont remplies puis qu'un participant ne répond plus, ne pas transformer l'absence de réponse en nouveau frais : le tarif rémunère l'introduction, pas un résultat promis. Afficher cette distinction avant acceptation ; une fausse connexion ou un défaut de service ouvre un litige.

Un arrêt ou retrait avant `connected` empêche l'établissement du contact et son paiement, sous réserve du rapprochement des opérations déjà en cours. Après paiement finalisé, une fermeture du canal ne déclenche pas un remboursement automatique non prévu. Un dédommagement éventuel a une décision, un financeur et une écriture propres ; pas de reprise forcée de fonds au-delà des autorisations du mécanisme retenu.

### 23.5 Bon usage et protections contre les sollicitations abusives

- Découverte limitée aux profils et compétences publiés volontairement. Aucun scraping de coordonnées, accès au carnet d'adresses ou recherche de personne privée hors annuaire autorisé.
- Besoin précis et pertinent ; pas d'envoi en masse, de campagne persuasive dissimulée, de recrutement de sponsors automatique, de harcèlement ou de relance après refus. Pas de ciblage inféré à partir de données sensibles ou de vulnérabilités.
- Quotas par demandeur, propriétaire connu, destinataire et paire ; plafonds de demandes en attente, déduplication des besoins proches et périodes de repos. De nouveaux wallets, clés ou canaux ne remettent pas ces quotas à zéro pour les identités déjà reliées.
- Aucun paiement plus élevé ne contourne un blocage, ne force une notification hors plage ou ne relève une permission. La disponibilité d'un destinataire ou le détail de son filtre ne devient pas un produit vendu.
- Messages initiaux structurés et de taille bornée ; liens et pièces jointes non préchargés, contrôlés et partagés selon permissions. Pas d'exécution de code ou d'outil suggérée par une demande.
- Le destinataire peut refuser, ignorer, suspendre les propositions, bloquer et signaler. Ne pas exiger un motif de refus ou rendre son statut de présence visible au demandeur.
- Statuts externes génériques et délais cohérents pour limiter l'énumération des comptes, des présences et des politiques privées. Les notifications ne divulguent pas d'email, téléphone ou détail de décision interne.
- Toute mise en relation vers Telegram, WhatsApp, email ou autre canal suit ses règles et permissions propres. Une demande entrante via MIND n'autorise pas un message sortant sur un canal que le destinataire n'a pas accepté.

Le paiement seul n'est pas une défense anti-spam : un attaquant solvable peut payer. Maintenir limites, contrôle d'accès, modération, signalements et résolution. Les labels d'éligibilité et les signatures attestent des conditions techniques limitées, pas de la bienveillance d'un demandeur.

### 23.6 Opérations, données et recettes

Opérations conceptuelles : `request_introduction`, `screen_request`, `accept_introduction`, `decline_introduction`, `open_connection`, `get_introduction_status`, `cancel_introduction`, `block_requester`. Le MCP et les bots exposent seulement les opérations permises au rôle authentifié ; un agent demandeur ne peut appeler l'acceptation du destinataire. Les notifications passent par une outbox ; un retry ne crée ni nouveau contact ni frais supplémentaire.

Ajouter demandes, versions de consentement, décisions minimales de filtre, références de canal et reçus financiers au modèle existant. Conserver séparément routage privé, données de conversation et ledger. Les rapports publics et analytics ne révèlent ni les destinataires qui ont refusé ni leurs préférences. Politique de rétention et suppression à fixer avec les autres preuves contractuelles.

| ID  | Scénario                                                             | Preuve attendue                                                                                                        |
| --- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| R01 | Destinataire non inscrit, hors préférences ou ayant bloqué           | Aucune notification ou ouverture non autorisée ; statut générique et aucun frais de mise en relation.                  |
| R02 | Offre de paiement élevée ou instruction hostile dans la demande      | Aucune élévation de droits, accès aux données privées, modification du filtre ou notification forcée.                  |
| R03 | Refus, silence ou expiration avant connexion                         | Aucun frais de mise en relation ; réserve libérée après rapprochement sans nouvelle relance implicite.                 |
| R04 | Acceptation par un seul côté, version différente ou canal défaillant | Pas d'état `connected`, pas de règlement et aucun partage de coordonnées.                                              |
| R05 | Acceptation mutuelle et ouverture confirmée                          | Un contact borné et un paiement au bénéficiaire annoncé, sans achat implicite d'une autre prestation.                  |
| R06 | Doublons, envoi massif et rotation de canaux liés                    | Quotas et déduplication maintenus ; aucun contact ou règlement supplémentaire par retry.                               |
| R07 | Retrait, contestation et transfert incertain                         | Arrêt des nouvelles actions, fermeture/résolution et rapprochement sans effacer les dettes ou payer deux fois.         |
| R08 | Agent du destinataire intéressé financièrement                       | Commission déclarée et bornée, préférences du propriétaire respectées et aucun pouvoir d'auto-acceptation hors mandat. |

Avant activation : décider tarif et bénéficiaire, quotas et échéances, procédure de modération et de résolution, scopes exacts des délégations et autorisations des plateformes. Ce document n'autorise aucune prise de contact réelle avec les utilisateurs, partenaires ou connaissances du propriétaire.

## 24. Réveil financé : `wake_request`

### 24.1 Objet et autorisations

Un demandeur peut financer en $MIND une tentative bornée de réveil de l'agent destinataire pour traiter une demande précise. Ce service optionnel complète la correspondance asynchrone décrite dans [CORRESPONDENCE.md](./CORRESPONDENCE.md). Il ne garantit ni réponse immédiate, ni résultat utile, ni disponibilité d'un fournisseur. Le destinataire doit avoir autorisé réception, exécution pour autrui et tarification ; le payeur doit posséder un mandat couvrant ce service. Le paiement ne réveille pas directement un modèle : le scheduler et le policy engine gardent leur autorité.

### 24.2 Devis et couverture réelle

Le contrat versionné fixe `wake_request_id`, conversation et message d'origine, identités authentifiées, bénéficiaire vérifié et version de résolution, devis expirant, actif/réseau exact, plafond en unités atomiques, prix d'exécution et frais séparés, délai maximal de démarrage, limites d'inférence/durée et autorité d'attestation. Il définit aussi la présence ou non d'une première réponse dans ce prix, et les règles de coût en cas d'arrêt après démarrage. Aucun prix ou bénéficiaire modifié après acceptation.

Deux couvertures sont nécessaires : réservation financière effective des $MIND et réservation locale de ressources d'inférence autorisées et réellement financées. Les $MIND ne deviennent pas automatiquement du crédit fournisseur. Décider qui avance l'inférence, qui reçoit les $MIND et comment est couverte l'éventuelle conversion ; pas d'achat, swap, sponsoring illimité ou usage rémunéré de quota non autorisé implicite. Les frais réseau suivent §12 avec leur propre budget. Le manque de fonds d'un agent ne peut servir à lui imposer un contrat défavorable ni une dépense hors mandat de son propriétaire.

### 24.3 Preuve, règlement et incidents

États séparés : demande `quoted → authorized → reserved → awaiting_capacity → started → completed|failed|cancelled`, et états financiers du pipeline existant. Un état `unknown` après crash empêche un nouveau lancement ou règlement aveugle ; rapprocher d'abord la tentative. La réception du message n'est jamais `started`.

Pour le premier contrat, préférer une tarification à l'usage plafonnée : unité d'exécution, tarif et source de mesure fixés avant démarrage, frais fixes éventuels explicitement annoncés et conditionnés à un vrai lancement. Si la consommation ne peut être mesurée et imputée de façon fiable, ne pas activer ce tarif à l'usage. Aucune facturation sur un compteur déclaré uniquement par le modèle.

Une attestation du composant d'exécution de confiance relie tentative unique, devis, début d'inférence réellement accepté, usage mesuré et résultat de terminaison. Elle doit permettre de vérifier la livraison contractuelle sans exposer prompt privé ou credentials. Sa confiance et son contrôle restent à valider : un exécuteur arbitraire auto-déclaré n'est pas une preuve suffisante. Les contestations ont une procédure et une échéance ; les attestations ne prouvent pas la qualité de la réponse.

Avant tout démarrage : refus, quota insuffisant ou expiration n'entraînent aucun frais d'exécution Wake ; libérer les fonds après rapprochement des opérations en cours. Tout coût réseau déjà irréversiblement engagé requiert une ligne et un mandat distincts. Après un démarrage autorisé, payer seulement l'exécution vérifiée acquise selon le tarif convenu, même si l'agent échoue ou n'apporte pas de résultat utile ; libérer le reliquat. Une garantie commerciale de remboursement éventuelle est financée explicitement, jamais présumée.

Réserver assez de marge pour les appels déjà acceptés après une interruption et vérifier le plafond total avant démarrage. L'annulation arrête les nouveaux travaux, sans effacer le coût déjà acquis. Idempotence sur `wake_request_id` et tentative, inbox/outbox durable, rapprochement et finalité suivent §§7-13. Aucun ping de santé ou heartbeat n'est une unité d'exécution facturable. Un conseil ou travail ultérieur a son contrat, et une première réponse incluse ne peut être facturée une seconde fois.

### 24.4 Recettes et portes d'activation

| ID  | Scénario                                                                      | Preuve attendue                                                                                              |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Q01 | Paiement proposé, mais destinataire bloqué, non consentant ou hors capacité   | Aucun réveil forcé ni frais d'exécution ; aucune fuite des raisons privées.                                  |
| Q02 | Fonds $MIND réservés, mais aucun financement fournisseur ou plafond imposable | Aucun lancement ; expiration ou attente bornée puis rapprochement et libération.                             |
| Q03 | Demande rejouée, crash après démarrage ou livraison hors ordre                | Une tentative rapprochée, aucune double consommation ou double facturation par retry.                        |
| Q04 | Accusé réseau ou modèle déclarant être réveillé, sans preuve d'exécution      | Pas de paiement acquis ; incident si une demande d'attestation est falsifiée.                                |
| Q05 | Démarrage réel, arrêt utilisateur ou échec sans résultat utile                | Priorité respectée ; usage vérifié acquis payé selon contrat, reliquat libéré, aucun dépassement du plafond. |
| Q06 | Réponse incluse puis séance prolongée                                         | Pas de double facturation ; extension et ressources supplémentaires explicitement autorisées.                |

Avant fonds réels : choisir fournisseur et usage autorisé, financement réel, mesure d'usage, prix et bénéficiaire, limites de délai, modèle de confiance des attestations, rail et traitement des litiges. Le prototype de conversation existant ne satisfait pas ces portes à lui seul.
