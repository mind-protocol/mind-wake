# Agents livrés avec Wake

Ce corpus conserve les fichiers existants **tels quels**, sur demande du 17 novembre 2026 : Marco, le pattern holder, le coach général et le coach des coachs. Il ne comprend pas les coachs spécialisés Colony ou Telegram ni leurs fiches. Le manifeste `manifest.json` recense les fichiers ; chaque entrée indique sa provenance, sa destination et son SHA-256. Les fins de ligne originales sont conservées dans Git.

Les sections des holders et `PERSONALITY.md` sont des copies exactes du workspace source. Le document de fonctionnement de Marco est conservé dans `marco/AGENTS.md`. Le coach général reprend `prompts/coach/system.md` et son prompt complet utilisé par le runtime. Les rôles système sans surcharge locale sont exportés depuis les constantes du moteur compilé, sans réécriture. `identity.json` est le seul fichier d'identité ajouté : il nomme le nouvel agent **Élan**, indépendamment des dialogues originaux.

Le 20 novembre 2026, le corpus est étendu à **Critique, Mindset et Cockpit**, avec leurs sections et la source des leçons Soda, ainsi qu’au **Réveilleur**. Ces copies conservent la distinction entre dialogues imaginés, observations et hypothèses. Les sauvegardes de rédaction ne sont pas livrées. Le Réveilleur lit les échanges du fil et sélectionne les holders pertinents ; les trois nouveaux profils portent aussi `wakeOnPrincipalOutput: true`, pour recevoir les réponses finales complètes du principal via le runtime Claude ou Codex. Les mentions permettent également de les solliciter directement.

## Installation et personnalisation

Sur une installation neuve, le setup affecte automatiquement Élan, le pattern holder général, Critique, Mindset et Cockpit au fil principal (room 1), puis le coach général et le coach des coachs à la room 2 « Coachs ». Le coach des coachs conserve son fonctionnement de holder et écoute uniquement cette room lorsqu'elle est active. Cette affectation ne démarre aucun worker : activer la room 2 et le service pattern holders pour leur travail commun. Une installation existante, une affectation personnalisée ou une affectation supprimée après installation sont conservées.

`npm run setup -- --apply` copie le corpus aux destinations du manifeste dans le workspace actif. Les lecteurs existants chargent les rôles principaux et coach sous `artifacts/prompts/system/`, la personnalité sous `artifacts/PERSONALITY.md` et les holders sous `artifacts/pattern-holders/`. Le nom initial est modifiable dans `artifacts/agent-identity.json` ; le runtime précise séparément que les scènes historiques ne sont pas la biographie du nouvel agent ni des autorisations de son humain.

Le document `marco/AGENTS.md`, qui contient des chemins et procédures de l'installation d'origine, est livré comme référence sous `artifacts/default-agents/marco/AGENTS.md`, pas comme instruction automatique à la racine. Les liens historiques vers des projets, skills ou registres extérieurs au corpus restent tels quels et peuvent ne pas être disponibles sur une nouvelle installation. Aucun compte, secret, historique de conversation, registre de contacts ou fichier d'autorisations n'est importé par ce mécanisme.

La copie ne remplace aucun fichier existant. Une personnalité déjà présente garde son identité. Le marqueur `.mind-wake-default-agents.json` empêche une relance du setup de recréer les fichiers volontairement supprimés. Un `git pull` met à jour le corpus du dépôt ; il ne remplace pas les prompts personnels déjà installés. Pour une installation existante sans marqueur, relancer le setup ajoute les fichiers absents.

La livraison des prompts ne démarre aucun agent. Les contrôles d'activation, de fournisseur, Pause et Force-off restent ceux de Wake. Le coach se règle dans les contrôles Coach ; les holders utilisent actuellement le service pattern holders et son runtime Claude, activable par `mind-wake pattern-holders on`. Livrer leurs prompts ne configure pas un abonnement Claude.

## Provenance et renouvellement

Le script `scripts/snapshot-default-agents.mjs <workspace-source-absolu>` produit un instantané depuis les fichiers et les exports compilés. Il refuse de remplacer un manifeste existant : une nouvelle capture doit être revue comme une nouvelle version. Les fichiers de ce dossier peuvent être consultés directement après un clone, sans installer Wake.
