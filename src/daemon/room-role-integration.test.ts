import * as z from "zod";
import {DatabaseSync} from "node:sqlite";
import {coordinatedRoomCallServer} from "../../services/mcp/room-call-coordination.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {saveForkAssignment,roomAgentMcpConfig,resolveRoomAgents,type ForkAssignment} from "./fork-assignment.js";
import {trustedRoomRole} from "./room-role-identity.js";
import {withRoomRoleMcpApprovals} from "./room-role-mcp-approvals.js";
import {roleMandateFile,registerRoomAgentJobTools} from "../../services/mcp/room-agent-jobs.js";
import {roomVoiceLaunch,roleVoiceMayAct} from "../communication/room-voice-launch.js";
import {openStore} from "../store/index.js";
import {controlDbPath} from "./paths.js";
import {DEFAULT_PROFILE_ID,DEFAULT_AGENT_ID} from "../cli/context.js";
import {humanCallServer} from "../communication/human-call-capability.js";
import type {McpServer} from "@modelcontextprotocol/server";

let dir:string,project:string,own:string,assignment:ForkAssignment,env:Record<string,string>;
beforeEach(()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),"room-role-full-"));
  const workspace=path.join(dir,"workspace");project=path.join(workspace,"artifacts/projets/recruitment");own=path.join(project,"agents/manager");
  fs.mkdirSync(own,{recursive:true});fs.mkdirSync(path.join(project,"commun"));
  fs.writeFileSync(path.join(own,"SYSTEM.md"),"Permanent manager. Delegate scoped work.");
  fs.writeFileSync(path.join(own,"mandate.md"),"Read public fixture and report.");
  fs.writeFileSync(path.join(project,"ROOM.md"),"Room fixture");
  assignment=saveForkAssignment(path.join(dir,"forks/4"),{workspace:project,instructions:path.join(project,"ROOM.md"),engine:"claude",inbox:"explicit",agents:[{id:"manager",name:"Manager",instructions:path.join(own,"SYSTEM.md"),writable:["agents/manager","commun"],tools:"none",owner:{colony:null,profile:"publish"}}]});
  fs.writeFileSync(path.join(workspace,"artifacts/projets-compteur.json"),JSON.stringify({projects:{recruitment:{room:4,status:"en cours",capabilities:{roleTools:{agents:["manager"],nativeDelegation:true,backgroundJobs:true,mindTools:true,calls:{coordinatorAgent:"manager",minIntervalMs:300000}},webSearch:{agents:["manager"],mode:"live"}}}}}));
  env={MIND_WAKE_DATA_DIR:dir,MIND_WAKE_OWNER_FORK:"4",MIND_WAKE_OWNER_AGENT:"manager",MIND_WAKE_OWNER_SIGNATURE:"Manager",MIND_WAKE_OWNER_MESSAGES:"1",MIND_WAKE_OWNER_PROFILE:"publish"};
});
afterEach(()=>fs.rmSync(dir,{recursive:true,force:true}));

