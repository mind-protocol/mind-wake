# src/policy

Policy engine (session S4, SPEC §4 et §5.1). Code pur : dépend seulement des interfaces de `src/contracts/` ; les fonctions qui écrivent s'appellent dans `UnitOfWork.transaction`.

- `validate.ts` : validation d'un brouillon non fiable. Limite obligatoire absente ou invalide, champ inconnu, chemin non confiné ou hôte joker → aucune révision. Valeurs par défaut sûres des champs facultatifs : aucun fichier, outil, réseau ni dépense.
- `revisions.ts` : `proposeRevision` (skill ou CLI, sans effet) puis `grantConsent` (jeton `openTrustedUserChannel`, réservé à la CLI locale, et empreinte exacte du contenu confirmé). Une proposition construite sur une révision qui n'est plus en vigueur est refusée. `revokePermissions` révoque la révision en vigueur, sans retour à une révision antérieure. `resolvePolicy` donne la révision en vigueur.
- `change.ts` : classement champ par champ (élargissement, restriction, mixte). Un changement non ordonnable compte comme un élargissement.
- `decide.ts` : `decideActivation`, `decideLaunch` (faits fournis par le scheduler, l'adapter, la sandbox et le ledger ; fait absent → refus), `assessActiveSession` et `decideAction` (`interruptSession` signale qu'une restriction, une révocation, une pause ou un arrêt exige d'interrompre la session), `decisionJournalEvent`.

Motif stable : `reason` (`DenyReason`) et `detail` au format `code[: contexte]`.
