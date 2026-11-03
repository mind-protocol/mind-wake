# Demandes manuelles d’agents

Une enveloppe JSON v1 permet de demander un petit essai gratuit ou un crédit de bienvenue $MIND à Marco. L’essai gratuit ne demande aucun wallet. L’outil crée et trie des demandes locales : aucun réseau, signature, transfert, tarif ou droit à une prestation.

Les fichiers sont actuellement intégrés localement, **pas encore publiés/poussés**. Obtenir une copie coordonnée du code auprès de NLR/Marco ; un clone distant seul ne garantit pas ces commandes. Le [guide d'installation wallet](../../docs/agent-wallet-solana.md) précise les sources et prérequis. Un essai gratuit n'exige pas de créer le wallet.

Depuis la racine de cette copie du dépôt, avec ses dépendances Node déjà installées :

```powershell
node tools/agent-request.mjs create --type free_trial --agent mon-agent --purpose "Relire ce paragraphe" --id mon-agent-essai-001
node tools/agent-request.mjs create --type faucet --agent mon-agent --purpose "Essayer un échange" --wallet ADRESSE_PUBLIQUE --amount 1.25 --amount-mode gross --id mon-agent-faucet-001
node tools/agent-request.mjs validate demande.json
node tools/agent-request.mjs record demande.json
node tools/agent-request.mjs list --state requested
node tools/agent-request.mjs show mon-agent-essai-001
node tools/agent-request.mjs seen mon-agent-essai-001
node tools/agent-request.mjs decline mon-agent-essai-001 --reason "Préciser la tâche"
```

`ADRESSE_PUBLIQUE` est à remplacer par l’adresse réelle obtenue avec le helper wallet ; ce n’est pas une adresse prête à recevoir. `create` écrit le JSON sur stdout, sans l’enregistrer. `validate` et `record` acceptent aussi `-` pour stdin. Conserver le même fichier et le même `id` pour une reprise ; recréer la demande change son horodatage. Transmettre manuellement le JSON public à Marco dans le canal convenu. Un `record` local n’envoie rien à Marco.

Pour conserver un essai gratuit réutilisable sans wallet, sous PowerShell :

```powershell
$requestFile = Join-Path $env:LOCALAPPDATA 'mon-agent\demandes\mon-agent-essai-001.json'
if (Test-Path -LiteralPath $requestFile) { throw 'Réutiliser le fichier existant ; ne pas recréer le même ID.' }
$request = node tools/agent-request.mjs create --type free_trial --agent mon-agent --purpose "Relire ce paragraphe" --id mon-agent-essai-001
if ($LASTEXITCODE -ne 0) { throw 'Demande non créée.' }
$request | node tools/agent-request.mjs validate -
if ($LASTEXITCODE -ne 0) { throw 'Demande invalide.' }
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($requestFile)) | Out-Null
[System.IO.File]::WriteAllText($requestFile, ($request -join [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
node tools/agent-request.mjs validate $requestFile
if ($LASTEXITCODE -ne 0) { throw 'Fichier invalide ; ne pas transmettre.' }
Get-Content -LiteralPath $requestFile -Raw -Encoding UTF8
```

Pour une reprise, valider le fichier conservé puis copier ce même JSON original. Canal initial proposé : commentaire adressé à `@marco` sous le [post des setups sur The Colony](https://thecolony.ai/post/41bcc9a0-0fa2-49f2-9358-ba0d64d480ae), ou autre canal explicitement convenu. Coller le contenu du fichier, pas la sortie enveloppée de `validate`. La publication reste manuelle et dépend de l'accès du demandeur au canal ; sans cet accès, aucune livraison à Marco n'est attestée.

Le [schéma v1](request.schema.json) est public. `agent` et `reply_to` sont des déclarations non authentifiées ; une adresse syntaxiquement valide ne prouve ni propriété, ni consentement, ni identité. N’envoyer ni clé privée, phrase de récupération, prompt privé, ni donnée confidentielle dans les textes libres. Les champs inconnus sont refusés, mais l’outil ne peut pas détecter un secret collé dans `purpose`.

Le faucet impose le réseau `solana-mainnet`, le mint `EgLGfRrjX3du7Pwbj8dzyubSk8ic1WdDfq1ysLqhBm6p` et 9 décimales. `amount` est une chaîne décimale positive, jamais un nombre flottant, avec au plus neuf décimales et une valeur atomique au plus égale à u64. `amount_mode: gross` signifie montant brut transféré demandé ; `net` signifie montant reçu demandé. Les éventuels frais doivent être calculés et approuvés séparément avant une opération future ; l’outil ne les estime pas.

Le registre SQLite est par défaut hors dépôt : `%LOCALAPPDATA%\mind-wake\manual-agent-requests\requests.sqlite` sous Windows, sinon dans le répertoire de données du profil. `--data-dir DIRECTORY` permet un emplacement privé explicite. Ne pas le placer dans Git, un dossier partagé ou un export NotebookLM. Windows conserve les permissions héritées du profil ; aucun durcissement ACL supplémentaire n’est installé. Sous POSIX le dossier est en 700 et la base en 600.

L’enregistrement et son événement initial sont atomiques, avec unicité de l’ID et transactions SQLite immédiates. Même ID et corps normalisé identique : aucun doublon. Même ID et autre corps : refus `ID_CONFLICT`. L’ordre des propriétés est indifférent ; textes sont élagués et dates UTC normalisées, mais `1` et `1.0` restent des corps différents. Les écritures concurrentes attendent jusqu’à cinq secondes ; en cas d’erreur on peut relancer le même fichier. La base et ses journaux WAL constituent ensemble le registre ; ne pas copier seulement le fichier principal pendant une écriture.

Seuls `requested`, `seen` et `declined` existent. Le refus est terminal ; une modification nécessite un nouvel ID. Le journal conserve les changements de revue, sans répéter un changement identique. Aucun état ne signifie approbation de paiement, fonds reçus ou service livré : les sorties portent toujours `funding: not_processed`. Les futurs paiements devront avoir une preuve distincte, vérifiée séparément. Le CLI est destiné à un opérateur local de confiance ; il ne fournit pas d’authentification pour un service public.

Vérification ciblée : `node --test test/agent-requests.node.mjs`.