describe("room role full capability binding",()=>{
  it("binds exact host role and does not grant a spoofed name or another room",()=>{
    expect(trustedRoomRole(env,"Manager")?.capability.nativeDelegation).toBe(true);
    expect(trustedRoomRole(env,"Marco")).toBeNull();
    expect(trustedRoomRole({...env,MIND_WAKE_OWNER_FORK:"5"},"Manager")).toBeNull();
    expect(trustedRoomRole({...env,MIND_WAKE_OWNER_AGENT:"other"},"Manager")).toBeNull();
    const cfg=JSON.parse(roomAgentMcpConfig(4,dir,resolveRoomAgents(assignment)[0]!,process.execPath,path.resolve('.'))!);
    expect(cfg.mcpServers.mind.env.MIND_WAKE_OWNER_AGENT).toBe("manager");
  });
  it("preauthorizes own role mutators without overriding explicit exclusions or another MCP",()=>{
    const server={args:[path.resolve("services/mcp/fork-owner-main.ts")],env,disabled_tools:["desktop_act"],tools:{cancel_background_job:{enabled:false},call_human:{approval_mode:"ask"}}};
    const result=withRoomRoleMcpApprovals(server,dir) as {tools:Record<string,Record<string,unknown>>};
    expect(result.tools["start_background_job"]?.["approval_mode"]).toBe("approve");
    expect(result.tools["desktop_open_url"]?.["approval_mode"]).toBe("approve");
    expect(result.tools["desktop_act"]).toBeUndefined();
    expect(result.tools["cancel_background_job"]?.["enabled"]).toBe(false);
    expect(result.tools["call_human"]?.["approval_mode"]).toBe("ask");
    expect(withRoomRoleMcpApprovals({...server,args:["other-server.ts"]},dir)).toEqual({...server,args:["other-server.ts"]});
  });
  it("registers only own supervised jobs and rejects a mandate outside own scope",async()=>{
    const tools=new Map<string,{config:unknown;handler:(args:unknown,extra?:unknown)=>unknown}>();
    registerRoomAgentJobTools({registerTool:(name:string,config:unknown,handler:(args:unknown,extra?:unknown)=>unknown)=>tools.set(name,{config,handler})} as unknown as McpServer,env,"Manager");
    expect([...tools.keys()].sort()).toEqual(["cancel_background_job","list_background_jobs","start_background_job"]);
    const role=trustedRoomRole(env,"Manager")!;
    expect(roleMandateFile(role,"mandate.md")).toBe(path.join(own,"mandate.md"));
    expect(()=>roleMandateFile(role,"../../ROOM.md")).toThrow("own agent directory");
    const response=await tools.get("start_background_job")!.handler({title:"Task",mandate:"../../ROOM.md",why:"fixture",idempotency_key:"fixture-task-key"}) as {isError?:boolean};
    expect(response.isError).toBe(true);
    expect(fs.existsSync(path.join(dir,"background-jobs.sqlite"))).toBe(false);
  });
  it("uses the same role MCP, scope, web and native delegation for its exact voice context",()=>{
    const server=humanCallServer({dataDir:dir,signature:"Manager"});
    const launch=roomVoiceLaunch(dir,["--system-prompt-file","old.md","--tools","","--mcp-config",JSON.stringify({mcpServers:{mind_calls:server}}),"--allowedTools","mcp__mind_calls__call_human,mcp__mind_calls__list_active_calls,mcp__mind_calls__hangup_call"],dir);
    expect(launch.textOnly).toBe(false);expect(launch.cwd).toBe(project);expect(launch.webSearch).toBe("live");expect(launch.nativeDelegation).toBe(true);
    expect(launch.args).not.toContain("three-call-tools");
    const mcp=JSON.parse(launch.args[launch.args.indexOf("--mcp-config")+1]!);
    expect(mcp.mcpServers.mind.env).toMatchObject({MIND_WAKE_OWNER_SIGNATURE:"Manager",MIND_WAKE_OWNER_AGENT:"manager",MIND_WAKE_OWNER_FORK:"4"});
    expect(fs.readFileSync(launch.args[launch.args.indexOf("--system-prompt-file")+1]!,"utf8")).toContain("Les Apps OAuth du principal ne sont pas héritées");
    expect(roomVoiceLaunch(dir,["--tools",""],dir).textOnly).toBe(true);
  });
  it("does not widen an explicitly filtered voice MCP or noncanonical allowedTools",()=>{
    const server=humanCallServer({dataDir:dir,signature:"Manager"});
    const base=["--system-prompt-file","old.md","--tools","","--mcp-config",JSON.stringify({mcpServers:{mind_calls:{...server,disabled_tools:["desktop_act"]}}}),"--allowedTools","mcp__mind_calls__call_human,mcp__mind_calls__list_active_calls,mcp__mind_calls__hangup_call"];
    expect(roomVoiceLaunch(dir,base,dir).textOnly).toBe(true);
    const restricted=[...base];restricted[restricted.indexOf("--mcp-config")+1]=JSON.stringify({mcpServers:{mind_calls:server}});restricted[restricted.indexOf("--allowedTools")+1]="mcp__mind_calls__list_active_calls";
    expect(roomVoiceLaunch(dir,restricted,dir).textOnly).toBe(true);
  });
  it.each([{state:"paused",locked:false},{state:"running",locked:true},{state:"running",locked:false}])("keeps upgraded role actions under host stop control %s",({state,locked})=>{
    const store=openStore(controlDbPath(dir));
    store.uow.profiles.create({id:DEFAULT_PROFILE_ID,agentId:DEFAULT_AGENT_ID,state:state as never,activePolicyRevisionId:null,nextWakeAt:null,emergencyStopLocked:locked,stateReason:"fixture",updatedAt:new Date().toISOString() as never});
    store.close();
    expect(roleVoiceMayAct(dir)).toBe(state==="running"&&!locked);
  });
});

