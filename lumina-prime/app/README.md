# MIND · Lumina — app compagnon

Prototype mobile Expo / React Native / TypeScript, avec un export web pour l’inspection sur Windows. Il propose un radar explicable, des profils, des brouillons de soutien éditables, un suivi des rounds et une vue de solde/reçus.

## Lancer

Prérequis : Node compatible avec Expo SDK 58 et npm. Depuis ce dossier :

```powershell
npm ci
npm run web
```

Ou, pour servir un export sans Metro :

```powershell
npm run build:web
npm run preview
```

La cible web utilise `http://localhost:3230`. Les routes sont gérées par Expo Router. `npm run android` / `npm run ios` ouvrent les parcours de développement Expo ; aucune installation native Android/iOS n’est attestée par un build web. Utiliser un client de développement compatible avec SDK 58. Aucun build cloud payant n’a été lancé.

## Ce qui fonctionne

- Navigation Radar, Soutiens, Activité, Mon espace et profils détaillés.
- Recherche et filtres, signaux datés et provenance.
- Préparation en un clic d’un brouillon ; montant exact à 9 décimales, texte éditable, contrôle de cohérence montant/destinataire.
- Copie du brouillon et ouverture du compositeur X à la demande explicite de l’utilisateur. Ce n’est ni une publication confirmée, ni un paiement.
- Brouillons de la session, conservés dans la mémoire de l’app jusqu’à son rechargement.
- Démonstration explicitement étiquetée, séparée du mode réel ; erreurs de lecture, chargement et solde inconnu distincts de zéro.

## Données et connexion

Le mode Démo démarre sur les fixtures de `src/data/demo.ts`. Alice, Noé, Sora et Maé et leurs chiffres sont **fictifs**. Les reçus et primes de démonstration sont des exemples, jamais des transactions de la ville. Aucun wallet, token ou secret n’est chargé par ce prototype.

Le mode Réel utilise une lecture GET de `EXPO_PUBLIC_MIND_API_URL`. Sans cette URL ou en cas d’erreur, les données restent vides et le solde reste inconnu ; il n’y a aucun repli vers les fixtures. Cette variable est publique : n’y mettre aucune clé ou credential. Exemple de configuration locale dans `.env.local` :

```text
EXPO_PUBLIC_MIND_API_URL=http://localhost:PORT/api/companion
```

Le service attendu retourne le type `Snapshot` de `src/data/types.ts` avec `schemaVersion: 1`, `mode: "live"`, `network: "solana-devnet"`, date de lecture, username, solde décimal ou `null`, profils/signaux sourcés, positions et reçus. Les données sont validées avant affichage. Le backend doit vérifier les preuves et les montants du contrat ; l’app n’ajoute aucune adresse de wallet à ses vues. Elle ne constitue pas une vérification cryptographique indépendante du service de données.

## Ce qui reste à raccorder

- Le service de lecture du registre commun et de sa réserve. Le prototype de contrat existant n’est pas présenté comme déployé.
- Authentification du propriétaire, signature explicitement pilotée par l’utilisateur, dépôt, paiement et retrait réellement confirmés. Aucun agent payeur/signataire requis ou exécutant des paiements dans la V1.
- Connexion OAuth X, observation des commandes, publication autorisée et reçus de publication.
- Barèmes et événements des trois primes. Les montants illustratifs ne sont pas validés ; aucun round payant n’est ouvert.
- Décision de grammaire : un don/paiement direct et une mise de soutien doivent être distingués. Le compositeur affiche aujourd’hui « don / paiement direct » et bloque toute prétention d’exécution ; la mise 24 h reste à définir.
- Persistance des brouillons, notifications, partage de capture et OCR. Pas de traitement OCR dans cette version.

La V1 est pilotée par l’utilisateur : radar, préparation de posts, suivi et décisions explicites dans l’app ou un canal qu’il autorise. Un connecteur agent/MCP pourra être étudié ensuite ; il ne fait pas partie du paiement V1.

## Vérifier

```powershell
npm run typecheck
npm run lint
npm test
npm run build:web
```

Les tests vérifient la précision des montants, la cohérence des brouillons, la séparation démo/réel et les échecs de lecture. Les vérifications visuelles réelles sont consignées dans `VERIFICATION.md` lorsqu’elles sont effectuées. Aucun test ne publie sur X/Telegram et aucune transaction n’est émise.

## Références de mise en œuvre

- [Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/)
- [Installation Expo Router](https://docs.expo.dev/router/installation/)
- [Expo pour le web](https://docs.expo.dev/workflow/web/)
- Spec de référence : `../SPEC-PAIEMENTS-ET-INCITATIONS.md` (non modifiée par ce prototype).
