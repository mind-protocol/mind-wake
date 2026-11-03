import fs from "node:fs";
import path from "node:path";
import { readCounter, PROJECT_COUNTER_FILE } from "./project-change.js";
import { atomicJson, withProjectLock } from "./steps-coordination.js";
import { assertProjectActivation } from "./project-capacity.js";

export const PROMPT_IMPROVEMENT_PROJECT = "ameliorer-mon-systeme-prompt";

/** Select maintenance without launching a session or changing any Wake controls. */
export function updatePromptImprovementProject(workspace: string, oversized: boolean): void {
  const file = path.join(workspace, "artifacts", PROJECT_COUNTER_FILE);
  if (!oversized && !fs.existsSync(file)) return;
  fs.mkdirSync(path.join(workspace, "artifacts"), { recursive: true });
  const updated = withProjectLock(workspace, () => {
    const counter = readCounter(workspace);
    if (!counter && fs.existsSync(file)) throw Error("Project registry unavailable");
    const next = counter ?? { projects: {} };
    const projects = next["projects"];
    if (!projects || typeof projects !== "object" || Array.isArray(projects))
      throw Error("Invalid project registry");
    if (!oversized) {
      if (next["promptImprovementProject"] === undefined) return true;
      delete next["promptImprovementProject"];
    } else {
      const registry = projects as Record<string, unknown>;
      if (!Object.hasOwn(registry, PROMPT_IMPROVEMENT_PROJECT)) {
        assertProjectActivation(next, PROMPT_IMPROVEMENT_PROJECT);
        registry[PROMPT_IMPROVEMENT_PROJECT] = {
          title: "ameliorer mon systeme prompt",
          status: "en cours",
          spent: 0,
          next: "Condenser PERSONALITY.md et SYSTEM.md à l’indispensable, sous 5 000 caractères chacun ; intégrer les règles importantes au cockpit via des hooks ou systèmes adaptés.",
        };
      }
      if (next["current"] === PROMPT_IMPROVEMENT_PROJECT &&
          next["promptImprovementProject"] === PROMPT_IMPROVEMENT_PROJECT) return true;
      next["current"] = PROMPT_IMPROVEMENT_PROJECT;
      next["promptImprovementProject"] = PROMPT_IMPROVEMENT_PROJECT;
      next["selectionRevision"] = Number(next["selectionRevision"] ?? 0) + 1;
    }
    atomicJson(file, next);
    return true;
  });
  if (!updated) throw Error("Project registry is busy");
}
