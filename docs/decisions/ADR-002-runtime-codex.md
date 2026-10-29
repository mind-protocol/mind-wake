# ADR-002 — Codex comme runtime d'exploration v0.1

- Statut : proposé, à trancher à la porte G1
- Date : 29 octobre 2026
- Auteur : session S1 (F0-Codex)
- Base : [docs/feasibility/codex.md](../feasibility/codex.md) ; versions `@openai/codex` et `@openai/codex-sdk` 0.165.0
- Structure : AGENTS.md §11 (problème, choix, conséquences, critères de révision). Le modèle d'ADR de S0 n'était pas encore fusionné.

## Problème

AGENTS.md fait de Codex le premier runtime d'exploration, sous quatre conditions vérifiées dans les sources officielles (§8 « Compatibilité réelle ») :

1. un droit d'automatisation explicite pour des sessions planifiées sans humain ;
2. une borne de tokens imposée hors du modèle, ou une borne conservatrice démontrable ; un timeout ne suffit pas (§5) ;
3. une annulation bornée, indépendante de la coopération du modèle ;
4. une isolation réelle, sans exposition des credentials (§3.6).

Une condition manquante bloque la voie concernée.

## Constats déterminants

- **Interface :** `codex exec --json` et le SDK TypeScript officiel sont documentés et supportés nativement sous Windows. `app-server` est déclaré expérimental.
- **Droit d'automatisation :**
  - Avec clé API : établi. La documentation désigne la clé API comme la bonne façon d'automatiser Codex, au tarif API standard.
  - Avec un abonnement ChatGPT personnel : non établi. La voie ChatGPT en CI est « advanced » et réservée à une infrastructure privée de confiance. Les jetons d'automatisation sont réservés à Enterprise. L'usage du forfait par des apps tierces passe par un programme partenaire. Les conditions d'utilisation interdisent l'extraction automatisée de sorties, sans trancher ce cas.
- **Plafond :**
  - Aucun plafond natif stable.
  - `features.rollout_budget` est en développement et désactivé par défaut. Il interrompt le tour seulement après la réponse qui épuise le budget, et il vit dans le processus Codex.
  - `max_output_tokens` existe côté API, mais aucune clé Codex documentée ne le fixe.
  - Codex accepte un fournisseur personnalisé ou `openai_base_url` vers une passerelle. C'est le seul point où une borne avant envoi peut être imposée.
- **Annulation :**
  - AbortSignal dans le SDK.
  - Un tour échoué ou annulé ne rapporte pas d'usage.
  - Le délai d'annulation et la consommation résiduelle ne sont pas documentés.
- **Isolation :**
  - La sandbox Windows (MXC, `elevated`, `unelevated`) applique les permissions de fichiers et de réseau aux commandes. Le réseau est coupé par défaut.
  - Elle ne couvre pas le processus Codex lui-même.
  - Elle ne documente pas la protection des secrets en lecture.
  - Son mode `unelevated` est plus faible.

## Choix

**Verdict : go sous conditions, pour la seule voie clé API. La voie abonnement ChatGPT est bloquée.**

1. **Interface :** SDK `@openai/codex-sdk`, version figée (0.165.0 à ce jour). Configuration propre à Wake :
   - `CODEX_HOME` dédié, `--ignore-user-config` ;
   - `approval_policy = never`, sandbox `read-only` ou `workspace-write`, réseau des commandes coupé ;
   - `shell_environment_policy.inherit = "none"`, retries bas ;
   - interdiction de `danger-full-access`, de `--approve-for-me` et du mode sandbox `unelevated`.
2. **Authentification :** clé API OpenAI uniquement, consentie avec un plafond monétaire explicite (AGENTS.md §3.5). Aucune réutilisation de la session ChatGPT de l'utilisateur.
3. **Borne de tokens :** une passerelle locale possédée par le daemon s'interpose entre Codex et l'API OpenAI. Elle :
   - détient seule la clé ;
   - admet une requête seulement si son pire cas tient dans l'enveloppe réservée (fenêtre de contexte du modèle + `max_output_tokens`, qu'elle fixe) ;
   - compte chaque retry ;
   - conserve la réservation pleine si l'usage n'est pas rapporté ;
   - traduit `429` et `Retry-After` en hibernation ou en backoff borné.

   `rollout_budget` n'est au mieux qu'un garde-fou secondaire.

