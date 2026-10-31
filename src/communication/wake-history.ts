import { workspaceDirFor } from "../daemon/paths.js";
/** Local visible runtime conversation: actual prompts and assistant text, no reasoning blocks. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { claudeSessionUuid } from "../adapters/claude/conversation.js";
export interface WakeTurn { id: string; sessionId: string; at: string; prompt: string; promptMissing?: boolean; responses: {id:string;at:string;text:string}[]; }
export interface WakeHistory { runtime: "claude"; turns: WakeTurn[]; partial: boolean; note: string | null; }

/** Resolve the MIND prompt associated with the current persisted runtime conversation. */
export function readWakeLocations(dataDir: string): {workspace: string; systemPrompt: string | null} {
  const runtime=path.join(dataDir,"runtimes","claude");
  let systemPrompt:string|null=null;
  try {
    const {key}=JSON.parse(fs.readFileSync(path.join(runtime,"default-conversation.json"),"utf8")) as {key:string};
    const records=JSON.parse(fs.readFileSync(path.join(runtime,"conversations.json"),"utf8")) as Record<string,{promptDigest?:string}>;
    const digest=records[key]?.promptDigest;
    if(typeof digest==="string" && /^[a-f0-9]{64}$/.test(digest)) {
      const file=path.join(runtime,"prompts",`system-prompt-${digest.slice(0,16)}.md`);
      if(fs.existsSync(file)) {
        const real=fs.realpathSync(file),root=fs.realpathSync(path.join(runtime,"prompts"));
        if(path.dirname(real)===root && fs.statSync(real).isFile())systemPrompt=real;
      }
    }
  } catch { /* No generated prompt yet: expose the unavailable state explicitly. */ }
  return {workspace:workspaceDirFor(dataDir),systemPrompt};
}
export function parseWakeTranscript(raw: string, sessionId: string): WakeTurn[] {
  const turns: WakeTurn[] = [];
  const seen = new Set<string>();
  let current: WakeTurn | undefined;
  const pendingOwnerMessages = new Set<string>();
  const ensureCurrent = (at: string): WakeTurn => {
    if (!current) { current={id:`partial:${sessionId}`,sessionId,at,prompt:"",promptMissing:true,responses:[]}; turns.push(current); }
    return current;
  };
  for (const line of raw.split("\n")) {
    let row: Record<string,unknown>;
    try { row=JSON.parse(line) as Record<string,unknown>; } catch {continue;}
    if (row["isSidechain"] === true || row["parent_tool_use_id"] != null || row["type"] !== "user" && row["type"] !== "assistant") continue;
    if (row["isMeta"] === true || row["isCompactSummary"] === true || row["isVisibleInTranscriptOnly"] === true) continue;
    const message=row["message"] as {content?:unknown} | undefined;
    const c=message?.content;
    const at=typeof row["timestamp"]==="string"?row["timestamp"]:"";
    // Publishing to the owner is often the agent's actual answer, with no terminal prose.
    // Show it only after the local MCP confirms publication, never from tool input alone.
    if (Array.isArray(c)) for (const raw of c) {
      if (!raw || typeof raw!=="object") continue;
      const part=raw as Record<string,unknown>;
      if(row["type"]==="assistant" && part["type"]==="tool_use" && ["mcp__mind__message_owner","message_owner"].includes(String(part["name"])) && typeof part["id"]==="string") pendingOwnerMessages.add(part["id"]);
      if(row["type"]==="user" && part["type"]==="tool_result" && pendingOwnerMessages.has(String(part["tool_use_id"]))) {
        pendingOwnerMessages.delete(String(part["tool_use_id"]));
        if(part["is_error"]===true)continue;
        const content=part["content"];
        const texts=typeof content==="string"?[content]:Array.isArray(content)?content.flatMap(b=>b && b.type==="text" && typeof b.text==="string"?[b.text]:[]):[];
        for(const text of texts)try {
          const result=JSON.parse(text) as {schema?:string;message?:{id?:string;text?:string;createdAt?:string}};
          const published=result.message;
          if(result.schema!=="mind.mcp/message_owner" || !published || typeof published.id!=="string" || typeof published.text!=="string")continue;
          const id=`owner:${published.id}`;
          if(!seen.has(id)){seen.add(id);ensureCurrent(at).responses.push({id,at:published.createdAt ?? at,text:published.text});}
        }catch{/* A non-message tool result never becomes a visible answer. */}
      }
    }
    const text=typeof c==="string"? c : Array.isArray(c)?c.flatMap((b:unknown)=>{
      if (!b || typeof b!=="object")return [];
      const part=b as {type?:unknown;text?:unknown};
      return part.type==="text" && typeof part.text==="string"?[part.text]:[];
    }).join("\n\n"):"";
    if (!text.trim())continue;
    if(row["type"]==="user" && /^\s*<(?:local-command-caveat|command-name|local-command-stdout|task-notification|system-reminder)(?:\s|>)/.test(text))continue;
    // Claude adds a separate user entry for image-coordinate metadata; it belongs to
    // the current wake, rather than starting a new wake in the desktop selector.
    if (row["type"]==="user" && /^\[Image: original [\s\S]*\]$/.test(text.trim()) && current) {
      current.prompt += "\n\n" + text;
      continue;
    }
    const id=typeof row["uuid"]==="string"?row["uuid"]:sessionId+":"+String(turns.length)+":"+text.slice(0,40);
    if(seen.has(id))continue;seen.add(id);
    if (row["type"]==="user") {
      current={id,sessionId,at,prompt:text,responses:[]};turns.push(current);
    } else ensureCurrent(at).responses.push({id,at,text});
  }
  return turns;
}
export function readWakeHistory(dataDir: string, configDir=process.env["MIND_WAKE_CLAUDE_CONFIG_DIR"] ?? path.join(os.homedir(),".claude")): WakeHistory {
  const stateFile=path.join(dataDir,"runtimes","claude","conversations.json");
  if(!fs.existsSync(stateFile))return {runtime:"claude",turns:[],partial:false,note:"Aucun historique Claude disponible pour ce profil."};
  const records=JSON.parse(fs.readFileSync(stateFile,"utf8")) as Record<string,{key:string;generation:number}>;
  const ids=new Set(Object.values(records).filter(r=>typeof r.key==="string" && Number.isInteger(r.generation)).map(r=>claudeSessionUuid(r.key,r.generation)));
  const workspace=workspaceDirFor(dataDir).replace(/[^a-zA-Z0-9]/g,"-");
  const dir=path.join(configDir,"projects",workspace);
  if(!fs.existsSync(dir))return {runtime:"claude",turns:[],partial:false,note:"Le runtime n’a pas conservé de transcription locale accessible."};
  const files=fs.readdirSync(dir).filter(n=>n.endsWith(".jsonl") && ids.has(n.slice(0,-6))).flatMap(n=>{
    const file=path.join(dir,n),s=fs.lstatSync(file);
    return s.isFile() && !s.isSymbolicLink()?[{file,id:n.slice(0,-6),at:s.mtimeMs,size:s.size}]:[];
  }).sort((a,b)=>b.at-a.at);
  let partial=files.length>3;
  const turns:WakeTurn[]=[];
  for (const f of files.slice(0,3).reverse()) {
    const max=4*1024*1024,start=Math.max(0,f.size-max);
    const fd=fs.openSync(f.file,"r");let raw:string;
    try { const b=Buffer.alloc(f.size-start);fs.readSync(fd,b,0,b.length,start);raw=b.toString("utf8"); } finally {fs.closeSync(fd);}
    if(start>0){raw=raw.slice(raw.indexOf("\n")+1);partial=true;}
    turns.push(...parseWakeTranscript(raw,f.id));
  }
  turns.sort((a,b)=>a.at.localeCompare(b.at));
  if(turns.length>16)partial=true;
  return {runtime:"claude",turns:turns.slice(-16),partial,note:partial?"Derniers échanges disponibles ; les transcriptions plus anciennes ne sont pas chargées.":null};
}
