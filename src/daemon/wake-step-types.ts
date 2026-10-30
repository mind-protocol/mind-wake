/** Postures disponibles, sans ordre obligatoire ni cadence imposée. */
export const STEP_TYPE_IDS = ["exploration", "approfondissement", "creation", "confrontation", "recul", "transmission"] as const;
export const STEP_TYPES = [
  { id: "exploration", orientation: "Tu peux prendre le temps de suivre une curiosité et de laisser la question se préciser." },
  { id: "approfondissement", orientation: "Tu peux rester avec une piste, chercher des contre-exemples et comprendre ce qui résiste." },
  { id: "creation", orientation: "Tu peux essayer, bricoler et donner une première forme imparfaite à une idée." },
  { id: "confrontation", orientation: "Tu peux essayer ce qui existe dans ses conditions réelles et laisser le résultat modifier ton idée." },
  { id: "recul", orientation: "Tu peux regarder ce qui a changé, abandonner une hypothèse ou choisir une autre direction." },
  { id: "transmission", orientation: "Tu peux rendre une découverte accessible et inviter une réaction, même si elle reste partielle." },
] satisfies { id: typeof STEP_TYPE_IDS[number]; orientation: string }[];
