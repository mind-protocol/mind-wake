# services/advice/conversation — canal de conversation guest (SIMULÉ)

Session G2 du plan (`docs/PLAN.md`, « Chemin vers une démo de conseil distant »). Démonstration **entièrement simulée et locale** du canal SPEC §15 : aucun argent, wallet, réseau public, bot ou publication. Ne compte pas les échanges et ne règle rien : c'est le rôle de G1 (`services/advice/session/`).

## Architecture

```
guide humain ↔ assistant + skill advice-mediator ↔ mcp-server.ts (stdio, 1 processus par client)
                                                        │ pipe nommé local
                                                  gateway-main.ts (autorité, 1 processus)
                                                        │ pipe nommé local
                                                  guest/fake-guest.ts (« chez lui », 1 processus)
```

- `service.ts` : autorité de conversation. Rencontres, capacités (empreintes seulement), pseudonymes par rencontre, idempotence, bornes, expiration, révocation, conservation. Toute autorisation est faite côté serveur à partir du principal authentifié **et** de la capacité.
- `protocol.ts` : protocole filaire validé par zod. Opérations nommées : `hello`, `open_encounter`, `send`, `receive`, `close`, `status`, `revoke` et `audit` (opérateur). Rien d'autre : pas de fichier, d'exécution, de sampling, de délégation d'outil, de paiement.
- `gateway.ts`, `gateway-main.ts` : transport sur pipe nommé Windows ou socket Unix (`framing.ts` refuse toute autre adresse), une ligne JSON bornée par message, requêtes simultanées bornées par connexion.
- `mcp-server.ts` : adaptateur MCP côté guide (`open_encounter`, `send_contribution`, `receive_messages`, `request_close`, `get_status`). Garde les capacités dans son processus ; aucune sortie d'outil ne les contient. Marque chaque message par sa provenance et sa confiance.
- `guest/fake-guest.ts` : agent factice déterministe. Prompt, mémoire, credential et outil privés restent dans son dossier `GUEST_HOME` ; seules les réponses composées traversent.
- `events.ts` : port `ExchangeEventSink` vers G1. Événements `encounter_opened`, `human_contribution_accepted`, `agent_message_accepted`, `encounter_closed|revoked|expired`, identifiants déterministes, sans texte ni identité privée. Émis **avant** l'écriture de l'état : un échec d'émission ne laisse rien et le retry est sûr.
- `guard.ts` : refus explicite des secrets reconnaissables et chemins privés (réutilise `src/journal/redact.ts`) et des identifiants privés des parties.

## Dépendances ajoutées

Vérifiées le 29 octobre 2026 dans le dépôt officiel `modelcontextprotocol/typescript-sdk` : la v2 (paquets séparés serveur/client, stable depuis le 27 juillet 2026) est la ligne recommandée ; la v1 `@modelcontextprotocol/sdk` ne reçoit plus que des correctifs.

| Paquet                         | Version figée | Usage                                                        |
| ------------------------------ | ------------- | ------------------------------------------------------------ |
| `@modelcontextprotocol/server` | 2.4.0         | `McpServer`, `StdioServerTransport`                          |
| `@modelcontextprotocol/client` | 2.4.0         | client MCP des tests (rôle de l'assistant du guide)          |
| `zod`                          | 4.6.7         | schémas d'outils et du protocole (dépendance de pair du SDK) |

## Exécution

Ces modules ne sont pas inclus dans `npm run build` (qui ne compile que `src/`). Les tests les lancent en processus séparés avec le type stripping natif de Node et les hooks `test/fixtures/store-ledger/ts-hooks.ts`. Tests : `test/advice/conversation/`.

## Limites connues

- État en mémoire de la passerelle : un redémarrage de la passerelle perd les rencontres (le guest, lui, reprend depuis sa mémoire après son propre redémarrage).
- Le pipe nommé n'a pas d'ACL dédiée : un autre processus local peut s'y connecter, mais doit présenter une clé de liaison valide puis une capacité liée à son principal.
- `authorship` est déclaré par l'adaptateur du guide : la provenance humaine est structurelle, pas une preuve d'attention humaine (SPEC §17.3).
- Les événements ne portent pas le texte : si G1 a besoin de règles structurelles sur le contenu (salutations, vide), il faudra les appliquer ici et publier le verdict, plutôt que transmettre le texte.
- Corrélation résiduelle : la passerelle voit l'ensemble des métadonnées (horaires, tailles, pseudonymes) et la configuration simulée associe identités privées et clés.
