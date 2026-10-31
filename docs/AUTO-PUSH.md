# Push automatique après commit (option par dépôt)

Activation explicite, depuis une copie durable des scripts :

```powershell
node scripts/setup-auto-push.mjs --repo C:/chemin/du/depot
node scripts/setup-auto-push.mjs --repo C:/chemin/du/depot --disable
```

L'activation écrit uniquement le `post-commit` du dépôt choisi, sans modifier la
configuration Git. Le hook référence les chemins absolus de Node, du helper et du
checkout. Conserver ces fichiers à leur emplacement ; après déplacement, désactiver
puis réactiver. Les autres worktrees liés ignorent ce hook, et leur activation est
refusée tant que le hook partagé appartient au premier checkout.

Chaque commit terminé pousse son SHA exact vers l'unique branche upstream déjà
configurée (`branch.<branche>.remote` et `.merge`). Le nom de la branche distante
peut différer du nom local. Aucun remote n'est créé. Le push utilise la destination
push configurée du remote ; plusieurs destinations push sont refusées. HEAD détachée,
upstream absent/non récupéré et upstream local (`.`) sont ignorés avec un message.
L'opération est synchrone : le terminal peut attendre jusqu'au délai du push
(45 secondes, plus arrêt de processus). Un verrou exclusif évite les pushes
simultanés ; après interruption brutale, examiner le verrou signalé et pousser
manuellement avant de retirer ce verrou si aucun push ne tourne.

Le push ne force jamais, ne réécrit aucun commit, n'envoie ni tags supplémentaires
ni autres branches, et conserve le hook `pre-push`. Un échec réseau/authentification,
un rejet distant ou un délai dépassé laisse le commit local réussi. Le message
invite à vérifier puis pousser manuellement ; il n'y a ni retry automatique ni
rebase. Git confirme lui-même le commit avant d'exécuter `post-commit`.

L'authentification réutilise les mécanismes Git existants : prompts terminal/askpass
et interaction Git Credential Manager désactivés, SSH en BatchMode, entrée standard
fermée. Aucun jeton ni mot de passe n'est stocké par ces scripts. Un helper de
credentials tiers arbitraire peut avoir son propre comportement ; le délai borne
son attente. Le mode SSH automatique utilise `ssh` et ses réglages BatchMode ; une
configuration imposant un autre client SSH peut nécessiter le push manuel.

Un `post-commit` existant ou un `core.hooksPath` configuré fait refuser l'activation,
sans remplacement ni chaînage implicite. La désactivation supprime seulement le hook
marqué de ce checkout si son contenu généré est strictement intact. Un ajout humain,
un lien symbolique ou un fichier ambigu est conservé et signalé. Les autres hooks
et la configuration restent intacts. La sélection du dépôt est explicite, aucune
activation globale.

Vérification autonome, sans dépendances npm, réseau ni modification du dépôt appelant :

```powershell
node --test scripts/test-auto-push.mjs
```

Les essais créent et détruisent uniquement leurs dépôts temporaires et remotes bare.
Ils vérifient les refs distantes après de vrais commits et refus Git, ainsi que la
préservation des hooks et l'environnement non interactif. Les fournisseurs distants
et leurs écrans de connexion ne sont pas testés par ces essais locaux.
