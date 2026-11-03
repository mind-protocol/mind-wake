import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { ForkPlanning } from "./fork-planning.js";
import { readProjectLandscape } from "./second-thread.js";
import { projectIsLeased, activeClaudeProject } from "./project-lease.js";
import { workspaceDirFor, controlDbPath } from "./paths.js";
import { openStoreReadOnly } from "../store/index.js";
import { DEFAULT_PROFILE_ID } from "../cli/context.js";
import { resolvePolicy } from "../policy/index.js";
import { StopFlag } from "../runner/controls.js";

export function registerForkPlannerTools(server: McpServer, env: Readonly<Record<string,string|undefined>>): void {
  const dataDir=env["MIND_WAKE_DATA_DIR"], id=Number(env["MIND_WAKE_FORK_ID"]), token=env["MIND_WAKE_FORK_SESSION"];
  if (!dataDir || !token || !Number.isInteger(id) || id<2 || id>8) throw Error("Identité de session fork absente");
  const workspace=workspaceDirFor(dataDir);
  const call=(mutate:boolean, action:(planner:ForkPlanning)=>unknown) => {
    let planner:ForkPlanning|undefined;
    try {
      const control=openStoreReadOnly(controlDbPath(dataDir));
      try {
        const policy=resolvePolicy(control.uow.policies,DEFAULT_PROFILE_ID),profile=control.uow.profiles.get(DEFAULT_PROFILE_ID);
        if(policy.status!=="active" || !profile)throw Error("Profil Wake indisponible");
        const enabled=(JSON.parse(fs.readFileSync(path.join(dataDir,"forks",String(id),"enabled.json"),"utf8")) as {enabled?:boolean}).enabled;
        if(mutate && (!enabled || new StopFlag(dataDir).exists() || profile.emergencyStopLocked || ["paused","checkpointing","stopped","disabled"].includes(profile.state)))
          throw Error("Fork désactivé, Wake en pause ou arrêté : réassignation refusée");
      } finally {control.close();}
      planner=new ForkPlanning(dataDir);
      const value=planner.db.transaction(()=>{planner!.assertSession(id,token);return action(planner!);}).immediate();
      return {content:[{type:"text" as const,text:JSON.stringify(value)}]};
    } catch(error) {
      return {isError:true,content:[{type:"text" as const,text:JSON.stringify({error:error instanceof Error?error.message:String(error)})}]};
    } finally {planner?.close();}
  };
  const availability=(planner:ForkPlanning) => {
    const landscape=readProjectLandscape(workspace),plan=planner.get(id),claude=activeClaudeProject(dataDir);
    return landscape.order.map(projectId=>{
      const selectedBy=planner.selectedBy(projectId);
      const available=projectId!==landscape.mainProject && projectId!==claude && (selectedBy===null || selectedBy===id) &&
        (plan.active?.projectId===projectId || !projectIsLeased(dataDir,projectId));
      return {projectId,title:landscape.titles[projectId] ?? projectId,available,selectedBy};
    });
  };
  const projectId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  const text=z.string().trim().min(1).max(8000);
  const wake=z.strictObject({project_id:projectId,objective:text,expected:text});
  server.registerTool("get_my_wakes",{
    description:"Read this fork’s active wake, revision, editable future wakes and available projects. The runtime binds your identity; no fork ID is accepted.",
    inputSchema:z.strictObject({}),annotations:{readOnlyHint:true,openWorldHint:false},
  },()=>call(false,p=>({fork:id,...p.get(id),projects:availability(p)})));
  server.registerTool("reassign_my_wakes",{
    description:"Replace only your future wakes, choosing projects, objectives and order. The current wake continues. Read get_my_wakes first and pass its revision. Empty wakes returns to free planning next turn. Does not change the principal’s rotation or Wake controls.",
    inputSchema:z.strictObject({expected_revision:z.number().int().nonnegative(),reason:text.max(4000),wakes:z.array(wake).max(500)}),
    annotations:{openWorldHint:false},
  },a=>call(true,p=>{
    const available=availability(p);
    for(const step of a.wakes)if(!available.some(x=>x.projectId===step.project_id))throw Error(`Projet absent, bloqué ou archivé : ${step.project_id}`);
    if(a.wakes[0] && !available.find(x=>x.projectId===a.wakes[0]!.project_id)?.available)throw Error("Le projet du prochain wake est déjà occupé ou réservé");
    return p.reassign(id,a.expected_revision,a.wakes.map(w=>({projectId:w.project_id,objective:w.objective,expected:w.expected})),a.reason);
  }));
  server.registerTool("claim_project",{
    description:"Choose and reserve an available project for your next wake, keeping the remaining queue. The current turn is unchanged; another fork’s reservation cannot be replaced. Principal reservations retain priority.",
    inputSchema:z.strictObject({project_id:projectId,objective:text,expected:text,reason:text.max(4000),expected_revision:z.number().int().nonnegative()}),
    annotations:{openWorldHint:false},
  },a=>call(true,p=>{
    if(!availability(p).find(x=>x.projectId===a.project_id)?.available)throw Error("Projet indisponible ou déjà réservé");
    const plan=p.get(id);
    return p.reassign(id,a.expected_revision,[{projectId:a.project_id,objective:a.objective,expected:a.expected},...plan.nextWakes],a.reason);
  }));
}
