/** Local human broadcast. Queued means stored for a real consumer, never read. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { workspaceDirFor } from '../daemon/paths.js';
import { BackgroundJobStore } from '../daemon/background-jobs.js';
export interface BroadcastTarget { id:string; label:string; inbox?:string; reason?:string }
const alive=(pid:unknown):boolean=>{if(typeof pid!=='number'||pid<=0)return false;try{process.kill(pid,0);return true;}catch{return false;}};
export function broadcastTargets(dataDir:string):BroadcastTarget[]{
  const workspace=workspaceDirFor(dataDir), targets:BroadcastTarget[]=[{id:'owner',label:'Mon agent'}];
  const projects=path.join(workspace,'artifacts','projets');
  if(fs.existsSync(projects))for(const project of fs.readdirSync(projects)){
    const keeper=path.join(projects,project,'keeper');
    try{
      const config=JSON.parse(fs.readFileSync(path.join(keeper,'config.json'),'utf8'));
      const lock=JSON.parse(fs.readFileSync(path.join(keeper,'keeper.lock'),'utf8'));
      const state=JSON.parse(fs.readFileSync(path.join(keeper,'state.json'),'utf8'));
      if(!alive(lock.pid))continue;
      for(const [role,value] of Object.entries(config.roles??{})){
        const status=state.roles?.[role];
        if(!status||status.blocked)continue;
        const output=(value as {outputRoot?:unknown}).outputRoot;
        if(typeof output!=='string')continue;
        const relative=path.relative(workspace,output);
        if(relative.startsWith('..')||path.isAbsolute(relative))continue;
        targets.push({id:`keeper:${project}:${role}`,label:`${project} · ${role}`,inbox:path.join(output,'INBOX.jsonl')});
      }
    }catch{/* A missing or stopped keeper is not an active recipient. */}
  }
  if(fs.existsSync(path.join(dataDir,'background-jobs.sqlite'))){
    const jobs=new BackgroundJobStore(dataDir);
    try{for(const job of jobs.list())if(job.status==='running'&&!job.cancel&&job.script==='jobs/atelier-worker.mjs')
      targets.push({id:job.id,label:job.title,reason:'Session CLI sans canal de réception en cours de tour'});
    }finally{jobs.close();}
  }
  return targets;
}
export async function broadcastHuman(dataDir:string,key:string,text:string,sendOwner:()=>Promise<void>){
  if(!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)||!text.trim()||text.length>4000)throw Error('Message ou clé invalide');
  const lockFile=path.join(dataDir,'broadcast-'+createHash('sha256').update(key).digest('hex')+'.lock');
  // A concurrent retry cannot append a second copy while the owner await yields.
  if(fs.existsSync(lockFile)){
    let pid:unknown;try{pid=JSON.parse(fs.readFileSync(lockFile,'utf8')).pid;}catch{}
    if(typeof pid==='number'&&!alive(pid))fs.unlinkSync(lockFile);
  }
  let lock:number;
  try{lock=fs.openSync(lockFile,'wx');}catch{throw Error('Envoi déjà en cours ; réessayer avec le même brouillon');}
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid}));
  const db=new Database(path.join(dataDir,'human-broadcasts.sqlite'));db.pragma('busy_timeout = 5000');
  db.exec('CREATE TABLE IF NOT EXISTS broadcasts(id TEXT PRIMARY KEY,text TEXT NOT NULL,targets TEXT NOT NULL); CREATE TABLE IF NOT EXISTS deliveries(id TEXT,target TEXT,state TEXT,detail TEXT,PRIMARY KEY(id,target))');
  try{
    const targets=db.transaction(()=>{
      const prior=db.prepare('SELECT text,targets FROM broadcasts WHERE id=?').get(key) as {text:string;targets:string}|undefined;
      if(prior){if(prior.text!==text)throw Error('Clé déjà utilisée pour un autre texte');return JSON.parse(prior.targets) as BroadcastTarget[];}
      const snapshot=broadcastTargets(dataDir);db.prepare('INSERT INTO broadcasts VALUES(?,?,?)').run(key,text,JSON.stringify(snapshot));return snapshot;
    }).immediate();
    for(const target of targets){
      const prior=db.prepare('SELECT state FROM deliveries WHERE id=? AND target=?').get(key,target.id) as {state:string}|undefined;
      if(prior?.state==='queued'||prior?.state==='unavailable')continue;
      let state='queued',detail='En file ; lecture non attestée';
      try{
        if(target.reason){state='unavailable';detail=target.reason;}
        else if(target.id==='owner')await sendOwner();
        else{
          if(!broadcastTargets(dataDir).some(t=>t.id===target.id&&t.inbox===target.inbox))throw Error('Destinataire arrêté depuis la sélection');
          const id='human-'+createHash('sha256').update(key+'\0'+target.id).digest('hex');
          let lines:string[]=[];try{lines=fs.readFileSync(target.inbox!,'utf8').split(/\r?\n/).filter(Boolean);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
          const prior=lines.map(l=>{try{return JSON.parse(l);}catch{return null;}}).find(v=>v?.id===id);
          if(prior&&prior.text!==text)throw Error('Conflit de contenu');
          if(!prior)fs.appendFileSync(target.inbox!,JSON.stringify({id,at:new Date().toISOString(),author:'human',origin:'human_input',sourceHuman:key,to:target.id,text})+'\n');
        }
      }catch(e){state='failed';detail=e instanceof Error?e.message:'Échec de mise en file';}
      db.prepare('INSERT OR REPLACE INTO deliveries VALUES(?,?,?,?)').run(key,target.id,state,detail);
    }
    const deliveries=db.prepare('SELECT target,state,detail FROM deliveries WHERE id=?').all(key) as {target:string;state:string;detail:string}[];
    return {id:key,recipients:targets.map(t=>({...deliveries.find(d=>d.target===t.id),id:t.id,label:t.label})),scope:'Principal et rôles avec keeper actif. Jobs CLI sans canal signalés ; sous-agents natifs non exposés au daemon. Forks 2–8 exclus.'};
  }finally{db.close();fs.closeSync(lock);fs.unlinkSync(lockFile);}
}
