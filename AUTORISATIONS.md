# Autorisations de mon agent

Les choix sont désormais conservés dans [AUTORISATIONS.json](AUTORISATIONS.json), seule source de référence.

Dans MIND Wake, ouvrir **Autorisations** dans le menu de gauche. Cet écran lit et enregistre `workspace/AUTORISATIONS.json` du profil actif. Si le fichier est absent, **Importer un JSON** permet de reprendre les choix préparés ici, puis **Enregistrer** les applique à cet agent. Le bouton **Recharger les choix** relit les corrections faites ailleurs. Une modification concurrente bloque l’enregistrement. Cette vue native nécessite une nouvelle compilation du panneau et son redémarrage.

Pour charger et enregistrer directement ce JSON depuis une page locale : `node scripts/authorizations-page.mjs --port 43821`, puis ouvrir `http://127.0.0.1:43821`. Le serveur écoute uniquement sur la machine et ne permet de modifier que le fichier sélectionné. `--file <chemin>` sélectionne un autre JSON, par exemple celui de l’espace live.

Contrôle du contenu affiché : `node scripts/check-authorizations-page.mjs --url http://127.0.0.1:43821`. Le script compare chaque action, décision et périmètre au JSON, vérifie la recherche et la largeur mobile, puis teste l’enregistrement et les conflits sur une copie isolée. Rapport et captures sont écrits dans `.local/authorization-page-check/`. Le script utilise Playwright installé dans le runtime Codex ; `--playwright <chemin-vers-index.mjs>` permet d’en choisir une autre installation. Sans `--url`, il démarre lui-même une page de test. Il contrôle la page HTML rendue dans Edge, pas une WebView native de MIND Wake.

Ouvrir [AUTORISATIONS.html](AUTORISATIONS.html), cliquer sur **Ouvrir le JSON**, sélectionner le fichier, puis modifier les décisions et leurs périmètres. **Enregistrer** modifie le fichier sélectionné dans un navigateur compatible (Chrome ou Edge). Sinon, **Exporter une copie** puis remplacer le JSON original. Une copie téléchargée seule ne modifie pas les choix de Wake.

- ✅ Autorisé en autonomie (`authorized`)
- 🌟 Encouragé (`encouraged`)
- ⚠️ Découragé (`discouraged`)
- ⛔ Interdit (`forbidden`)

Les 20 décisions, leurs périmètres et l’exemple Telegram ont été repris dans le JSON. Les pistes positives alimentent le tirage de `unsure_what_to_do` ; les autres sont renvoyées comme restrictions.

Pour un profil installé, modifier son fichier `workspace/AUTORISATIONS.json`. Le fichier de ce dépôt reste personnel et n’est pas automatiquement copié dans les autres espaces. Le MCP relit le JSON à chaque appel ; après cette mise à jour du code, un serveur MCP déjà lancé doit être redémarré.