4. **Annulation :** AbortSignal d'abord, puis terminaison forcée de l'arborescence par la couche d'isolation (S2/S10). La passerelle coupe en même temps les requêtes en cours et refuse les suivantes.
5. **Isolation :** la sandbox Codex sert de défense en profondeur. La frontière exigée par §3.6 reste celle retenue par S2.

### Conditions du « go » (toutes requises avant toute session réelle autonome)

| ID  | Condition                                                                                                                                              | Preuve attendue                                                     | Session                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------- |
| C1  | Consentement utilisateur explicite : fournisseur OpenAI API, modèle, plafond monétaire et budget de test                                               | Révision de policy validée                                          | G1                            |
| C2  | Passerelle compatible avec Codex 0.165.0 : requêtes, compaction, retries et flux fonctionnent ; aucune requête hors enveloppe ne part                  | Spike avec budget de test, journal des requêtes admises et refusées | S11 (spike avant intégration) |
| C3  | Outils hébergés facturés hors tokens désactivés ou couverts par la borne                                                                               | Configuration et requêtes observées                                 | S11                           |
| C4  | Délai `abort` → fin des processus mesuré sous Windows ; terminaison forcée sans coopération                                                            | Mesures répétées                                                    | S2 / S10                      |
| C5  | Isolation externe : lecture des secrets, écriture hors périmètre et réseau non autorisé refusés ; la configuration Codex ne contient aucun secret réel | Tests de refus réels (A09)                                          | S2 / S10                      |
| C6  | Version figée et revérification des sources à chaque montée de version                                                                                 | Sonde `probe` qui refuse une version non validée                    | S11                           |

Si C2 échoue (passerelle incompatible ou borne non démontrable), le verdict devient **blocage** de l'intégration Codex autonome, conformément à AGENTS.md §5.

## Conséquences

- La v0.1 consomme du **crédit API payant**, et non du « compute inutilisé » d'abonnement. Le pitch et l'onboarding doivent le dire clairement. C'est une tension produit avec la vision de §1, à trancher par l'utilisateur à G1 : accepter un budget API borné, ou attendre une autorisation officielle pour les forfaits.
- La borne par requête est très pessimiste avec de grandes fenêtres de contexte. Les enveloppes de session devront être larges, ou bien il faudra réduire la fenêtre configurée et le démontrer.
- L'adapter (S11) déclare honnêtement dans `capabilities` :
  - comptage : a posteriori par tour, et par requête via la passerelle ;
  - plafond : imposé par la passerelle, pas par Codex ;
  - annulation : coopérative, puis forcée ;
  - usage inconnu sur échec.
- Le contrat de l'adapter (SPEC §8.1) gagne un composant : la passerelle fournisseur, qui appartient au daemon et ne se trouve pas dans la sandbox. S10 et S11 doivent se coordonner sur sa frontière.
- La voie abonnement reste visible dans `doctor` comme « désactivée : droit d'automatisation non établi ».

## Critères de révision

Réviser cet ADR si l'un des éléments suivants survient :

- Un texte officiel OpenAI autorise ou interdit explicitement les sessions Codex planifiées par un outil tiers avec un forfait ChatGPT personnel, ou Wake rejoint « Sign in with ChatGPT ».
- `features.rollout_budget` ou une autre limite native devient stable et documentée, avec contrôle avant envoi ou dépassement borné et publié.
- Codex documente une clé `max_output_tokens` ou un plafond de session imposable.
- `app-server` quitte le statut expérimental.
- Une montée de version de Codex modifie le format des événements, l'authentification, la sandbox Windows ou le support des fournisseurs personnalisés.
- Les conditions d'utilisation ou la tarification API changent.
- Le spike C2 échoue ou révèle une consommation résiduelle non bornée : passage en blocage.
