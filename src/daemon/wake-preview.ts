import fs from "node:fs";
import { WakeManager, managerFile, WAKE_DAY, WAKE_BLOCK, stepsForWake, type WakeSlot } from "./wake-manager.js";

export interface PreviewWake extends WakeSlot {
  objective: string | null;
  expected: string | null;
  state: "planned" | "reserved" | "running";
}
export interface WakePreview {
  revision?: number;
  state: "ready" | "disabled" | "unavailable";
  dayLength: number;
  blockLength: number;
  completed: number;
  wakes: PreviewWake[];
}

/** Display only: never create a manager, reserve a session or modify its counters. */
export function readWakePreview(workspace: string, count = 500): WakePreview {
  const empty: WakePreview = { state: "unavailable", dayLength: WAKE_DAY, blockLength: WAKE_BLOCK, completed: 0, wakes: [] };
  if (!fs.existsSync(managerFile(workspace))) return empty;
  let manager: WakeManager | undefined;
  try {
    manager = new WakeManager(workspace, { readOnly: true });
    const reader = manager;
    return reader.db.transaction(() => {
      const state = reader.status();
      if (!state) return empty;
      if (!state.enabled) return { ...empty, state: "disabled" as const, completed: state.used };
      const pending = reader.pending();
      const preview = reader.next(count);
      // next() reconciles the registry in memory; use the same project reader for plans.
      const projects = new Map(state.projects.map(project => [project.id, project]));
      const wakes = preview.wakes.map(wake => {
        const step = stepsForWake(state, wake, wake.projectId ? projects.get(wake.projectId) : undefined).find(item => item.wake === wake.inBlock);
        return { ...wake, objective: step?.objective.slice(0, 500) ?? null, expected: step?.expected.slice(0, 500) ?? null,
          state: wake.sessionId && wake.sessionId === pending?.sessionId ? (pending.started ? "running" as const : "reserved" as const) : "planned" as const };
      });
      return { ...empty, state: "ready" as const, completed: state.used, revision: state.revision, wakes };
    })();
  } catch {
    return empty;
  } finally {
    manager?.close();
  }
}

/** Read saved intentions for one thread's own current project, without advancing rotation. */
export function readProjectWakeObjectives(workspace:string, projectId:string|null, inBlock:number, passageId?:string) {
  if(!projectId || !fs.existsSync(managerFile(workspace)))return null;
  let manager:WakeManager|undefined;
  try {
    manager=new WakeManager(workspace,{readOnly:true});
    const state=manager.status(),project=state?.projects.find(p=>p.id===projectId);
    if(!state || !project)return null;
    const passage=passageId ? state.passages?.[passageId] : undefined;
    const steps=passageId ? (passage?.projectId===projectId ? passage.steps ?? [] : []) : project.plan;
    return {projectId,title:project.title,inBlock, ...(passageId?{passageId}:{}),
      wakes:Array.from({length:10},(_,i)=>{const step=steps.find(s=>s.wake===i+1);return {wake:i+1,objective:step?.objective.trim() || null,expected:step?.expected.trim() || null};})};
  }catch{return null;}finally{manager?.close();}
}
