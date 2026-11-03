import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach,beforeEach,expect,it} from "vitest";
import {ForkPlanning} from "./fork-planning.js";
import {tryProjectLease,uncertainProjectLease} from "./project-lease.js";
import {runForks,setForkEnabled} from "./forks.js";
import {forkPlannerConfig} from "./fork-runtime.js";
let dir:string,workspace:string;
const wake=(projectId:string)=>({projectId,objective:`Explorer ${projectId}`,expected:`Résultat ${projectId}`});
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),"fork-plan-"));workspace=path.join(dir,"workspace");fs.mkdirSync(path.join(workspace,"artifacts"),{recursive:true});fs.writeFileSync(path.join(workspace,"artifacts/projets-compteur.json"),JSON.stringify({current:"a",projects:{a:{status:"en cours"},b:{status:"en cours"},c:{status:"en cours"},d:{status:"en cours"}}}));});
afterEach(()=>fs.rmSync(dir,{recursive:true,force:true}));
it("changes only future intentions and persists them across a restart",()=>{
 let p=new ForkPlanning(dir);p.seed(2,[wake("b"),wake("b")]);const active=p.begin(2,"session");
 const changed=p.reassign(2,p.get(2).revision,[wake("d"),wake("c")],"Une nouvelle piste");
 expect(changed.active).toEqual(active);expect(changed.nextWakes.map(w=>w.projectId)).toEqual(["d","c"]);
 expect(()=>p.reassign(2,changed.revision-1,[],"stale")).toThrow(/Planning modifié/);
 expect(()=>p.assertSession(3,"session")).toThrow();
 p.finish(2,"session",true);p.close();p=new ForkPlanning(dir);
 expect(p.get(2).reason).toBe("Une nouvelle piste");expect(p.begin(2,"next")?.projectId).toBe("d");
 p.recover(2);expect(p.get(2).nextWakes[0]?.projectId).toBe("d");expect(()=>p.assertSession(2,"next")).toThrow();p.close();
});
it("serializes competing next-project claims from independent connections",()=>{
 const a=new ForkPlanning(dir),b=new ForkPlanning(dir);try {
 a.reassign(2,0,[wake("d")],"Choix A");
 expect(()=>b.reassign(3,0,[wake("d")],"Choix B")).toThrow(/fork 2/);
 expect(b.get(3).nextWakes).toEqual([]);expect(b.get(3).revision).toBe(0);
 a.reassign(2,a.get(2).revision,[wake("b")],"Libérer D");
 expect(b.reassign(3,0,[wake("d")],"Reprendre D").nextWakes[0]?.projectId).toBe("d");
 }finally{a.close();b.close();}
});
it("seeds a legacy fork at its remaining wake and preserves an initialized queue",()=>{
 const p=new ForkPlanning(dir);try {
 p.seed(2,[wake("b"),wake("b")],9);
 expect(p.get(2).nextWakes.map(w=>w.step)).toEqual([9,10]);
 p.seed(2,[wake("c")]);
 expect(p.begin(2,"resume")?.step).toBe(9);
 expect(p.get(2).active?.projectId).toBe("b");
 }finally{p.close();}
});
it("holds a project until released and blocks uncertain process termination",()=>{
 const lease=tryProjectLease(dir,"d");expect(lease).not.toBeNull();expect(tryProjectLease(dir,"d")).toBeNull();lease!.release();
 const next=tryProjectLease(dir,"d");expect(next).not.toBeNull();next!.release();
 uncertainProjectLease(dir,"d","Tree not terminated");expect(tryProjectLease(dir,"d")).toBeNull();
});
it("executes the fork's replacement queue on the next wake instead of recomputing stripes",async()=>{
 setForkEnabled(dir,2,true);let calls=0;
 await runForks({dataDir:dir,workspace,profile:()=>"run",maxTurns:2,turn:async input=>{
  calls++;expect(input.planningSession).toBeTruthy();
  const p=new ForkPlanning(dir);try {
   p.assertSession(2,input.planningSession!);
   if(calls===1){expect(input.message).toContain("Projet : b");const active=p.get(2).active;p.reassign(2,p.get(2).revision,[wake("d")],"Suivre D");expect(p.get(2).active).toEqual(active);}
   else {expect(input.message).toContain("Projet : d");expect(input.message).toContain("Explorer d");}
  }finally{p.close();}
  return {outcome:"completed",text:"Résultat",tokens:1,accepted:true,detail:null,retryAtMs:null};
 }});expect(calls).toBe(2);
 const p=new ForkPlanning(dir);expect(p.get(2).nextWakes).toEqual([]);p.close();
});
it("offers a planning wake without consuming or executing an occupied project's intention",async()=>{
 setForkEnabled(dir,2,true);const p=new ForkPlanning(dir);p.reassign(2,0,[wake("d")],"Préparer D");p.close();
 const lease=tryProjectLease(dir,"d")!;try{
 await runForks({dataDir:dir,workspace,profile:()=>"run",maxTurns:1,turn:async input=>{
  expect(input.message).toContain("Aucun projet réservé");return {outcome:"completed",text:"Je prépare",tokens:1,accepted:true,detail:null,retryAtMs:null};
 }});
 }finally{lease.release();}
 const after=new ForkPlanning(dir);expect(after.get(2).nextWakes[0]?.projectId).toBe("d");after.close();
});
it("adds a session-bound MCP server without replacing inherited servers",()=>{
 const config=forkPlannerConfig({id:3,dataDir:dir,planningSession:"opaque"});
 expect(Object.keys(config)).toEqual(["mcp_servers.mind_fork_planner.command","mcp_servers.mind_fork_planner.args","mcp_servers.mind_fork_planner.env"]);
 expect(config["mcp_servers.mind_fork_planner.env"]).toContain('MIND_WAKE_FORK_ID = "3"');
 expect(config["mcp_servers.mind_fork_planner.args"]).toContain("fork-planner-mcp.js");
});
