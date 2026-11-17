import path from "node:path";
import { workspaceDirFor } from "./paths.js";
import { readCounter } from "./project-change.js";
import { projectStatus } from "./project-capacity.js";

export type RoomWebSearchMode = "live" | "cached" | "disabled";
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const canonical = (value: string): string => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

/** Owner project registry, not model arguments or a room prompt, grants web search. */
export function roomWebSearchFromRegistry(
  counter: Record<string, unknown> | null,
  workspace: string,
  room: number,
  assignmentWorkspace: string,
  agentId: string,
): RoomWebSearchMode {
  if (!Number.isInteger(room) || room < 2 || room > 8 || !path.isAbsolute(assignmentWorkspace))
    return "disabled";
  const projects = record(counter?.["projects"]);
  if (!projects) return "disabled";
  for (const [id, value] of Object.entries(projects)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) continue;
    const project = record(value);
    if (!project || project["room"] !== room || projectStatus(project["status"]) !== "active") continue;
    if (canonical(path.join(workspace, "artifacts", "projets", id)) !== canonical(assignmentWorkspace)) continue;
    const capability = record(record(project["capabilities"])?.["webSearch"]);
    const mode = capability?.["mode"];
    const agents = capability?.["agents"];
    if (mode !== "live" && mode !== "cached" && mode !== "disabled") return "disabled";
    if (!Array.isArray(agents) || !agents.every(a => typeof a === "string") || !agents.includes(agentId))
      return "disabled";
    return mode;
  }
  return "disabled";
}

export function readRoomWebSearchCapability(
  dataDir: string,
  room: number,
  assignmentWorkspace: string,
  agentId: string,
): RoomWebSearchMode {
  try {
    const workspace = workspaceDirFor(dataDir);
    return roomWebSearchFromRegistry(readCounter(workspace), workspace, room, assignmentWorkspace, agentId);
  } catch {
    return "disabled";
  }
}
