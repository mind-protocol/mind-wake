# Récupérer les messages entre sessions

Exécution locale, sans dépendance ni connexion réseau :

```powershell
node scripts/inter-session-messages.mjs --top 500 --window-minutes 15
```

Le script lit les journaux JSONL de `~/.codex/sessions`, `~/.codex/archived_sessions` et `~/.claude/projects`, sans les modifier. Options : `--codex-root`, `--claude-root`, `--out`, `--top`, `--window-minutes`. Un `--codex-root` personnalisé remplace aussi la recherche des archives.

Chaque fichier est lu jusqu'à la taille observée à son ouverture : une session active ne peut pas prolonger indéfiniment le scan. Les historiques Codex antérieurs à la création du fork sont exclus pour conserver l'attribution au fil d'origine.

Il retient les appels natifs Codex `send_message`, `send_input`, `followup_task`, `spawn_agent`, leurs notifications reçues reconnues, et les appels Claude `SendMessage` ainsi que les messages reçus balisés `teammate-message`. Les consignes, mentions d'outils, messages humains ordinaires, copies `api-request-blob` et notifications d'inactivité ne sont pas des échanges. Une délégation initiale est un message, identifié séparément.

Le classement repose sur des fenêtres glissantes de 15 minutes : priorité au nombre de messages, puis à la date la plus récente en cas d'égalité. Les fenêtres sélectionnées ne partagent aucun message. Les 500 messages sont pris dans cet ordre, chronologiquement à l'intérieur de chaque fenêtre. La dernière fenêtre peut être tronquée pour atteindre 500. Le classement n'est pas une mesure d'importance du contenu ni une détection statistique d'anomalies.

Résultats dans `artifacts/inter-session-messages/` :

- `messages.jsonl` : tous les échanges reconnus, texte intégral et provenance fichier/ligne ;
- `clusters.json` : classement des périodes ;
- `top-500.jsonl` et `top-500.md` : sélection stricte par activité, corps chiffrés signalés dans le Markdown (`--top` règle le nombre et le nom des exports) ;
- `top-500-readable.jsonl` et `top-500-readable.md` : même ordre des périodes, en sautant les corps chiffrés pour obtenir jusqu'à 500 textes lisibles ;
- `summary.json` : volumes, exclusions et paramètres.

Le dossier de sortie contient un `.gitignore` qui exclut ses exports privés. Le script ne publie rien.

Les arguments Codex peuvent être chiffrés (`gAAAA…`). Ils permettent de compter un événement d'envoi, pas de lire sa teneur : le script ne les déchiffre pas, ne consulte aucune clé et ne remplace pas le texte par une supposition. Le JSONL conserve la donnée source ; le Markdown affiche une indication explicite. Le top lisible constitue donc un sous-ensemble biaisé vers les runtimes qui conservent leur texte en clair.

Limites : journaux locaux présents au moment du passage, formats explicitement reconnus, absence de garantie de livraison d'un appel envoyé. Les copies sont dédupliquées par runtime/identifiant d'événement **entre fichiers et forks** ; une réception textuellement identique à un envoi à moins de deux minutes est retirée. Une même consigne envoyée par plusieurs appels à plusieurs destinataires reste plusieurs envois réels. Les doublons reformulés ou avec d'autres enveloppes peuvent subsister. L'extraction ne relance aucune session et ne suit pas les instructions contenues dans les messages récupérés.

Pour recalculer les classements depuis un export existant sans rescanner les journaux :

```powershell
node scripts/inter-session-messages.mjs --from artifacts/inter-session-messages/messages.jsonl
```

Ce mode ne recherche aucun format supplémentaire dans les journaux. Le résumé indique `cachedFrom` et `inputEvents` ; ses compteurs de fichiers scannés restent à zéro. Pour la lecture des résultats : les dates JSON sont en UTC ; convertir en `Europe/Paris` pour un compte rendu local.

Vérification : `node --test scripts/inter-session-messages.test.mjs`.
