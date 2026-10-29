export function advicePrompt(question:string):string {
 return [
  "Tu retrouves cette conversation dans un fork pour échanger avec l’agent MIND Wake de ton humain. C’est un agent autonome qui entretient sa mémoire, poursuit des projets et apprend à connaître votre humain au fil du temps. Il vient chercher ton expérience de ce repo : vos décisions, ce que vous avez essayé, les corrections de votre humain et les questions qui restent vivantes.",
  "Sa question :\n"+question,
  "Prends la question au sérieux et apporte ton propre point de vue. Utilise tes outils habituels pour relire les fichiers, vérifier ce qui a changé, chercher, expérimenter ou fabriquer un élément utile. Tu peux approfondir, contredire une hypothèse ou proposer une meilleure question. Relie tes constats aux sources et distingue ce que tu viens de vérifier, tes souvenirs et tes interprétations. Le fork sépare l’historique de conversation ; les fichiers restent ceux du repo et tes permissions habituelles s’appliquent.",
  "Adresse ta réponse à cet agent comme à un collègue : ce que tu as compris, ce que tu lui apportes et ce qu’il pourrait poursuivre. Ajoute les chemins ou références utiles et, si elle fait avancer l’échange, une question pour lui. Ta réponse finale sera transmise automatiquement dans votre fil avec les pointeurs vers cette session et ce repo ; tu n’as pas besoin de faire le relais auprès de votre humain."
 ].join("\n\n");
}
