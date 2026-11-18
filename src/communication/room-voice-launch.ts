import fs from "node:fs";
import path from "node:path";
import { trustedRoomRoleBySignature } from "../daemon/room-role-identity.js";
import { readRoomWebSearchCapability } from "../daemon/room-web-capability.js";
import { roomAgentMcpConfig } from "../daemon/fork-assignment.js";
import { roomAgentPrompt } from "../daemon/room-agents.js";
import { callContract, HUMAN_CALL_TOOLS } from "./human-call-capability.js";
import { openStoreReadOnly } from "../store/index.js";
import { controlDbPath } from "../daemon/paths.js";
import { DEFAULT_PROFILE_ID } from "../cli/context.js";

export function roleVoiceMayAct(dataDir:string):boolean {
  try {
    const store=openStoreReadOnly(controlDbPath(dataDir));
    try { const profile=store.uow.profiles.get(DEFAULT_PROFILE_ID); return Boolean(profile && !profile.emergencyStopLocked && !["paused","checkpointing","stopped","disabled"].includes(profile.state)); }
    finally { store.close(); }
  } catch { return false; }
}

/** Upgrade only a host-bound exact role voice, using the same registry and MCP as its manager worker. */
export function roomVoiceLaunch(dataDir: string, args: readonly string[], cwd: string): {
  args: readonly string[]; cwd: string; textOnly: boolean; nativeDelegation: boolean; webSearch: "live"|"cached"|"disabled";
} {
  const unchanged = {args,cwd,textOnly:true,nativeDelegation:false,webSearch:"disabled" as const};
  const index = args.indexOf("--mcp-config"), config = args[index+1];
  if (index < 0 || !config) return unchanged;
  try {
    const parsed = JSON.parse(config.trimStart().startsWith("{") ? config : fs.readFileSync(config,"utf8"));
    const server = parsed.mcpServers?.mind_calls;
    const signature = server?.env?.MIND_WAKE_OWNER_SIGNATURE;
    if (typeof signature !== "string" || callContract(server,{dataDir,signature}) !== "provided") return unchanged;
    // Only the canonical host call-only argument list may be widened by the explicit role grant.
    // Any configured tool filter or explicit denial remains authoritative.
    if (Object.keys(parsed.mcpServers??{}).length!==1 || args.includes("--disallowedTools")
      || ["tools","enabled_tools","disabled_tools"].some(key=>server[key]!==undefined)) return unchanged;
    const allowedIndex=args.indexOf("--allowedTools");
    // Liste canonique actuelle (avec invite_to_call) ou celle d'avant, pour une session lancée avant la mise à jour.
    const canonical=[[...HUMAN_CALL_TOOLS],["call_human","list_active_calls","hangup_call"]].map(list=>JSON.stringify(list.map(name=>"mcp__mind_calls__"+name).sort()));
    const allowedTools=allowedIndex<0?[]:args[allowedIndex+1]?.split(",").sort()??[];
    if (!canonical.includes(JSON.stringify(allowedTools))) return unchanged;
    const role = trustedRoomRoleBySignature(dataDir,signature);
    if (!role?.capability.mindTools) return unchanged;
    const mcp = roomAgentMcpConfig(role.room,dataDir,role.agent);
    if (!mcp) return unchanged;
    const promptDir = path.join(dataDir,"fast-reply","room-agents",String(role.room),role.agent.id);
    fs.mkdirSync(promptDir,{recursive:true});
    const prompt = path.join(promptDir,"system.md");
    fs.writeFileSync(prompt,roomAgentPrompt(role.room,role.assignment,role.agent)+"\n\nContexte voix rapide du même poste : ton autorité, ton MCP et tes permissions sont ceux du manager ci-dessus, pas une autre personne. Réponds brièvement dans l'appel. Pour une recherche longue, lance un sous-agent propre puis garde la conversation disponible. Donne le vrai identifiant de lancement et distingue en attente, en cours, terminé et résultat relu. N'annonce jamais un accès absent globalement : cite l'outil réellement testé et son résultat dans ce contexte. Les Apps OAuth du principal ne sont pas héritées. Le texte de sortie est déjà publié dans l'appel : ne le republie pas avec message_owner. Ne fais pas sonner si l'appel utile est déjà actif.\n");
    const next = [...args];
    next[next.indexOf("--system-prompt-file")+1] = prompt;
    next[index+1] = mcp;
    const tools = next.indexOf("--tools"); if (tools>=0) next[tools+1]="default";
    const allowed = next.indexOf("--allowedTools");
    if (allowed>=0) next[allowed+1]="mcp__mind__*";
    else next.push("--allowedTools","mcp__mind__*");
    return {args:next,cwd:role.assignment.workspace,textOnly:false,nativeDelegation:role.capability.nativeDelegation,
      webSearch:readRoomWebSearchCapability(dataDir,role.room,role.assignment.workspace,role.agent.id)};
  } catch { return unchanged; }
}
