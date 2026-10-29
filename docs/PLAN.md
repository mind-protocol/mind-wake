# MIND Wake — plan d'implémentation v0.1 en sessions parallèles

Date : 29 octobre 2026. Ce plan découpe les étapes F0–F5 de [SPEC.md §11](../SPEC.md) en sessions de travail indépendantes. [AGENTS.md](../AGENTS.md) reste la source de vérité ; en cas de conflit, il prévaut. Les dossiers et commandes cités ici sont à créer, pas existants.

## Statut de développement

**Spécification et socle technique en cours ; aucun service public opérationnel.** Fusionnés dans `main` : socle et contrats (S0), faisabilité Codex et isolation (S1, S2, ADR proposés sous conditions), policy engine (S4) et journal + CLI de consultation (S5), testés unitairement. En cours : S3 (SQLite + ledger). Rien n'est câblé de bout en bout : la CLI travaille en mémoire, aucune session d'exploration, réelle ou simulée, ne peut être lancée. Aucun paiement, wallet, canal de messagerie ni service distant n'existe. La voie abonnement est retenue comme expérimentale (ADR-004) et reste bloquée tant qu'un dépassement borné n'est pas mesuré.

## Principes du découpage

- **Contrats d'abord.** S0 fige les types partagés (policy, adapter, événements, états, unités de budget) et l'arborescence. Ensuite chaque session possède ses dossiers et ne touche pas ceux des autres.
- **Faisabilité en parallèle du noyau.** Le noyau (F1) ne dépend pas de Codex. Rien de réel (Codex, sandbox) n'est intégré avant la porte G1.
- **Une session = une branche / PR.** Seule S0 modifie `package.json` et la configuration ; les autres déclarent leurs dépendances dans leur PR, fusionnées une par une.

## Arborescence cible (posée par S0)

```
src/contracts/   types partagés, enums d'état, schémas versionnés
src/store/       SQLite, migrations           src/ledger/      budgets, réservations
src/policy/      révisions, consentements     src/journal/     événements, expurgation
src/cli/         commandes mind-wake          src/scheduler/   réveils, fenêtres, backoff
src/runner/      sessions, pause, kill        src/checkpoint/  mémoire, artefacts, confinement
src/adapters/{fake,codex}/                    src/sandbox/     isolation Windows
docs/feasibility/  docs/decisions/  test/acceptance/  spikes/
```

## Vague 0 — Socle et faisabilité (parallèle)

| Session | Objet | Livrable |
|---|---|---|
| **S0 Socle** | Versions Node/TS vérifiées, lib SQLite (`node:sqlite` vs `better-sqlite3`), vitest/lint, arborescence, `src/contracts/*`, modèle d'ADR | Projet qui compile, contrats typés, ADR-001 stack |
| **S1 F0-Codex** | Sources officielles : modes d'exécution, droits d'automatisation (abonnement vs API), comptage/plafonnement des tokens, annulation, limitations | `docs/feasibility/codex.md` + ADR, verdict go / no-go / bloqué |
| **S2 F0-Isolation** | AppContainer, Job Objects, jetons restreints, WFP, Windows Sandbox, WSL2/conteneur ; prototype de tests de refus | `docs/feasibility/isolation-windows.md`, prototype dans `spikes/`, délais mesurés |

**G0** : validation humaine de la stack (ADR-001).

## Vague 1 — Noyau F1 (parallèle, après S0)

| Session | Objet | Preuve |
|---|---|---|
| **S3 Store + Ledger** | Schéma, migrations, FK ; périodes explicites, réservation atomique, rapprochement idempotent, incertitude conservée, périodes chevauchantes | Tests de crash, concurrence, changement d'horloge |
| **S4 Policy engine** | Révisions immuables, consentement local, refus par défaut, limite absente → activation interdite, restriction immédiate / élargissement sur autorisation, décision + motif | Matrice de refus |
| **S5 Journal + CLI** | Journal séquencé, expurgation, rétention ; `doctor`, `init`, `status`, `journal`, `policy show` ; sortie humaine + JSON versionné | Aucun secret dans les logs |

## Vague 2 — Cycle de vie F2 avec adapter factice (parallèle)

| Session | Objet |
|---|---|
| **S6 Scheduler** | 8 états journalisés, verrou d'instance, fenêtres IANA/DST, réveil UTC persisté, pas de rattrapage après veille, backoff borné, interface de priorité utilisateur |
| **S7 Runner + contrôles** | Adapter factice « SIMULÉ », lancement sur réservation, pause/resume/stop (kill switch persistant), réconciliation des orphelines, terminaison de l'arborescence (mécanisme S2) |
| **S8 Checkpoints + mémoire** | Contrat versionné, validation, confinement liens/jonctions, écriture atomique puis référence SQLite, détection d'orphelins, chargement borné |
| **S9 Export / purge / uninstall** | Export cohérent expurgé, plafonds de stockage, purge, squelette `uninstall` (A12) |

