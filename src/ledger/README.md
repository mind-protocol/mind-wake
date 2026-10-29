# src/ledger

Session S3. Ledger de budget sur SQLite (SPEC §6) : `SqliteLedgerRepository` implémente `LedgerRepository`.

Règles retenues :

- **Périodes** calculées dans le fuseau IANA de la policy (jour, semaine — lundi par défaut —, mois), persistées en UTC avec leurs plafonds (`PeriodLimit`). Une journée de bascule d'heure dure 23 h ou 25 h ; un minuit absent commence au premier instant existant.
- **Horloge monotone** : le ledger garde par profil l'instant le plus récent observé (`ledger_clocks`). Un recul d'horloge ne ramène jamais vers une période antérieure, même après redémarrage. Revers : une avance erronée de l'horloge ouvre la période future et y reste jusqu'à ce que l'heure réelle la rattrape.
- **Disponible** = plafond − rapproché − réservations `open`/`uncertain` (à leur borne, ou à l'usage rapporté s'il la dépasse) − réserve utilisateur. Une unité sans plafond, ou une devise différente de celle du plafond, donne `available: null` et la réservation est refusée (`budget_unknown`).
- **Réservation** atomique multi-unités en `BEGIN IMMEDIATE`, idempotente sur son identifiant ; refusée si une autre réservation `open` existe pour le profil (`session_already_active`) ou si aucune période fournie ne couvre l'instant.
- **Rapprochement** : imputation et clôture dans la même transaction ; rejoué, il ne change rien. Usage mesuré ou simulé : somme rapportée. Usage estimé ou inconnu : borne maximale (ou plus si rapporté plus). Unité réservée sans usage : borne, provenance `unknown`. `reconciledByProvenance` garde les quatre provenances séparées.
- **Sessions à cheval** : `ensurePeriodsCovering` fournit toutes les périodes que la session peut toucher ; la réservation compte dans chacune, et l'usage rapproché y est imputé en entier (prudent : aucune répartition fiable n'est disponible).
- **Usage** : chaque `UsageRecord` est un incrément ; un enregistrement rejoué à l'identique (même unité, montant, provenance, date) est ignoré. Ne pas repasser à `reconcile` un usage déjà transmis par `recordUsage`.
