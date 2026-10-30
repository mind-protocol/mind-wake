# Saisie rapide au clic droit

L'en-tête et la poignée à côté de MIND permettent de déplacer le menu. Les boutons gardent leur comportement normal. Le déplacement ne change pas le point original joint à l'envoi. Un clic extérieur ferme le menu (gauche, droit, molette ou bouton latéral, y compris les clics injectés par un outil d'accessibilité) ; un clic droit extérieur ne le rouvre pas au relâchement du même bouton. Le clic reste transmis à l'application visée.

Fermeture : un clic extérieur ou Échap masque le menu, même s'il n'a jamais reçu le focus. La croix reste disponible pendant l'envoi ; fermer conserve le brouillon et ne révoque pas un message déjà soumis. Une fermeture explicite empêche la réouverture automatique sur erreur. L'observateur clavier ne retient aucune saisie : il reconnaît seulement Échap lorsque le menu est visible, et transmet les événements à l'application.

Implémentation Windows, 30 octobre 2026. Le panneau desktop observe le relâchement du bouton droit sur le bureau interactif et ouvre une petite fenêtre près du pointeur, contenue dans le moniteur visé. À l'ouverture, le worker laisse le menu contextuel prendre sa place (80 à 200 ms), puis relève les rectangles des menus Win32 et des popups de l'application cliquée, y compris les menus modernes Explorer reconnus. MIND se place à droite, à gauche, dessous ou dessus avec un espace de 8 pixels, sans recouvrir les rectangles détectés. Sans place suffisante dans cet écran, le menu MIND reste masqué. Un nouveau clic ou Échap annule une ouverture encore en préparation. Le point original joint à l'envoi reste inchangé. Les menus personnalisés non exposés comme fenêtres popup et ceux apparaissant après ce délai restent une limite de détection.

Les clics restent transmis aux applications et leur menu contextuel garde son comportement normal. Les clics dans la saisie elle-même, dans un menu natif déjà ouvert et les événements injectés ne déclenchent pas le raccourci.

## Parcours

1. Clic droit : ouverture du menu MIND près du point réel, sans capture ni focus forcé. Le menu natif de l’application continue de recevoir le clic. MIND ne modifie aucun menu tiers.
2. **Parler à mon agent** donne explicitement le focus au champ. Entrée envoie, Maj+Entrée ajoute une ligne. Échap ou × masque la fenêtre sans envoyer ; le brouillon reste disponible.
3. **Bumpe** envoie l’invitation Bump partagée, relue depuis `artifacts/prompts/bump.md` avec repli intégré, et une invitation ciblée sur le point du clic droit. Le brouillon Parler reste intact. Les deux modes, la priorité aux agents et le choix final par l’agent principal restent ceux du Bump général.
4. Envoyer ou Bumpe masque le menu MIND avant la capture de **l’écran principal**. JPEG réduit à 1280 pixels sur le grand côté, au plus 1 Mio. Le point physique original est cerclé en rouge ; déplacer la souris vers le bouton ne change pas la cible. Un identifiant natif lie l’envoi au clic original : une cible remplacée est refusée avant capture.
5. Le texte et l’image sont enregistrés dans la file locale. Une erreur restaure le menu sans voler le focus, conserve le brouillon et la clé du réessai. Une capture indisponible, notamment un clic sur un autre écran, refuse l’envoi complet avant inbox. La surface autorisée reste l’écran principal.
6. Codex reçoit l’image dans le tour actif ou au prochain réveil ; Claude la reçoit dans un message multimodal entre deux tours. Les hooks textuels ne consomment pas les images. Un reçu indique l’acceptation du message par le runtime, pas sa compréhension par le modèle.

La sélection **Clic droit — saisie rapide** de l’icône de notification désactive ou réactive l’observation pour la durée de vie du panneau. Elle est activée au lancement. Quitter le panneau supprime le hook ; fermer sa fenêtre principale le laisse actif avec l’icône. Un bureau verrouillé ou protégé n’est pas capturé.

## Contrôles et conservation

Le clic explicite sur Envoyer ou Bumpe autorise cette capture ponctuelle et sa transmission au runtime configuré. Il ne modifie pas l’autorisation de collecte ambiante. Les coordonnées sont du contexte et une invitation à relancer ; ni les pixels ni le cercle ne donnent permission d’exécuter les actions visibles.

La fonction exige un profil natif Codex ou Claude. Le message peut être enregistré pendant Pause ou Force-off : aucun arrêt n’est levé et aucun daemon n’est démarré dans ces états. Pour Parler, sur un profil prêt ou en hibernation, le desktop conserve la demande de réveil existante. Bumpe utilise seulement la file humaine comme le Bump général : il ne démarre pas de daemon arrêté. Claude actif peut réagir à la file ; Codex attend son tour actif ou un prochain réveil, sans `wake_now` direct.

Les images attendent dans la colonne `image_json` de `owner-inbox.sqlite`, hors de l’espace agent. Une attente ou un redémarrage conserve la capture d’origine et son horodatage ; elle n’est jamais présentée comme une nouvelle capture. Le contenu image est retiré de la ligne après accusé de réception du runtime. Cela n’est pas une garantie d’effacement physique SQLite ; les runtimes et fournisseurs peuvent conserver leur propre historique. Le registre `human-messages.jsonl` conserve texte et date de capture, sans pixels. Aucune image n’est écrite dans les notes Markdown de l’agent.

L’identifiant d’envoi reste stable lors d’un nouvel essai après erreur : une réponse déjà enregistrée ne provoque pas une seconde capture ni un second message.

## Code et validation

La capture ponctuelle porte un cercle rouge à la position physique du clic droit initial, mémorisée à l’ouverture de la saisie. Le repère est tracé après réduction (rayon 14 px, trait rouge 3 px avec bordure blanche) et ne suit pas les déplacements ultérieurs de la souris. Un clic hors de l’écran principal capturé est refusé ; la surface capturée reste inchangée. Le repère est une annotation de l’interface, pas un élément de l’écran source. Recompiler et relancer le panneau pour transmettre les coordonnées.

- `desktop/src-tauri/src/quick_input.rs` : hook Windows dédié et positionnement ; le callback ne fait ni capture, ni accès disque, ni appel modèle.
- `desktop/ui/quick-input.*` : saisie, états d’envoi et erreurs.
- `reply --capture-screen --idempotency-key …` : capture ponctuelle, validation et enregistrement.
- `src/communication/owner-content.ts` : blocs multimodaux Codex/Claude ; les pixels ne sont pas sérialisés dans le texte du prompt.

Le hook suit le contrat [LowLevelMouseProc de Microsoft](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelmouseproc) : thread avec boucle de messages et retour immédiat à la chaîne de hooks.

Les tests couvrent la migration de file, la reprise après interruption, les pièces jointes anciennes, les reçus, les erreurs de capture, l’idempotence, le point natif et la conservation de Pause. La recette visuelle Windows doit également vérifier : ouverture sur clic physique sans voler le focus du menu tiers, focus après Parler, bords et DPI des écrans, fermeture, absence du menu MIND dans la capture, activation/désactivation et réception réelle par le modèle. Les tests automatisés et la compilation ne prouvent pas ces observations.

La mise à jour exige le redémarrage du panneau **et du daemon** : un ancien processus de livraison ne connaît pas les pièces jointes. Le daemon annonce cette capacité par un marqueur lié à son identifiant d’exécution. Si un ancien moteur est encore actif, l’envoi est refusé avant capture avec un message demandant son redémarrage : aucun texte ne part sans son image. Le typage, les compilations et les tests déterministes ne remplacent pas la recette visuelle ni un envoi fournisseur réel.
