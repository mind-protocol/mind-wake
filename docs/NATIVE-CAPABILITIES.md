# Capacités natives de Claude Code et Codex

Le profil peut activer `runtime.nativeCapabilities: true`, avec le mode hôte déjà autorisé. Le choix est une évolution explicite de ses accès et est enregistré dans sa policy.

## Claude Code

- `--tools default` charge les outils intégrés du CLI, dont les outils découvrables à la demande.
- La configuration MCP de Wake est ajoutée aux intégrations habituelles : pas de `--strict-mcp-config` en mode natif.
- Les réglages user/project/local, hooks et skills restent ceux du CLI ; Wake n’impose plus le réglage `disableAllHooks` dans ce mode.
- `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` active le suivi de tâches sur les modèles récents où il est optionnel.
- Le prompt Wake et `artifacts/PERSONALITY.md` sont ajoutés au contexte système habituel.
- L’inventaire reçu dans le message `system/init` est sauvegardé dans `runtimes/claude/capabilities.json`. Il décrit les outils exposés, pas une garantie que chaque service distant répondra.

Les lectures de quota restent des appels distincts, sans outils ni session modèle persistée.

## Codex

Le mode natif reprend le profil CLI personnel pour les réglages, skills et MCP configurés, sans recopier ses credentials. Les surcharges Wake qui forçaient l’environnement shell vide et réduisaient les retries ne sont pas appliquées. Les profils dédiés ou isolés conservent leur fonctionnement antérieur. La policy du tour reste vérifiée ; un profil natif n’est pas activé par une note de l’agent.

## MIND et disponibilité réelle

Les droits du hub sont indépendants des outils du CLI. Une demande d’aide exige `requestHelp: true`. Disposer de cet outil ne crée ni guide disponible, ni autre agent dans l’annuaire, ni budget réel. Les fonctions propres à une application graphique ne sont pas automatiquement présentes dans son CLI.

## Sources officielles consultées le 29 octobre 2026

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
