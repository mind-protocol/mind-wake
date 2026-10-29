# services/advice/demo — démo de conseil guest distant (SIMULÉE, piste G3)

Parcours SPEC §17 de bout en bout, **entièrement simulé et local** : aucun argent, wallet, token, réseau public, bot ni publication. Relie le canal de G2 (`../conversation/`) au service de séances de G1 (`../session/`).

```
npm run demo:advice                  # 5 échanges, clôture normale par l'agent
npm run demo:advice -- --stop-after 3  # arrêt anticipé du guide après 3 échanges
```

## Parcours

« Faisons une session de conseil MIND » → matching factice (`matching.ts`, catalogue `catalog.ts`) → contrat G1 → réservation fictive → réveil de l'agent factice par son serveur d'origine simulé (`agent-host.ts`) → ouverture de la rencontre par l'adaptateur MCP du guide → première question → au plus 5 échanges → clôture normale ou anticipée → règlement simulé des seuls échanges acquis → reçu SIMULÉ sans contenu.

Trois rôles, en processus séparés sur la même machine :

| Rôle                     | Processus                                                          |
| ------------------------ | ------------------------------------------------------------------ |
| Service MIND simulé      | `scenario.ts` : séances G1, passerelle G2 en processus, adaptateur |
| Guide                    | client MCP + `conversation/mcp-server.ts` (processus séparé)       |
| Agent guest « chez lui » | `conversation/guest/fake-guest.ts`, dossier privé `agent-*/home`   |

Le prompt, la mémoire et le credential du guest restent dans son dossier : ni le service ni le guide ne les lisent.

## Adaptateur G2 → G1 (`bridge.ts`)

`SessionLedgerBridge` implémente le port `ExchangeEventSink` de G2 et ne compte rien lui-même :

| Fait de conversation (G2)                                      | `ExchangeEvent` (G1)                                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `encounter_opened`                                             | `activate` du contrat                                                                         |
| 1er message d'agent, puis réponse portant la question suivante | `agent_point` (ouvert après la sauvegarde précédente)                                         |
| contribution humaine `human_verbatim`                          | `human_contribution` `human_explicit`                                                         |
| contribution `human_approved_draft`                            | `human_contribution` `assistant_draft` (non payable)                                          |
| message d'agent citant une contribution                        | `agent_reply` (substantiel si ≥ 40 caractères)                                                |
| message d'agent sans citation, échange ouvert / sinon          | `agent_clarification` / `final_summary`                                                       |
| attestation de sauvegarde du runtime de l'agent                | `agent_checkpoint`                                                                            |
| `encounter_closed` / `revoked` / `expired`                     | `close` (`guide_stop`, `agent_stop`, `limit_reached`, `channel_change`, `inactivity_expired`) |

Les identifiants G2 (`msg_…`) deviennent des références G1 en remplaçant `_` par `.` (injectif sur l'alphabet base64url). Une erreur d'infrastructure remonte à la passerelle, qui ne stocke alors rien ; un refus métier de G1 est seulement consigné.

## Modification minimale de G2

`conversation/guest/fake-guest.ts` : variable facultative `GUEST_CHECKPOINTS`. Après avoir mémorisé une réponse, l'agent factice ajoute `{ encounterId, inReplyTo, checkpointRef }` (référence opaque, sans contenu) à ce fichier, et réatteste ses sauvegardes au redémarrage. Sans la variable, son comportement est inchangé. Aucune modification de G1.

## Recettes

`test/advice/demo/` : `bridge.test.ts` (traduction, H03, H04 en processus unique) et `journey.process.test.ts` (H01–H06 de bout en bout, arrêt à 3 sur 5, duplicata, crash du guest avec et sans reprise, message hostile demandant de valider le paiement).

## Limites

- Producteurs non authentifiés cryptographiquement (P15) : les messages d'agent relayés par la passerelle sont attestés `agent_runtime` parce que la passerelle a authentifié la clé du guest ; la sauvegarde est un fichier local de l'agent.
- L'auteur humain est le guide du contrat parce que la configuration simulée de la passerelle n'admet qu'un guide ; aucun lien vérifiable entre `guideRef` de G2 et principal G1.
- « Substantiel » est une borne de taille, pas un jugement de contenu ; les règles structurelles sur le texte restent à publier par le canal.
- Une clarification humaine ou un désaccord de l'agent sont comptés selon la structure, jamais selon le contenu ; le guest factice ne conteste pas réellement.
- Pas d'outil MCP « démarrer une séance » : l'orchestrateur joue la session du guide (phrase → matching → invitation → `open_encounter`).
- Les pseudonymes et identifiants de message changent à chaque exécution ; le reste du scénario est déterministe.
- Réservation interne ≠ escrow ; pas de résolution humaine des unités annulées après la grâce.
