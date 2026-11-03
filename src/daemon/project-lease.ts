import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { acquireInstanceLock, type InstanceLock } from "../scheduler/instance-lock.js";

/** A process-held lock: time passing never frees a project still being worked on. */
export function tryProjectLease(dataDir: string, projectId: string): InstanceLock | null {
  const dir = path.join(dataDir, "project-leases");
  fs.mkdirSync(dir, { recursive: true });
  const digest = createHash("sha256").update(projectId).digest("hex");
  if (fs.existsSync(path.join(dir, `${digest}.uncertain.json`))) return null;
  try {
    return acquireInstanceLock(path.join(dir, `${digest}.lock`));
  } catch (error) {
    if ((error as { code?: string }).code === "held") return null;
    throw error;
  }
}

/** A failed process-tree termination cannot silently make a project available. */
export function uncertainProjectLease(dataDir:string,projectId:string,detail:string):void {
  const dir=path.join(dataDir,"project-leases");fs.mkdirSync(dir,{recursive:true});
  const digest=createHash("sha256").update(projectId).digest("hex");
  fs.writeFileSync(path.join(dir,`${digest}.uncertain.json`),JSON.stringify({projectId,detail,at:new Date().toISOString()}));
}

/** Also recognizes the already-running Claude worker from before leases were installed. */
export function activeClaudeProject(dataDir:string):string|null {
  const file=path.join(dataDir,"second-thread.sqlite"),lock=path.join(dataDir,"second-thread.lock");
  if(!fs.existsSync(file) || !fs.existsSync(lock))return null;
  try { const probe=acquireInstanceLock(lock);probe.release();return null; }
  catch(error) { if((error as {code?:string}).code!=="held")throw error; }
  const db=new Database(file,{readonly:true,fileMustExist:true});
  try {
    const row=db.prepare("SELECT project_id,ended_at FROM turns ORDER BY n DESC LIMIT 1").get() as {project_id:string|null;ended_at:string|null}|undefined;
    return row?.ended_at===null ? row.project_id:null;
  } finally {db.close();}
}

export function projectIsLeased(dataDir: string, projectId: string): boolean {
  const lease = tryProjectLease(dataDir, projectId);
  if (!lease) return true;
  lease.release();
  return false;
}