// No phone book, control profile, model or audio is used by these guard tests.
it("reserves one room attempt and suppresses concurrent or uncertain repeats",()=>{
 let attempts=0;let tool:((a:Record<string,unknown>)=>unknown)|undefined;
 const server={registerTool:(_n:string,_c:unknown,h:(a:Record<string,unknown>)=>unknown)=>{tool=h;}} as unknown as McpServer;
 const guarded=coordinatedRoomCallServer(server,env,"Manager");
 guarded.registerTool("call_human",{inputSchema:z.strictObject({})},()=>{attempts++;return {content:[{type:"text" as const,text:"queued fixture"}]};});
 const first=tool!({});expect(first).toMatchObject({content:[{text:"queued fixture"}]});
 const repeat=tool!({}) as {content:{text:string}[]};expect(JSON.parse(repeat.content[0]!.text).status).toBe("room_cooldown");expect(attempts).toBe(1);
});
it("does not ring while an app call is already active",()=>{
 const db=new DatabaseSync(path.join(dir,"mobile-call-control.sqlite"));db.exec("CREATE TABLE call_control_sessions(state TEXT,last_seen INTEGER)");db.prepare("INSERT INTO call_control_sessions VALUES('active',?)").run(Date.now());db.close();
 let attempts=0,tool:((a:Record<string,unknown>)=>unknown)|undefined;
 const server={registerTool:(_n:string,_c:unknown,h:(a:Record<string,unknown>)=>unknown)=>{tool=h;}} as unknown as McpServer;
 coordinatedRoomCallServer(server,env,"Manager").registerTool("call_human",{inputSchema:z.strictObject({})},()=>{attempts++;return {content:[]};});
 const response=tool!({}) as {content:{text:string}[]};expect(JSON.parse(response.content[0]!.text).status).toBe("existing_call");expect(attempts).toBe(0);
});
it("does not duplicate a pending NLR invitation from another caller",()=>{
 const db=new DatabaseSync(path.join(dir,"mobile-calls.sqlite"));db.exec("CREATE TABLE invitations(human TEXT,decision TEXT,until INTEGER)");db.prepare("INSERT INTO invitations VALUES('nlr',NULL,?)").run(Date.now()+45000);db.close();
 let attempts=0,tool:((a:Record<string,unknown>)=>unknown)|undefined;
 const server={registerTool:(_n:string,_c:unknown,h:(a:Record<string,unknown>)=>unknown)=>{tool=h;}} as unknown as McpServer;
 coordinatedRoomCallServer(server,env,"Manager").registerTool("call_human",{inputSchema:z.strictObject({})},()=>{attempts++;return {content:[]};});
 const response=tool!({}) as {content:{text:string}[]};expect(JSON.parse(response.content[0]!.text).status).toBe("pending_invitation");expect(attempts).toBe(0);
});

it("applies the existing room coordinator and cooldown to unified calls too",()=>{
 let attempts=0;let tool:((a:Record<string,unknown>)=>unknown)|undefined;
 const server={registerTool:(_n:string,_c:unknown,h:(a:Record<string,unknown>)=>unknown)=>{tool=h;}} as unknown as McpServer;
 coordinatedRoomCallServer(server,env,"Manager").registerTool("call",{description:"fixture"},()=>{attempts++;return {content:[{type:"text" as const,text:"queued fixture"}]};});
 const outside=tool!({target:"⬡other/vox",human:true}) as {content:{text:string}[]};
 expect(JSON.parse(outside.content[0]!.text).status).toBe("outside_project_scope");expect(attempts).toBe(0);
 expect(tool!({target:"@nlr"})).toMatchObject({content:[{text:"queued fixture"}]});
 const repeat=tool!({target:"@nlr"}) as {content:{text:string}[]};
 expect(JSON.parse(repeat.content[0]!.text).status).toBe("room_cooldown");expect(attempts).toBe(1);
});
