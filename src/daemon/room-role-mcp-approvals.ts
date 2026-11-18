import path from "node:path";
import { fileURLToPath } from "node:url";
import { trustedRoomRole } from "./room-role-identity.js";

const repository = fileURLToPath(new URL("../../",import.meta.url));
const samePath = (a:string,b:string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const TOOL_NAMES = [
  "start_background_job","list_background_jobs","cancel_background_job",
  "call","call_human","list_active_calls","hangup_call","invite_to_call",
  "desktop_open_url","desktop_scrollto","desktop_ascii","desktop_click_excerpt","desktop_taskbar",
  "desktop_list","desktop_windows","desktop_tabs","desktop_open","desktop_observe","desktop_sweep","desktop_click","desktop_act","desktop_page","desktop_slice",
  "message","list_owner_messages",
] as const;

/** Standard per-tool policy only for the host's canonical full-role MCP. Explicit restrictions remain restrictions. */
export function withRoomRoleMcpApprovals(server: Record<string,unknown>, expectedDataDir?:string): Record<string,unknown> {
  const env = server["env"] as Record<string,string|undefined>|undefined;
  if (!env || !expectedDataDir || !env["MIND_WAKE_DATA_DIR"] || !samePath(expectedDataDir,env["MIND_WAKE_DATA_DIR"])) return server;
  const args = server["args"];
  if (!Array.isArray(args) || !args.some(a=>typeof a==="string" && ["ts","js"].some(ext=>samePath(a,path.join(repository,"services/mcp/fork-owner-main."+ext))))) return server;
  const signature = env["MIND_WAKE_OWNER_SIGNATURE"];
  if (!signature || !trustedRoomRole(env,signature)?.capability.mindTools) return server;
  const previous = server["tools"];
  if (previous!==undefined && (!previous || typeof previous!=="object" || Array.isArray(previous))) throw Error("Invalid role MCP tool policy");
  const tools = {...previous as Record<string,unknown>|undefined};
  const enabled = server["enabled_tools"], disabled = server["disabled_tools"];
  for (const name of TOOL_NAMES) {
    if (Array.isArray(disabled) && disabled.includes(name) || Array.isArray(enabled) && !enabled.includes(name)) continue;
    const existing = tools[name];
    if (existing!==undefined && (!existing || typeof existing!=="object" || Array.isArray(existing))) continue;
    const policy = existing as Record<string,unknown>|undefined;
    if (policy?.["enabled"]===false || policy?.["approval_mode"]!==undefined && !["approve","auto"].includes(String(policy["approval_mode"]))) continue;
    tools[name] = {...policy,approval_mode:"approve"};
  }
  return {...server,tools};
}
