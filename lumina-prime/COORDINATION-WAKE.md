# Contribution Wake à l’app MIND

Mandat NLR du 4 novembre 2026, 15:00 UTC : « switche sur mind, aide au dev de l'ap cf sessions codex » (`ui-5fcacb36-ae4d-4ced-9443-1dbacd9f03f2`). Lumina, son jeu et ses agents restent arrêtés.

## Périmètre pris

Marco délègue un module TypeScript pur dans `app/src/domain/payment-command.ts` et ses tests propres : commandes de paiement de la section 5 de la spec, montant atomique exact, username canonique, aperçu destiné à l’écran, origine directe ou détectée. Une préparation ne donne jamais une autorisation et ne déclenche aucun paiement.

Aucun écran, navigation, dépendance, contrat, whitepaper ou formule de staking n’est modifié par cette contribution. La spec économique est en évolution dans la session Codex `01a1a705-8c1e-70f1-a501-8a20f5091321`. La demande de coordination `direct_d21d9ab40a59851bf1e53aad28f5af29` a échoué sur son verrou d’écrivain actif ; aucune réponse de coordination n’a été reçue.

État : implémentation en cours par `/root/mind_payment_command`. La présence de cette note ne vaut pas intégration dans un écran ni validation du parcours complet. Résultat et vérifications attendus dans le workspace Wake : `artifacts/projets/ui-app/app-paiements/RESULTAT-COMMANDES.md`.

## Extension ciblée après relecture du whitepaper

Le 4 novembre 2026, la relecture demandée par NLR puis sa demande de travail parallèle étendent ce périmètre à deux libellés de `app/src/app/compose/[username].tsx` : « Don / paiement direct » devient « Don », et « Nature : don / paiement direct » devient « Nature : don ». Le parcours enregistré reste `kind: 'gift'` ; aucune commande, signature ou exécution n’est ajoutée. Cette extension remplace l’exclusion générale des écrans ci-dessus pour ces deux littéraux uniquement. Le fichier a été comparé par SHA-256 avant écriture pour préserver les travaux concurrents.

La revue des trois écarts et le texte de référence sont conservés dans `artifacts/projets/ui-app/app-paiements/REVUE-WHITEPAPER-APP.md` du workspace Wake. Les deux autres écarts restent des propositions. La correction ne prouve aucun parcours réel.
