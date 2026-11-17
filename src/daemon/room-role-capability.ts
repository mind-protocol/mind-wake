import path from "node:path";
import { readCounter } from "./project-change.js";
import { projectStatus } from "./project-capacity.js";
import { workspaceDirFor } from "./paths.js";

export type RoomRoleCapabilities = {
  projectId: string;
  workspace: string;
  nativeDelegation: boolean;
  backgroundJobs: boolean;
  mindTools: boolean;
  calls: { coordinatorAgent: string; minIntervalMs: number } | null;
};
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const canonical = (v: string): string => {
  const full = path.resolve(v);
  return process.platform === "win32" ? full.toLowerCase() : full;
};

/** Exact active project, room, workspace and explicit role membership are required. */
export function roomRoleCapabilitiesFromRegistry(
  counter: Record<string, unknown> | null,
  workspace: string,
  room: number,
  assignmentWorkspace: string,
  agentId: string,
): RoomRoleCapabilities | null {
  if (!Number.isInteger(room) || room < 2 || room > 8 || !path.isAbsolute(assignmentWorkspace)
    || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(agentId)) return null;
  const projects = record(counter?.["projects"]);
  if (!projects) return null;
  for (const [id, value] of Object.entries(projects)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) continue;
    const project = record(value);
    if (!project || project["room"] !== room || projectStatus(project["status"]) !== "active") continue;
    const root = path.join(workspace, "artifacts", "projets", id);
    if (canonical(root) !== canonical(assignmentWorkspace)) continue;
    const capability = record(record(project["capabilities"])?.["roleTools"]);
    const agents = capability?.["agents"];
    if (!Array.isArray(agents) || !agents.every(a => typeof a === "string") || !agents.includes(agentId)) return null;
    const calls = record(capability?.["calls"]);
    const coordinator = calls?.["coordinatorAgent"], interval = calls?.["minIntervalMs"];
    return {
      projectId: id, workspace: root,
      nativeDelegation: capability?.["nativeDelegation"] === true,
      backgroundJobs: capability?.["backgroundJobs"] === true,
      mindTools: capability?.["mindTools"] === true,
      calls: typeof coordinator === "string" && agents.includes(coordinator)
        && typeof interval === "number" && Number.isSafeInteger(interval) && interval >= 300_000
        ? {coordinatorAgent:coordinator,minIntervalMs:interval} : null,
    };
  }
  return null;
}

export function readRoomRoleCapabilities(dataDir: string, room: number, assignmentWorkspace: string, agentId: string): RoomRoleCapabilities | null {
  try {
    const workspace = workspaceDirFor(dataDir);
    return roomRoleCapabilitiesFromRegistry(readCounter(workspace), workspace, room, assignmentWorkspace, agentId);
  } catch { return null; }
}