**G1 (décision clé)** : lecture des matrices S1/S2 → go / pivot / blocage documenté ; budget de test réel (fournisseur + plafond) ; délais cibles de priorité et d'arrêt.

## Vague 3 — Intégration réelle F3 (après G1)

| Session | Objet | Dépend de |
|---|---|---|
| **S10 Sandbox** | Isolation de production retenue, transport fournisseur séparé, credentials non exposés | S2, S7 |
| **S11 Adapter Codex** | `probe`/`capabilities`/`start`/`events`/`cancel`/`reconcile`, borne démontrable sinon blocage, backoff | S1, contrat S10 |
| **S12 Banc de recette** | Harnais A04–A11 : fautes, crashs, concurrence, texte hostile, évasions, latences ; factice puis réel | Vague 2 |

## Vague 4 — Expérience et adoption (parallèle)

| Session | Objet |
|---|---|
| **S13 Exploration + démo** | Contrat de proposition, choix autonome, condensation avec provenance, bilan mesure/estimation/simulation, démo deux sessions + priorité + kill switch (A02, A03) |
| **S14 Skill + install.md** | Skill Codex, `install.md` (anglais), paquet versionné vérifiable, diagnostic, retrait. Pas de publication (A01 local) |

**G2** : validation de la démo. **G3** : publication uniquement sur demande explicite.

## Vague 5 — Validation v0.1

**S15** : A01–A12 sur un Windows propre au projet ; rapport environnement, version, policy, latences, consommation, défauts connus.

## Chemin vers une démo de conseil distant (F7 simulé)

Les documents de direction décrivent désormais deux parcours distincts : **Wake local** (exploration de son propre agent, vagues 0 à 5 ci-dessus) et **conseil guest distant** (SPEC.md §14–18, TRANSACTIONS.md) : l'agent reste exécuté chez lui, converse avec un guide humain via un canal MCP, et rémunère ce guide selon les échanges accomplis. La CLI locale `mind-wake` n'est pas l'interface de ce second parcours ; aucun guest ne tourne sur le PC du guide.

Une démo **entièrement simulée** de ce parcours ne dépend ni de Codex, ni de l'isolation réelle, ni d'un wallet. Elle peut donc avancer en parallèle de la vague 2, dans des dossiers séparés (`services/advice/`, `skills/advice-mediator/`, `test/advice/`), avec les contrats de S0 comme socle commun pour les identifiants et la journalisation :

| Session | Objet | Recettes visées |
|---|---|---|
| **G1 Service de séances simulé** | Contrat immuable de séance, machine à états (`offered` → `settled`, sorties `cancelled`/`expired`/`disputed`), comptage d'échanges (une contribution humaine + une réponse de l'agent ; messages techniques non payables), mandat borné, ledger **fictif** distinct du ledger de ressources, adapter de règlement déterministe marqué « SIMULÉ », idempotence et reprise après crash | T04, T05 et P03, P05–P09, P13, P19, P20 en fonds fictifs |
| **G2 Canal de conversation guest** | Serveur MCP de conversation (opérations nommées seulement), skill de médiation côté guide, agent guest factice dans un processus séparé ; minimisation : ni mémoire, ni credential, ni route réseau du guest exposés | T01–T03, T06, G01–G05 (section 15.5) |
| **G3 Démo une phrase** | « Faisons une session de conseil MIND » → matching factice, réservation fictive, cinq échanges maximum, arrêt anticipé, reçu marqué simulé | H01–H06 (section 17.8) |

Cette piste n'autorise aucun argent réel, réseau public, bot Telegram/WhatsApp, wallet ou publication : chacun reste soumis aux portes de TRANSACTIONS.md §19 et à une autorisation distincte. Le choix de lancer G1–G3 maintenant, après la v0.1 locale, ou d'en changer l'ordre **reste à l'utilisateur** ; ce plan n'en présume pas.

## Chemin critique

```
S0 ─┬─ S3 ─┐
    ├─ S4 ─┼─ S6, S7, S8, S9 ─┐
    └─ S5 ─┘                  ├─ G1 ─ S10 ∥ S11 ∥ S12 ─ S13 ∥ S14 ─ S15
S1 ──────────────────────────┤
S2 ──────────────────────────┘
```

Risque majeur : G1. Si Codex n'offre ni droit d'automatisation ni plafond imposable, AGENTS.md impose de bloquer cette voie.
