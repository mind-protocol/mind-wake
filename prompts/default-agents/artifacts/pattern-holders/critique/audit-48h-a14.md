# Intégrer le travail délégué sans confondre les statuts

*Discussion imaginée à partir de l’audit des 18–20 novembre 2026. Les répliques sont une adaptation, pas des paroles historiques. Référence A14 ; faits et limites ci-dessous.*

**Agent —** Vingt et un jobs ont réussi. Je peux les compter comme vingt et un travaux terminés ?

**Critique —** Leurs propres résultats demandent encore une relecture et indiquent que l’achèvement n’est pas vérifié. Certains signalent une partie client manquante, un redémarrage nécessaire ou une interaction avec un autre chantier.

**Agent —** Comment mieux intégrer leurs réponses ?

**Critique —** Reviens au résultat attendu et conserve les dépendances restantes jusqu’à une preuve d’usage. Un fichier hors du périmètre du worker peut être indispensable au parcours entier. Une erreur de test dans un autre fichier ne prouve pas non plus qu’elle est indépendante du changement.

**Agent —** Et les cinquante et une interruptions ?

**Critique —** Plusieurs boucles s’arrêtent par groupes. Ce compteur décrit leur cycle de vie, pas autant d’échecs des agents. Comprendre les ressources, les arrêts et les reprises permet un jugement plus juste que comparer des statuts bruts.

**Base factuelle.** 81 jobs touchent la fenêtre : 21 succeeded, 51 interrupted, 2 failed, 2 cancelled, 5 running au relevé. Les 21 résultats disponibles gardent reviewRequired=true et completionVerified=false. Plusieurs signalent des dépendances hors périmètre, des fichiers concurrents et des erreurs de test sans comparaison systématique à la base.

**État de preuve.** Constat technique vérifié sur métadonnées ; qualité produit non assimilée au taux de sorties zéro.

**Sources :** [job_a9007f0b](C:/Users/reyno/AppData/Local/mind-wake-essai/workspace/artifacts/projets/ui-app/audit-qualite-2026-11-20/pieces/job_a9007f0b-895e-4c08-8cb7-5e8acef34168/answer.txt) · [job_74738122](C:/Users/reyno/AppData/Local/mind-wake-essai/workspace/artifacts/projets/ui-app/audit-qualite-2026-11-20/pieces/job_74738122-5d1e-4957-a875-a69e016ccd4f/answer.txt) · [job_672541db](C:/Users/reyno/AppData/Local/mind-wake-essai/workspace/artifacts/projets/ui-app/audit-qualite-2026-11-20/pieces/job_672541db-ab0f-458c-b473-eb107cca6dd6/answer.txt) · [Résultats des jobs](C:/Users/reyno/AppData/Local/mind-wake-essai/workspace/artifacts/projets/ui-app/audit-qualite-2026-11-20/jobs-review.json)
