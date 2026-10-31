import { workspaceDirFor } from "../../src/daemon/paths.js";
import fs from "node:fs";import path from "node:path";import os from "node:os";import {createHash} from "node:crypto";import {fileURLToPath,pathToFileURL} from "node:url";
import {BackgroundJobStore} from "../../src/daemon/background-jobs.js";
import {openStoreReadOnly} from "../../src/store/index.js";
import {controlDbPath} from "../../src/daemon/paths.js";
import {resolvePolicy} from "../../src/policy/index.js";
import {DEFAULT_PROFILE_ID} from "../../src/cli/context.js";
import {appendRepoMessage} from "../../src/communication/repo-conversations.js";
export interface AdviceRequest { id:string;topic:string;context:string;language:string;createdAt:string;helpersDir:string; }
export function cancelAdvice(env:Readonly<Record<string,string|undefined>>,id:string):void {
 const dir=env["MIND_WAKE_DATA_DIR"];
 if(env["MIND_WAKE_BACKGROUND_JOBS"]!=="1" || !dir || !fs.existsSync(path.join(dir,"background-jobs.sqlite")))return;
 const store=new BackgroundJobStore(dir);
 try {
  for(const job of store.list())if(job.args[1]===id && /^jobs\/mind-advice-[a-f0-9]+\.mjs$/.test(job.script) && ["queued","running"].includes(job.status))store.cancel(job.id);
 }finally{store.close();}
}
export function queueAdvice(env:Readonly<Record<string,string|undefined>>,request:Omit<AdviceRequest,"helpersDir">) {
 if(env["MIND_WAKE_BACKGROUND_JOBS"]!=="1" || !env["MIND_WAKE_DATA_DIR"])return {status:"manual" as const};
 const dataDir=env["MIND_WAKE_DATA_DIR"]!;
 const control=openStoreReadOnly(controlDbPath(dataDir));
 try {
  const policy=resolvePolicy(control.uow.policies,DEFAULT_PROFILE_ID),profile=control.uow.profiles.get(DEFAULT_PROFILE_ID);
  if(policy.status!=="active" || policy.revision.groups.runtime.hostUnsandboxedAcknowledged!==true ||
    !profile || profile.emergencyStopLocked || ["paused","checkpointing","stopped","disabled"].includes(profile.state))
   throw Error("Advice dispatch waits for an active authorized Wake profile.");
 } finally {control.close();}
 if(!/^req_[A-Za-z0-9_-]{8,64}$/.test(request.id))throw Error("Invalid request reference");
 const helpersDir=env["MIND_WAKE_HELPERS_DIR"] ?? path.join(os.homedir(),"AppData","Local","mind-wake-helpers");
 const dir=path.join(dataDir,"advice");fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,request.id+".json");
 if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify({...request,helpersDir}),{flag:"wx"});
 const repo=fileURLToPath(new URL("../../",import.meta.url));
 const worker=path.join(repo,"services/helpers/advice-worker.ts"),hooks=pathToFileURL(path.join(repo,"test/fixtures/store-ledger/ts-hooks.ts")).href;
 const script=`import {spawn} from 'node:child_process';\nconst child=spawn(process.execPath,${JSON.stringify(["--experimental-transform-types","--disable-warning=ExperimentalWarning","--import",hooks,worker])}.concat(process.argv.slice(2)),{stdio:'inherit',windowsHide:true,env:process.env});\nchild.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));\n`;
 const name="mind-advice-"+createHash("sha256").update(script).digest("hex").slice(0,16)+".mjs";
 const jobScript=path.join(workspaceDirFor(dataDir),"jobs",name);fs.mkdirSync(path.dirname(jobScript),{recursive:true});
 if(fs.existsSync(jobScript)){if(fs.readFileSync(jobScript,"utf8")!==script)throw Error("Advice launcher modified");}else fs.writeFileSync(jobScript,script,{flag:"wx"});
 appendRepoMessage(dataDir,{thread:{id:request.id,repo:"Conseils/Recherche d’un interlocuteur",runtime:"MIND",sessionId:"",transcript:""},
   message:{id:request.id+"-question",at:request.createdAt,from:"wake",text:request.topic+"\n\n"+request.context}});
 const store=new BackgroundJobStore(dataDir);
 try{const job=store.submit("Conseil : "+request.topic,"jobs/"+name,[dataDir,request.id],"advice:"+request.id);
 return {status:job.status,job_id:job.id,thread_id:request.id};}finally{store.close();}
}
