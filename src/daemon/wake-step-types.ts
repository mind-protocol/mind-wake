/** Postures disponibles, sans ordre obligatoire ni cadence imposée. */
export const STEP_TYPE_IDS = ["exploration", "approfondissement", "creation", "confrontation", "recul", "transmission"] as const;
export const STEP_TYPES = [
  { id: "exploration", orientation: "You can take time to follow a curiosity and let the question become clearer." },
  { id: "approfondissement", orientation: "You can stay with a direction, seek counterexamples and understand what resists." },
  { id: "creation", orientation: "You can experiment, tinker and give an idea its first imperfect form." },
  { id: "confrontation", orientation: "You can try what exists under real conditions and let the result change your idea." },
  { id: "recul", orientation: "You can look at what has changed, abandon a hypothesis or choose another direction." },
  { id: "transmission", orientation: "You can make a discovery accessible and invite a response, even while it remains partial." },
] satisfies { id: typeof STEP_TYPE_IDS[number]; orientation: string }[];
