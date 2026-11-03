/** Read public messages from the Wake-owned Codex thread and its native descendants. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
export interface PublicActivity { id:string; at:string; text:string; kind?:'final'; source?:string; threadId?:string; }
/** Native delegation messages may be encrypted in the journal; never render the token. */
function missionText(message:string, source:string):string {
  const text=message.trim();
  const encrypted=/\bgAAAA[A-Za-z0-9_-]{40,}={0,2}/.test(text) || /^[A-Za-z0-9+/_=-]{160,}$/.test(text);
  if(!encrypted)return `Mission : ${text}`.slice(0,4000);
  const label=/^[A-Za-z0-9_.:/-]{1,120}$/.test(source) && !source.startsWith('gAAAA')
    ? source.split('/').filter(Boolean).at(-1)?.replace(/[_-]+/g,' ').trim() : null;
  return label && label!=='sous session'
    ? `Mission : ${label.charAt(0).toUpperCase()}${label.slice(1)}`
    : 'Mission confiée à une sous-session.';
}
export function parsePublicActivity(raw:string, threadId:string):PublicActivity[] {
  const result:PublicActivity[]=[];
  for(const line of raw.split('\n'))try {
    const row=JSON.parse(line),p=row.payload;
    if(row.type!=='response_item' || !p || typeof row.timestamp!=='string' || !Number.isFinite(Date.parse(row.timestamp)))continue;
    let text:string|null=null;
    const final=p.type==='message' && p.role==='assistant' && (p.channel==='final' || (p.channel==null && ['final','final_answer'].includes(p.phase)));
    if(p.type==='message' && p.role==='assistant' && (['commentary','final'].includes(p.channel) || (['commentary','final','final_answer'].includes(p.phase) && p.channel==null))) {
      text=Array.isArray(p.content)?p.content.filter((b:Record<string,unknown>)=>b?.['type']==='output_text' && typeof b['text']==='string').map((b:Record<string,string>)=>b['text']).join('\n'):null;
    } else if(['function_call','custom_tool_call'].includes(p.type) && typeof p.name==='string' && /^[A-Za-z0-9_.:-]{1,180}$/.test(p.name)) {
      // Only the explicit delegation message is public, never arbitrary tool arguments.
      if(/^(?:(?:functions|collaboration)\.)?(?:spawn_agent|followup_task)$/.test(p.name)) {
        try {
          const args=JSON.parse(p.arguments ?? p.input);
          if(typeof args.message==='string' && args.message.trim()) {
            const source=typeof args.task_name==='string'?args.task_name:typeof args.target==='string'?args.target:'sous-session';
            const digest=createHash('sha256').update(row.timestamp+'\0'+String(p.call_id ?? '')+'\0'+args.message).digest('hex').slice(0,20);
            result.push({id:`activity:${threadId}:${digest}`,at:row.timestamp,text:missionText(args.message,source),source});
            continue;
          }
        }catch{/* Not a recognized delegation payload. */}
      }
      text=`Utilise l’outil ${p.name}.`;
    }
    if(!text?.trim())continue;
    if(!final)text=text.slice(0,4000);
    const digest=createHash('sha256').update(row.timestamp+'\0'+text).digest('hex').slice(0,20);
    result.push({id:`activity:${threadId}:${digest}`,at:row.timestamp,text,...(final?{kind:'final' as const}:{})});
  }catch{/* Partial writes and all unrecognized content are ignored. */}
  return result.slice(-80);
}
interface ThreadFile { id:string; file:string; parent?:string; at:string; source:string; }
const indexes=new Map<string,{checkedAt:number;files:Map<string,ThreadFile>}>();
const UUID=/^[a-f0-9-]{36}$/;
function readPart(file:string,head:boolean):string {
  const s=fs.lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink())return '';
  const start=head?0:Math.max(0,s.size-512000),buffer=Buffer.alloc(Math.min(s.size-start,head?128000:512000)),fd=fs.openSync(file,'r');
  try{fs.readSync(fd,buffer,0,buffer.length,start);}finally{fs.closeSync(fd);}
  let raw=buffer.toString('utf8');if(start>0)raw=raw.slice(raw.indexOf('\n')+1);
  return raw;
}
function threadFiles(root:string):ThreadFile[] {
  let index=indexes.get(root);
  if(!index){index={checkedAt:0,files:new Map()};indexes.set(root,index);if(indexes.size>4)indexes.delete(indexes.keys().next().value!);}
  if(Date.now()-index.checkedAt>=5000) {
    const visit=(dir:string):void=>{
      for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
        if(entry.isSymbolicLink())continue;
        const file=path.join(dir,entry.name);
        if(entry.isDirectory()){visit(file);continue;}
        if(!entry.isFile() || !entry.name.endsWith('.jsonl') || index!.files.has(file))continue;
        try {
          const first=readPart(file,true).split('\n')[0]!;
          const row=JSON.parse(first),p=row.payload;
          if(row.type!=='session_meta' || !UUID.test(p?.id) || typeof p.timestamp!=='string' || !Number.isFinite(Date.parse(p.timestamp)))continue;
          const spawn=p.source?.subagent?.thread_spawn;
          const parent=spawn?.parent_thread_id ?? p.parent_thread_id;
          index!.files.set(file,{id:p.id,file,at:p.timestamp,...(typeof parent==='string' && UUID.test(parent)?{parent}:{}),
            source:(typeof p.agent_path==='string'?p.agent_path.split('/').at(-1):typeof spawn?.agent_path==='string'?spawn.agent_path.split('/').at(-1):typeof p.agent_nickname==='string'?p.agent_nickname:null) || p.id.slice(0,8)});
        }catch{/* Partial metadata is retried on the next scan. */}
      }
    };
    visit(root);index.checkedAt=Date.now();
  }
  return [...index.files.values()];
}
export function readPublicActivity(dataDir:string,codexHome=path.join(os.homedir(),'.codex')):PublicActivity[] {
  try {
    const dir=path.join(dataDir,'codex-threads');
    const records=fs.readdirSync(dir).filter(n=>/^thread-[a-f0-9]+\.json$/.test(n)).flatMap(n=>{
      const f=path.join(dir,n),s=fs.lstatSync(f);
      if(!s.isFile()||s.isSymbolicLink()||s.size>16000)return [];
      try{return [JSON.parse(fs.readFileSync(f,'utf8'))];}catch{return [];}
    }).filter(r=>typeof r.threadId==='string' && /^[a-f0-9-]{36}$/.test(r.threadId)).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const id=records[0]?.threadId as string|undefined;
    if(!id)return [];
    return readThreadPublicActivity(id,codexHome);
  }catch{return [];}
}
/** Read an explicitly owned fork and its descendants without including sibling threads. */
export function readThreadPublicActivity(id:string,codexHome=path.join(os.homedir(),'.codex'),excludeInherited=false):PublicActivity[] {
  if(!UUID.test(id))return [];
  try {
    const files=threadFiles(path.join(codexHome,'sessions')),owned=new Set([id]);
    // Traverse only descendants of this Wake thread, including nested delegations.
    for(let size=-1;size!==owned.size;) {
      size=owned.size;for(const f of files)if(f.parent && owned.has(f.parent))owned.add(f.id);
    }
    const result:PublicActivity[]=[];
    for(const f of files.filter(f=>owned.has(f.id)))try {
      const activity=parsePublicActivity(readPart(f.file,false),f.id);
      if(f.id===id){result.push(...(excludeInherited?activity.filter(a=>Date.parse(a.at)>=Date.parse(f.at)):activity));continue;}
      result.push({id:`activity:${f.id}:started`,at:f.at,text:'Sous-session démarrée.',source:f.source,threadId:f.id});
      // Forked journals contain parent history: never attribute it to the child.
      result.push(...activity.filter(a=>Date.parse(a.at)>=Date.parse(f.at)).map(a=>({...a,source:a.source ?? f.source,threadId:f.id})));
    }catch{/* One missing child must not hide the main thread or its siblings. */}
    return result.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-240);
  }catch{return [];}
}
