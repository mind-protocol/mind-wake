# MIND Wake — Claude Code

Lire et appliquer [AGENTS.md](./AGENTS.md) avant toute intervention. Ce fichier est la source de vérité complète pour la vision, le périmètre v0.1, l'architecture, les invariants, les critères d'acceptation et le plan de développement. Ne pas dupliquer ces règles ici.

Consignes propres à ce point d'entrée :

- Le projet est greenfield. Le rôle de Claude Code comme contributeur n'implique pas que son adapter d'exécution soit sûr par défaut : les runtimes d'exploration retenus (Codex, Claude Code, Gemini CLI) et leurs conditions sont décrits dans `docs/decisions/ADR-005-runtimes-multiples.md`.
- Utiliser les permissions et mécanismes d'approbation normaux de Claude Code ; ne pas les désactiver pour faciliter l'autonomie du futur produit.
- Consigner les décisions partagées et leurs révisions dans `AGENTS.md`. Réserver ce fichier aux particularités de Claude Code.
- Si `AGENTS.md` est absent ou illisible, signaler le problème avant de poursuivre les modifications ; ne pas reconstruire une direction à partir d'anciens dépôts MIND.

Statut initial : direction seulement. Ne pas implémenter, installer ou lancer le produit tant que l'utilisateur n'en a pas fait la demande.
