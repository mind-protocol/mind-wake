import fs from "node:fs";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import type {McpServer} from "@modelcontextprotocol/server";
import {trustedRoomRole} from "../../src/daemon/room-role-identity.js";

const result=(status:string,detail:string)=>({content:[{type:"text",text:JSON.stringify({schema:"mind.room.call.coordination.v1",status,detail,invitationCreated:false})}]});
/** A single explicit room coordinator; reserve an attempt before calling to avoid uncertain duplicate invites. */
export function coordinatedRoomCallServer(server:McpServer,env:Readonly<Record<string,string|undefined>>,signature:string):McpServer {
  const role=trustedRoomRole(env,signature),dir=env["MIND_WAKE_DATA_DIR"],policy=role?.capability.calls;
  if(!role||!dir||!policy)return server;
  const raw=server.registerTool as unknown as (...args:unknown[])=>unknown;
  const register=((name:string,config:Record<string,unknown>,handler:(args:Record<string,unknown>,extra:unknown)=>unknown)=>{
    if(name!=="call_human")return raw.call(server,name,config,handler);
    return raw.call(server,name,{...config,description:String(config["description"]??"")+" This room has one canonical coordinator and a five-minute minimum between attempts. If an app call is active, post the useful update there instead of ringing."},(args:Record<string,unknown>,extra:unknown)=>{
      const current=trustedRoomRole(env,signature),now=Date.now();
      if(!current?.capability.calls)return result("authorization_changed","No invitation was submitted.");
      if(current.agent.id!==current.capability.calls.coordinatorAgent)return result("room_coordinator",`Send this useful update to @${current.capability.calls.coordinatorAgent}; only that role rings for the room.`);
      const handle=String(args["handle"]??"nlr").trim().toLowerCase().replace(/^@/,"");
      if(!["nlr","nlr-ai"].includes(handle))return result("outside_project_scope","This project calls NLR only.");
      const active=path.join(dir,"mobile-call-control.sqlite");
      if(fs.existsSync(active)){
        const calls=new DatabaseSync(active,{readOnly:true});
        try{const row=calls.prepare("SELECT COUNT(*) AS n FROM call_control_sessions WHERE state='active' AND last_seen>?").get(now-120_000);if(Number(row?.["n"]??0)>0)return result("existing_call","An app call is active; deliver the room update in that call, without another invitation.");}
        finally{calls.close();}
      }
      const pending=path.join(dir,"mobile-calls.sqlite");
      if(fs.existsSync(pending)){
        const invitations=new DatabaseSync(pending,{readOnly:true});
        try{const row=invitations.prepare("SELECT COUNT(*) AS n FROM invitations WHERE human='nlr' AND decision IS NULL AND until>?").get(now);if(Number(row?.["n"]??0)>0)return result("pending_invitation","An invitation for NLR is already pending; no second invitation or uncertain retry.");}
        finally{invitations.close();}
      }
      const folder=path.join(dir,"forks",String(current.room));fs.mkdirSync(folder,{recursive:true});
      const db=new DatabaseSync(path.join(folder,"call-coordination.sqlite"));
      try{
        db.exec("PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY CHECK(id=1),at INTEGER NOT NULL,agent TEXT NOT NULL);BEGIN IMMEDIATE");
        const previous=db.prepare("SELECT at FROM attempts WHERE id=1").get();
        if(previous&&now-Number(previous["at"])<current.capability.calls.minIntervalMs){db.exec("ROLLBACK");return result("room_cooldown","A room attempt was already reserved recently; no uncertain retry.");}
        db.prepare("INSERT INTO attempts VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at,agent=excluded.agent").run(now,current.agent.id);
        db.exec("COMMIT");
      }catch(error){try{db.exec("ROLLBACK");}catch{/* no transaction */}throw error;}finally{db.close();}
      return handler(args,extra);
    });
  }) as unknown as McpServer["registerTool"];
  return new Proxy(server,{get:(target,key,receiver)=>key==="registerTool"?register:Reflect.get(target,key,receiver)});
}
