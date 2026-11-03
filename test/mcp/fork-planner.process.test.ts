import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {expect,it} from "vitest";
import {NODE_ARGS} from "./harness.js";
import {seedSimulatedProfile,PROFILE} from "../demo/harness.js";
import {ForkPlanning} from "../../src/daemon/fork-planning.js";
import {setForkEnabled} from "../../src/daemon/forks.js";
import {controlDbPath,workspaceDirFor} from "../../src/daemon/paths.js";
import {openStore} from "../../src/store/index.js";
import type {UtcTimestamp} from "../../src/contracts/index.js";

it("uses real MCP stdio to revise only the bound fork, rejecting conflicts, stale revisions, old sessions and Pause",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"fork-planner-mcp-"));
 const clients:Client[]=[];
 const p=new ForkPlanning(dir);
 const wake=(projectId:string)=>({projectId,objective:"Explorer",expected:"Preuve"});
 try {
  seedSimulatedProfile(dir);
  const artifacts=path.join(workspaceDirFor(dir),"artifacts");fs.mkdirSync(artifacts,{recursive:true});
  fs.writeFileSync(path.join(artifacts,"projets-compteur.json"),JSON.stringify({current:"a",projects:{a:{status:"en cours"},b:{status:"en cours"},c:{status:"en cours"},d:{status:"en cours"}}}));
  for(const id of [2,3]){setForkEnabled(dir,id,true);p.seed(id,[wake(id===2?"b":"c")]);p.begin(id,`session-${id}`);}
  const connect=async(id:number,token=`session-${id}`)=>{
   const env=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined));
   const client=new Client({name:"fork-planner-test",version:"1"});clients.push(client);
   await client.connect(new StdioClientTransport({command:process.execPath,args:[...NODE_ARGS,path.resolve("src/daemon/fork-planner-mcp.ts")],env:{...env,MIND_WAKE_DATA_DIR:dir,MIND_WAKE_FORK_ID:String(id),MIND_WAKE_FORK_SESSION:token},stderr:"pipe"}));return client;
  };
  const call=async(client:Client,name:string,args:Record<string,unknown>={})=>{
   const result=await client.callTool({name,arguments:args});const first=(result.content as {text?:string}[])[0];
   return {error:result.isError===true,data:JSON.parse(first?.text ?? "{}") as {fork:number;revision:number;active:{projectId:string};nextWakes:{projectId:string}[]}};
  };
  const two=await connect(2),three=await connect(3);
  expect((await two.listTools()).tools.map(t=>t.name).sort()).toEqual(["claim_project","get_my_wakes","reassign_my_wakes"]);
  const before=await call(two,"get_my_wakes");expect(before.data.fork).toBe(2);expect(before.data.active.projectId).toBe("b");
  const replacement={expected_revision:before.data.revision,reason:"Suivre la découverte D",wakes:[{project_id:"d",objective:"Nouvelle piste",expected:"Résultat D"}]};
  const changed=await call(two,"reassign_my_wakes",replacement);expect(changed.error).toBe(false);
  expect(changed.data.active.projectId).toBe("b");expect(p.get(2).nextWakes[0]?.projectId).toBe("d");expect(p.get(3).active?.projectId).toBe("c");
  expect((await call(two,"reassign_my_wakes",replacement)).error).toBe(true);
  const third=await call(three,"get_my_wakes");
  const claim={project_id:"d",objective:"D pour trois",expected:"Preuve",reason:"Choisir D",expected_revision:third.data.revision};
  expect((await call(three,"claim_project",claim)).error).toBe(true);
  expect((await call(two,"reassign_my_wakes",{expected_revision:changed.data.revision,reason:"Libérer la suite",wakes:[]})).error).toBe(false);
  expect((await call(three,"claim_project",claim)).error).toBe(false);
  const forged=await connect(3,"session-2");expect((await call(forged,"get_my_wakes")).error).toBe(true);
  const control=openStore(controlDbPath(dir));try{control.uow.profiles.transition(PROFILE,{from:"ready",to:"paused",reason:"Pause humaine",at:new Date().toISOString() as UtcTimestamp});}finally{control.close();}
  const paused=await call(three,"get_my_wakes");expect(paused.error).toBe(false);
  expect((await call(three,"reassign_my_wakes",{expected_revision:paused.data.revision,reason:"Pendant pause",wakes:[]})).error).toBe(true);
 }finally{for(const client of clients)await client.close();p.close();fs.rmSync(dir,{recursive:true,force:true});}
},20000);
