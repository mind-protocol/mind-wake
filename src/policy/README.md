# src/policy

Policy engine (session S4, SPEC §4 et §5.1, AGENTS §5 « Voie abonnement expérimentale », ADR-004). Code pur : il dépend seulement des interfaces de `src/contracts/`. Les fonctions qui écrivent s'appellent dans `UnitOfWork.transaction`.

- `validate.ts` : valide un brouillon non fiable. Une limite obligatoire absente ou invalide, un champ inconnu, un chemin non confiné ou un hôte joker empêchent toute révision. Valeurs par défaut sûres : aucun fichier, outil, réseau, dépense ni voie abonnement.
- `revisions.ts` :
  - `proposeRevision` crée une proposition sans effet ; la skill ou la CLI peut l'appeler.
  - `grantConsent` exige le jeton du canal de confiance et l'empreinte exacte du contenu confirmé. Il refuse une proposition construite sur une révision qui n'est plus en vigueur.
  - `revokePermissions` révoque la révision en vigueur, sans retour à une révision antérieure.
  - `resolvePolicy` donne la révision en vigueur.
- `change.ts` : classe chaque champ en élargissement, restriction ou mixte. Un changement non ordonnable compte comme un élargissement.
- `decide.ts` :
  - `decideActivation`.
  - `decideLaunch` : faits fournis par le scheduler, l'adapter, la sandbox et le ledger.
  - `assessActiveSession` et `decideAction` : conditions revérifiées avant chaque action. `interruptSession` signale qu'il faut interrompre la session.
  - `decisionJournalEvent`.

Motif stable : `reason` (`DenyReason`) et `detail` au format `code[: contexte]`.

## Refus par défaut

Ces conditions sont vérifiées au lancement ET avant chaque action. Si l'une est absente, mal formée ou défavorable, la décision est un refus. Pendant une session, ce refus s'accompagne de `interruptSession: true` :

- horloge ;
- signal de priorité humaine : un signal plus ancien que `humanPriority.maxSignalAgeMs` ou daté du futur vaut condition inconnue ;
- sandbox ;
- mode abonnement et lectures de quota.

Au lancement s'ajoutent :

- le runtime exact, sans substitution ;
- une borne de tokens imposable ;
- l'annulation ;
- la compatibilité d'isolation ;
- la facturation et la tarification ;
- la fenêtre horaire, le backoff et l'absence de session ouverte ;
- les disponibilités de tokens, de sessions et de monnaie.

## Frontière du canal de confiance

La provenance d'un consentement n'est jamais établie par une donnée : ni un champ `proof`, ni un objet `{ channel: "local_cli" }`, ni un texte venant du modèle, d'un checkpoint ou d'une exploration.

`grantConsent` exige un jeton émis par `openTrustedUserChannel()`. Le jeton est enregistré dans une `WeakSet` du module, donc impossible à reconstruire depuis un JSON. Seul le point d'entrée humain (CLI locale, S5) doit l'ouvrir, après une saisie de confirmation faite par l'humain.

Cette garantie est interne au processus. Elle repose sur le fait que le modèle n'exécute pas de code dans le processus du daemon, ce qu'assure l'isolation (S2, S10), pas cette fonction. `proof` n'est qu'une référence journalisée, jamais une preuve d'authenticité.

## Ce que les contrôles de chemins ne garantissent pas

`isConfinedPath` et la décision `file_*` refusent seulement les sorties lexicales : `..`, chemins absolus, lecteurs, `\`, flux NTFS `:` et segments terminés par `.` ou une espace. Un chemin accepté ici peut encore sortir de la racine par un lien symbolique, une jonction, un point de montage ou une course entre la vérification et l'accès.

La sandbox et les checkpoints (S8, S10) doivent donc :

- résoudre le chemin réel (`realpath`) au moment de l'accès ;
- refuser les points de reparse ;
- ouvrir les fichiers relativement à un descripteur de racine ;
- faire appliquer les droits par le système (AppContainer/ACL).

Aucune fonction de ce module ne fournit de garantie système.

## Voie abonnement (`budget.subscriptionQuota`, ADR-004, ADR-005)

La voie est absente ou désactivée par défaut. Son activation dans une révision consentie exige `accountRiskAcknowledged: true`, des seuils cohérents (`stopAt + overshoot ≤ 10 000 − userReserve`, avec `start < stop`) et un délai maximal avant remise à zéro `launchWhenResetWithinMs` (entier > 0 ; l'augmenter élargit, le réduire restreint).

Le lancement exige en plus :

- `billing.kind === "subscription_quota"`, sans quoi la jauge de quota ne compte pas comme borne ;
- un `overshootBoundBasisPoints` non nul ;
- `providerQuotaReading: "official"` ;
- au moins une lecture de fenêtre ; chaque lecture doit être `measured`, plus récente que `maxSnapshotAgeMs` et sous `startBelowBasisPoints` ;
- **déclenchement avant remise à zéro (ADR-005)** : chaque fenêtre lue doit avoir un `resetsAt` futur à moins de `launchWhenResetWithinMs` (`outside_window`, `subscription.reset_not_within: <fenêtre> resets_in_ms=…`, attente) ; une remise à zéro déjà passée rend la lecture périmée (`budget_unknown`). Toutes les fenêtres sont exigées, y compris une fenêtre hebdomadaire : Wake ne consomme que ce qui serait perdu de toute façon.

Sur cette voie, la garde de quota est la borne : aucun plafond de tokens propre à Wake n'est exigé (`tokens.availability` n'est pas vérifiée ; les champs de tokens restent obligatoires dans le schéma mais ne bornent pas la session). La voie ne lève aucune autre condition : isolation, priorité humaine, annulation et sessions restent exigés. En session, une fenêtre qui atteint `stopAtBasisPoints`, ou une lecture absente, ancienne ou non mesurée, exige l'interruption. Aucun pourcentage n'est converti en tokens.

Limite : le moteur traite une valeur non nulle de `overshootBoundBasisPoints` comme une borne consentie. Il ne peut pas vérifier que cette valeur vient d'une mesure validée, car le contrat ne porte aucune référence de mesure.

## Mode non isolé (`runtime.hostUnsandboxedAcknowledged`, ADR-006)

Absent par défaut ; seule la valeur `true` est valide. L'accorder est un élargissement (nouveau consentement humain via `enable`, qui affiche l'exposé du risque), le retirer une restriction appliquée aux sessions actives. Avec ce consentement, `decideLaunch` et l'évaluation en session n'exigent plus `sandboxOperational` ni `isolationCompatible` ; toutes les autres conditions (fenêtres, priorité humaine, pause, arrêt, garde de quota, budget, permissions) restent vérifiées.
