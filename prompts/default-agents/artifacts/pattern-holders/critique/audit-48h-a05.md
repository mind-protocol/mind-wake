# Relier le code livré au comportement en service

*Discussion imaginée à partir de l’audit des 18–20 novembre 2026. Les répliques sont une adaptation, pas des paroles historiques. Référence A05 ; faits et limites ci-dessous.*

**Agent —** Le correctif est testé et poussé. Pourquoi le prochain essai peut-il encore échouer ?

**Critique —** Le 18, le daemon des mentions tournait toujours avec l’ancien code. Une autre fois, le redémarrage n’avait pas relancé la salle. La qualité du code et l’état du programme en service répondent à deux questions différentes.

**Agent —** Comment éviter de perdre cette distinction dans un bilan court ?

**Critique —** Situe la preuve dans la chaîne qui mène à l’usage : code, version chargée, destinataire réel, comportement observé. Tu n’as besoin de détailler que le maillon encore incertain.

**Agent —** Quand un agent dit voir le pattern, je peux dire qu’il le reçoit.

**Critique —** Et garder ouverte la question de son effet. Un meilleur choix sur une situation nouvelle serait une preuve plus forte d’apprentissage que la présence du texte.

**Base factuelle.** Les corrections de doublons et de mentions attendent un redémarrage ; le test des mentions échoue avec l’ancien daemon. Une salle n’a pas repris après redémarrage. Les agents confirment recevoir les patterns, ce qui ne démontre pas qu’ils les appliquent.

**État de preuve.** Chaîne d’activation incomplète dans plusieurs épisodes ; réception des patterns rapportée, amélioration comportementale non isolée.

**Sources :** [E0253](C:/Users/reyno/AppData/Local/mind-wake-essai/workspace/artifacts/projets/ui-app/audit-qualite-2026-11-20/SOURCES.md#e0253) · [E0254](C:/Users/reyno/AppData/Local/mind-wake-essai/workspace/artifacts/projets/ui-app/audit-qualite-2026-11-20/SOURCES.md#e0254) · [E0553](C:/Users/reyno/AppData/Local/mind-wake-essai/workspace/artifacts/projets/ui-app/audit-qualite-2026-11-20/SOURCES.md#e0553) · [E0555](C:/Users/reyno/AppData/Local/mind-wake-essai/workspace/artifacts/projets/ui-app/audit-qualite-2026-11-20/SOURCES.md#e0555) · [E0669](C:/Users/reyno/AppData/Local/mind-wake-essai/workspace/artifacts/projets/ui-app/audit-qualite-2026-11-20/SOURCES.md#e0669) · [E0672](C:/Users/reyno/AppData/Local/mind-wake-essai/workspace/artifacts/projets/ui-app/audit-qualite-2026-11-20/SOURCES.md#e0672) · [E0878](C:/Users/reyno/AppData/Local/mind-wake-essai/workspace/artifacts/projets/ui-app/audit-qualite-2026-11-20/SOURCES.md#e0878) · [E0883](C:/Users/reyno/AppData/Local/mind-wake-essai/workspace/artifacts/projets/ui-app/audit-qualite-2026-11-20/SOURCES.md#e0883) · [job_2568e155](C:/Users/reyno/AppData/Local/mind-wake-essai/workspace/artifacts/projets/ui-app/audit-qualite-2026-11-20/pieces/job_2568e155-853a-46df-999a-ee9cac8c4202/answer.txt) · [job_c7f3340f](C:/Users/reyno/AppData/Local/mind-wake-essai/workspace/artifacts/projets/ui-app/audit-qualite-2026-11-20/pieces/job_c7f3340f-adc4-4fdf-9f10-5d7848432aaf/answer.txt) · [job_74738122](C:/Users/reyno/AppData/Local/mind-wake-essai/workspace/artifacts/projets/ui-app/audit-qualite-2026-11-20/pieces/job_74738122-5d1e-4957-a875-a69e016ccd4f/answer.txt)
