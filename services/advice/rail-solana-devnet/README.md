# Rail de règlement Solana devnet — INTÉGRATION DE TEST

Adapter `SettlementAdapter` (voir `services/advice/session/rail.ts`) qui règle de vrais transferts **sur devnet**, avec un mint de test qui reproduit le profil de $MIND relevé en `TRANSACTIONS.md` §19.1 : Token-2022, 9 décimales, frais de transfert de 1 %. Jetons sans valeur, aucun paiement réel. C'est le seul module autorisé à importer le SDK Solana (révision d'`AGENTS.md` du 29 octobre 2026).

## Garde-fous

- `SolanaDevnetRail.open` refuse le mint mainnet de $MIND, tout réseau dont le genesis n'est pas celui de devnet, un mint hors Token-2022, sans `TransferFeeConfig`, avec transfer hook ou avec d'autres décimales.
- `submit` refuse un payload `simulated: true`, un autre `networkId` / `assetId`, un montant hors plafond (`perTransferCap`) et un bénéficiaire non résolu.
- Le service de séances refuse cet adapter (`not_simulated`) : il reste SIMULÉ. Le câblage exige une nouvelle décision dans `AGENTS.md`.
- Les clés sont des clés de test générées localement dans `.local/solana-devnet/kit.json` (ignoré par git).

## Fonctionnement

| Fichier   | Rôle                                                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fees.ts` | Frais Token-2022 exacts (arrondi supérieur, plafond, époque), deux modes : `recipient_bears`, `sender_grosses_up`.                                       |
| `port.ts` | Accès RPC minimal (`@solana/kit`) ; remplacé par une chaîne factice dans les tests.                                                                      |
| `rail.ts` | Adapter : transaction signée **persistée avant envoi**, renvoi des mêmes octets, nouvelle transaction seulement après expiration, mémo de rapprochement. |
| `kit.ts`  | Kit de test devnet : clés, airdrop, mint à 1 %, émission de 1 000 000 jetons de test.                                                                    |

- **Frais.** Le taux en vigueur et celui de l'époque suivante doivent égaler le taux attendu, sinon `fee_changed` (l'intention est gelée par le service). Une tentative signée avec l'ancien taux échouerait on-chain : `TransferCheckedWithFee` vérifie les frais déclarés. `details(key)` donne envoyé / frais / reçu pour le reçu.
- **Incertitude.** Tant qu'une tentative peut encore atterrir (hauteur de bloc ≤ `lastValidBlockHeight`), `lookup` lève `SettlementUnavailableError` : l'absence n'est pas probante. Après expiration, une absence l'est.
- **Mémo public.** `mind-wake/devnet-test/v1 k=<sha256(clé)> d=<digest du payload>` : ni clé, ni principal, ni montant en clair, mais corrélable entre transferts (TRANSACTIONS §17).
- **Fencing.** Imposé par la base locale du signataire, pas par la chaîne.

## Non couvert

Signature hors processus (TRANSACTIONS §4 : service de signature à policies) ; résolution de wallet vérifiée ; enveloppe préfinancée verrouillée (P04) ; reorgs au-delà de `finalized` ; mainnet.

## Utilisation

```bash
npm run devnet:kit
```

```bash
MIND_WAKE_DEVNET_SMOKE=1 npx vitest run test/advice/rail-solana-devnet/devnet-smoke.test.ts
```

Le faucet public devnet limite son débit ; s'il refuse, relancer plus tard ou financer l'adresse du payeur affichée.

Tests sans réseau : `test/advice/rail-solana-devnet/`.
