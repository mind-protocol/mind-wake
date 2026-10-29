/** Read only public commentary and tool names from the Wake-owned Codex thread. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
export interface PublicActivity { id:string; at:string; text:string; }
export function parsePublicActivity(raw:string, threadId:string):PublicActivity[] {
  const result:PublicActivity[]=[];
  for(const line of raw.split('\n'))try {
    const row=JSON.parse(line),p=row.payload;
    if(row.type!=='response_item' || !p || typeof row.timestamp!=='string' || !Number.isFinite(Date.parse(row.timestamp)))continue;
    let text:string|null=null;
    if(p.type==='message' && p.role==='assistant' && (p.channel==='commentary' || (p.phase==='commentary' && p.channel==null))) {
      text=Array.isArray(p.content)?p.content.filter((b:Record<string,unknown>)=>b?.['type']==='output_text' && typeof b['text']==='string').map((b:Record<string,string>)=>b['text']).join('\n'):null;
    } else if(p.type==='function_call' && typeof p.name==='string' && /^[A-Za-z0-9_.:-]{1,180}$/.test(p.name))text=`Utilise l’outil ${p.name}.`;
    if(!text?.trim())continue;
    text=text.slice(0,4000);
    const digest=createHash('sha256').update(row.timestamp+'\0'+text).digest('hex').slice(0,20);
    result.push({id:`activity:${threadId}:${digest}`,at:row.timestamp,text});
  }catch{/* Partial writes and all unrecognized content are ignored. */}
  return result.slice(-80);
}
const cachedPaths=new Map<string,string>();
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
    const root=path.join(codexHome,'sessions'),key=root+':'+id;
    let file=cachedPaths.get(key);
    if(!file){
      const name=fs.readdirSync(root,{recursive:true,encoding:'utf8'}).find(n=>typeof n==='string' && n.endsWith('-'+id+'.jsonl'));
      if(typeof name!=='string')return [];
      file=path.join(root,name);cachedPaths.set(key,file);
      if(cachedPaths.size>16)cachedPaths.delete(cachedPaths.keys().next().value!);
    }
    const s=fs.lstatSync(file);
    if(!s.isFile()||s.isSymbolicLink())return [];
    const start=Math.max(0,s.size-512000),buffer=Buffer.alloc(s.size-start),fd=fs.openSync(file,'r');
    try{fs.readSync(fd,buffer,0,buffer.length,start);}finally{fs.closeSync(fd);}
    let raw=buffer.toString('utf8');if(start>0)raw=raw.slice(raw.indexOf('\n')+1);
    return parsePublicActivity(raw,id);
  }catch{return [];}
}
