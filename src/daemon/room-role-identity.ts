import path from "node:path";
import { readForkAssignment, resolveRoomAgents, type ForkAssignment, type RoomAgent } from "./fork-assignment.js";
import { readRoomRoleCapabilities, type RoomRoleCapabilities } from "./room-role-capability.js";

export type TrustedRoomRole = { room: number; agent: RoomAgent; assignment: ForkAssignment; capability: RoomRoleCapabilities };
export function trustedRoomRole(env: Readonly<Record<string, string | undefined>>, signature: string): TrustedRoomRole | null {
  const dataDir = env["MIND_WAKE_DATA_DIR"], agentId = env["MIND_WAKE_OWNER_AGENT"];
  const room = Number(env["MIND_WAKE_OWNER_FORK"]);
  if (!dataDir || !agentId || !Number.isInteger(room) || room < 2 || room > 8) return null;
  try {
    const assignment = readForkAssignment(path.join(dataDir, "forks", String(room)));
    if (!assignment) return null;
    const agent = resolveRoomAgents(assignment, dataDir).find(a => a.id === agentId && a.name === signature);
    if (!agent) return null;
    const capability = readRoomRoleCapabilities(dataDir, room, assignment.workspace, agent.id);
    return capability ? { room, agent, assignment, capability } : null;
  } catch { return null; }
}

/** A voice identity must uniquely match a canonical configured agent, never just a similar label. */
export function trustedRoomRoleBySignature(dataDir: string, signature: string): TrustedRoomRole | null {
  const matches: TrustedRoomRole[] = [];
  for (let room = 2; room <= 8; room++) {
    try {
      const assignment = readForkAssignment(path.join(dataDir, "forks", String(room)));
      if (!assignment) continue;
      for (const agent of resolveRoomAgents(assignment, dataDir)) {
        if (agent.name !== signature) continue;
        const role = trustedRoomRole({MIND_WAKE_DATA_DIR:dataDir,MIND_WAKE_OWNER_FORK:String(room),MIND_WAKE_OWNER_AGENT:agent.id},signature);
        if (role) matches.push(role);
      }
    } catch { /* An invalid assignment grants no capability. */ }
  }
  return matches.length === 1 ? matches[0]! : null;
}
