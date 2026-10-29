# Service de séances de conseil — SIMULÉ (piste G1)

Prototype du parcours de conseil guest distant (SPEC §14, §17 ; TRANSACTIONS §5–§13, §18). **Unités fictives uniquement** : aucun wallet, token, chaîne, réseau ni argent réel. Chaque état, reçu et entrée de journal porte la mention « SIMULÉ ».

## Contenu

| Fichier       | Rôle                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `amounts.ts`  | Montants `bigint`, chaînes décimales canoniques, bornes et débordements refusés.                                           |
| `contract.ts` | Contrat immuable (digest canonique), mandat borné, machine à états du contrat.                                             |
| `events.ts`   | `ExchangeEvent` : type d'entrée de G1, validé à l'exécution, sans texte de message conservé.                               |
| `ledger.ts`   | Ledger fictif append-only en partie double, distinct du ledger de ressources `src/ledger`.                                 |
| `rail.ts`     | Adapter de règlement déterministe simulé dans un fichier SQLite séparé (fenêtre d'idempotence, timeouts, fencing).         |
| `service.ts`  | Offre, acceptation, réservation, comptage, clôture, approbation, outbox, worker à bail et fencing, gel, expirations, reçu. |
| `receipt.ts`  | Reçu sans contenu de conversation, statut dû / en cours / réglé fictivement.                                               |

## Points à connaître

- **Une réservation interne n'est pas un escrow.** Elle empêche deux processus de ce service de promettre les mêmes unités fictives ; elle ne protège contre aucun retrait externe (P04 non couverte).
- Échange payable : point de l'agent (`agent_point`) → contribution `human_explicit` du guide du contrat attestée par `channel` → réponse finale substantielle → checkpoint. Streaming, outils, retries, clarifications, brouillons d'assistant, synthèse finale et texte libre ne sont pas payables.
- Les producteurs (`channel`, `agent_runtime`) sont vérifiés par type d'événement, **sans authentification cryptographique** : G3 doit relier le canal de G2 à une source authentifiée avant tout usage réel (P15 non couverte).
- Règlement : intention immuable + outbox dans la même transaction ; rapprochement par `lookup` avant toute nouvelle émission ; absence considérée probante seulement dans la fenêtre de rétention déclarée par l'adapter, sinon gel.
- Une intention `frozen` attend une résolution humaine, non implémentée ici.

Recettes : `test/advice/session/`.
