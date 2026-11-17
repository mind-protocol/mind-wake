import fs from "node:fs";
import path from "node:path";

/** Overrides belong to the active workspace and are read for each new call. */
export function agentRoleFile(workspace: string, id: string): string {
  return path.join(workspace, "artifacts", "prompts", "system", id + ".md");
}
export function readAgentRole(workspace: string, id: string, fallback: string): string {
  try {
    return fs.readFileSync(agentRoleFile(workspace, id), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}
