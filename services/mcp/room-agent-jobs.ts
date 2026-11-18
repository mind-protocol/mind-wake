import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { trustedRoomRole, type TrustedRoomRole } from "../../src/daemon/room-role-identity.js";
export { trustedRoomRole } from "../../src/daemon/room-role-identity.js";
import { workspaceDirFor } from "../../src/daemon/paths.js";
import { BackgroundJobStore, type BackgroundJob } from "../../src/daemon/background-jobs.js";
import { registerBackgroundTools } from "./background-tools.js";

export const ROOM_AGENT_JOB_LAUNCHER = "jobs/room-agent-sous-session.mjs";
const within = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
export function roleMandateFile(role: TrustedRoomRole, relative: string): string {
  const own = path.join(role.capability.workspace, "agents", role.agent.id);
  const candidate = path.resolve(own, relative);
  if (!within(own, candidate) || !fs.statSync(candidate).isFile()
    || !within(fs.realpathSync(own), fs.realpathSync(candidate))) throw Error("Mandate must be a real file in your own agent directory.");
  return candidate;
}

/** The host binds origin to canonical room/role; the model cannot choose another launcher or identity. */
export function registerRoomAgentJobTools(server: McpServer, env: Readonly<Record<string, string | undefined>>, signature: string): void {
  const role = trustedRoomRole(env, signature), dataDir = env["MIND_WAKE_DATA_DIR"];
  if (!role?.capability.backgroundJobs || !dataDir) return;
  const launchDir = `jobs/room-agents/${role.room}/${role.agent.id}/launches/`;
  const prefix = `${signature} · `;
  const owned = (job: BackgroundJob): boolean => job.script === ROOM_AGENT_JOB_LAUNCHER
    && job.args.length === 1 && job.args[0]?.startsWith(launchDir) === true
    && /^[a-f0-9]{24}\.json$/u.test(job.args[0].slice(launchDir.length));
  type Handler = (args: Record<string, unknown>, extra: unknown) => unknown;
  const raw = server.registerTool as unknown as (...args: unknown[]) => unknown;
  const failure = (error: unknown) => ({ isError: true, content: [{type: "text", text: JSON.stringify({error: String(error)})}] });
  const register = ((name: string, config: Record<string, unknown>, handler: Handler) => {
    if (name === "start_background_job") return raw.call(server, name, {
      ...config,
      description: "Delegate a supervised task to your own durable sub-agent. First write its mandate in your own agent directory. It inherits your real room identity and permitted MCP tools; it writes only in its own task directory. Read its answer.txt/result.json and review the result before reporting completion. Wake Pause/Force-off/provider controls apply.",
      inputSchema: z.strictObject({title:z.string().trim().min(1).max(160),mandate:z.string().min(1),why:z.string().trim().min(1),trigger_message_id:z.string().optional(),idempotency_key:z.string().min(8).max(32)}),
    }, (args: {title:string;mandate:string;why:string;trigger_message_id?:string;idempotency_key:string}, extra: unknown) => {
      try {
        const current = trustedRoomRole(env, signature);
        if (!current?.capability.backgroundJobs) throw Error("Role delegation authorization changed");
        const mandate = roleMandateFile(current, args.mandate);
        const launch = {origin:{room:role.room,agentId:role.agent.id,signature,projectId:role.capability.projectId,triggerMessageId:args.trigger_message_id??null},title:args.title,why:args.why,mandate,mandateSHA256:createHash("sha256").update(fs.readFileSync(mandate)).digest("hex")};
        const digest = createHash("sha256").update(JSON.stringify(launch)).digest("hex").slice(0,24);
        const relative = launchDir+digest+".json", file = path.join(workspaceDirFor(dataDir), relative);
        fs.mkdirSync(path.dirname(file), {recursive:true});
        if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({...launch,launchedAt:new Date().toISOString()},null,2));
        return handler({title:prefix+args.title,script:ROOM_AGENT_JOB_LAUNCHER,args:[relative],idempotency_key:`role${role.room}:${role.agent.id}:${args.idempotency_key}`,relaunch:false,why:args.why,...(args.trigger_message_id===undefined?{}:{trigger_message_id:args.trigger_message_id})},extra);
      } catch (error) { return failure(error); }
    });
    if (name === "list_background_jobs") return raw.call(server, name, {...config,description:"Your own supervised sub-agents and result paths."}, async (args:Record<string,unknown>,extra:unknown) => {
      const result = await handler(args,extra) as {isError?:boolean;content:{type:string;text:string}[]};
      if (result.isError) return result;
      const jobs = (JSON.parse(result.content[0]?.text??"{}").jobs??[]) as BackgroundJob[];
      return {content:[{type:"text",text:JSON.stringify({jobs:jobs.filter(owned)})}]};
    });
    if (name === "cancel_background_job") return raw.call(server,name,config,(args:{job_id:string},extra:unknown) => {
      const store = new BackgroundJobStore(dataDir);
      try { if (!owned(store.get(args.job_id))) return failure("This sub-agent belongs to another role"); }
      catch(error){ return failure(error); } finally { store.close(); }
      return handler(args,extra);
    });
    return undefined;
  }) as unknown as McpServer["registerTool"];
  const filtered = new Proxy(server,{get:(target,key,receiver)=>key==="registerTool"?register:Reflect.get(target,key,receiver)});
  registerBackgroundTools(filtered,{...env,MIND_WAKE_BACKGROUND_JOBS:"1"});
}
