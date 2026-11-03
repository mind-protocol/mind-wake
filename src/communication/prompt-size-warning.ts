import fs from "node:fs";
import path from "node:path";
import { updatePromptImprovementProject } from "../daemon/prompt-improvement-project.js";
import { ProjectCapacityError } from "../daemon/project-capacity.js";

export const PROMPT_SIZE_WARNING_LIMIT = 5000;
const rulesExplanation = "Les prompts ne doivent pas devenir une liste de règles. Les règles importantes doivent être intégrées au cockpit via des hooks bien pensés ou d’autres systèmes adaptés, pour être appliquées au bon moment plutôt que simplement répétées dans le prompt.";
const warningExplanation = `${rulesExplanation} Compresse l’information à l’indispensable : conserve uniquement ce qui est nécessaire pour agir, sans dates, chronologie, répétitions ni détails superflus. Garde l’historique dans les fichiers de mémoire, hors du prompt.`;
const warningPattern = /^⚠️ Instructions volumineuses : (?:artifacts\/PERSONALITY\.md|SYSTEM\.md) \(\d+ caractères\)(?:, (?:artifacts\/PERSONALITY\.md|SYSTEM\.md) \(\d+ caractères\))* — seuil : 5 000 caractères par fichier\.\n\n/u;

export function withoutPromptSizeWarning(text: string): string {
  const body = text.replace(warningPattern, "");
  if (body === text) return text;
  for (const explanation of [warningExplanation, rulesExplanation]) {
    const prefix = `${explanation}\n\n`;
    if (body.startsWith(prefix)) return body.slice(prefix.length).replace(/^Le projet de maintenance n’a pas été activé : le plafond local des chantiers actifs est atteint\.\n\n/u, "");
  }
  return body;
}

/** Measure current workspace files at publication, without changing their contents. */
export function withPromptSizeWarning(workspace: string, text: string): string {
  const oversized: string[] = [];
  for (const relative of ["artifacts/PERSONALITY.md", "SYSTEM.md"]) {
    try {
      const file = fs.realpathSync(path.join(workspace, relative));
      const resolved = path.relative(fs.realpathSync(workspace), file);
      if (resolved === ".." || resolved.startsWith(".." + path.sep) || path.isAbsolute(resolved)) continue;
      const length = Array.from(fs.readFileSync(file, "utf8")).length;
      if (length > PROMPT_SIZE_WARNING_LIMIT) oversized.push(`${relative} (${length} caractères)`);
    } catch (error) {
      // An unavailable instruction file must not prevent the agent from replying.
      if (!(error instanceof Error)) throw error;
    }
  }
  const body = withoutPromptSizeWarning(text);
  let maintenance = "";
  try {
    updatePromptImprovementProject(workspace, oversized.length > 0);
  } catch (error) {
    if (!(error instanceof ProjectCapacityError)) throw error;
    maintenance = "\n\nLe projet de maintenance n’a pas été activé : le plafond local des chantiers actifs est atteint.";
  }
  return oversized.length === 0 ? body
    : `⚠️ Instructions volumineuses : ${oversized.join(", ")} — seuil : 5 000 caractères par fichier.\n\n${warningExplanation}${maintenance}\n\n${body}`;
}
