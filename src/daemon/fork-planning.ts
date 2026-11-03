import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

export interface ForkWake {
  id: string;
  projectId: string;
  objective: string;
  expected: string;
  step: number;
}
export interface ForkPlan {
  revision: number;
  initialized: boolean;
  nextWakes: ForkWake[];
  active: ForkWake | null;
  reason: string;
  updatedAt: string;
}
interface PlanRow {
  revision: number; initialized: number; queue: string; active: string | null;
  token: string | null; reason: string; updated_at: string;
}

/** Durable per-fork intentions. An active wake is immutable until its runtime ends. */
export class ForkPlanning {
  readonly db: Database.Database;
  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "fork-planning.sqlite"));
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS plans (
      fork INTEGER PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0,
      initialized INTEGER NOT NULL DEFAULT 0, queue TEXT NOT NULL DEFAULT '[]',
      active TEXT, token TEXT, reason TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
    ); CREATE TABLE IF NOT EXISTS selections(project TEXT PRIMARY KEY, fork INTEGER UNIQUE NOT NULL);`);
  }
  close(): void { this.db.close(); }
  private row(id: number): PlanRow {
    if (!Number.isInteger(id) || id < 2 || id > 8) throw Error("Fork attendu : 2 à 8");
    this.db.prepare("INSERT OR IGNORE INTO plans(fork) VALUES(?)").run(id);
    return this.db.prepare("SELECT * FROM plans WHERE fork=?").get(id) as PlanRow;
  }
  get(id: number): ForkPlan {
    const row = this.row(id);
    return { revision: row.revision, initialized: row.initialized === 1,
      nextWakes: JSON.parse(row.queue) as ForkWake[],
      active: row.active ? JSON.parse(row.active) as ForkWake : null,
      reason: row.reason, updatedAt: row.updated_at };
  }
  assertSession(id: number, token: string): void {
    if (!token || this.row(id).token !== token) throw Error("Cette session de fork n’est plus active");
  }
  selectedBy(projectId: string): number | null {
    const row = this.db.prepare("SELECT fork FROM selections WHERE project=?").get(projectId) as {fork:number}|undefined;
    return row?.fork ?? null;
  }
  private select(id: number, projectId: string | undefined): void {
    if (projectId) {
      const other = this.selectedBy(projectId);
      if (other !== null && other !== id) throw Error(`Projet réservé pour le prochain wake du fork ${other}`);
    }
    this.db.prepare("DELETE FROM selections WHERE fork=?").run(id);
    if (projectId) this.db.prepare("INSERT INTO selections(project,fork) VALUES(?,?)").run(projectId,id);
  }
  reassign(id: number, revision: number, wakes: Omit<ForkWake,"id"|"step">[], reason: string): ForkPlan {
    if (!reason.trim() || reason.length > 4000 || wakes.length > 500) throw Error("Réaffectation invalide");
    for (const wake of wakes) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(wake.projectId) || !wake.objective.trim() || !wake.expected.trim() ||
          wake.objective.length > 8000 || wake.expected.length > 8000) throw Error("Intention invalide");
    }
    return this.db.transaction(() => {
      const plan = this.get(id);
      if (plan.revision !== revision) throw Error("Planning modifié : relire get_my_wakes avant de réassigner");
      const queue = wakes.map((wake,i) => ({...wake,id:randomUUID(),step:i+1}));
      this.select(id,queue[0]?.projectId);
      this.db.prepare("UPDATE plans SET initialized=1,queue=?,reason=?,revision=revision+1,updated_at=? WHERE fork=?")
        .run(JSON.stringify(queue),reason,new Date().toISOString(),id);
      return this.get(id);
    }).immediate();
  }
  seed(id: number, wakes: Omit<ForkWake,"id"|"step">[], startStep = 1): void {
    this.db.transaction(() => {
      const plan=this.get(id);
      if (!plan.initialized) {
        const seeded=this.reassign(id,plan.revision,wakes,"Première affectation ; la suite est révisable par le fork.");
        this.db.prepare("UPDATE plans SET queue=? WHERE fork=?").run(JSON.stringify(seeded.nextWakes.map((wake,i)=>({...wake,step:startStep+i}))),id);
      }
    }).immediate();
  }
  begin(id: number, token: string, planningOnly = false): ForkWake | null {
    return this.db.transaction(() => {
      const plan=this.get(id);
      if (plan.active || this.row(id).token) throw Error("Un wake est déjà actif dans ce fork");
      const [first,...rest]=plan.nextWakes;
      const active=planningOnly ? undefined:first, queue=planningOnly ? plan.nextWakes:rest;
      // Retain this fork's first-project reservation until the turn has finished.
      this.select(id,active?.projectId);
      this.db.prepare("UPDATE plans SET active=?,queue=?,token=?,revision=revision+1 WHERE fork=?")
        .run(active ? JSON.stringify(active):null,JSON.stringify(queue),token,id);
      return active ?? null;
    }).immediate();
  }
  finish(id: number, token: string, accepted: boolean): void {
    this.db.transaction(() => {
      this.assertSession(id,token);
      const plan=this.get(id);
      const queue=!accepted && plan.active ? [plan.active,...plan.nextWakes]:plan.nextWakes;
      // A changed queue can conflict with another queued claim: wait, never overwrite it.
      const project=queue[0]?.projectId;
      const owner=project ? this.selectedBy(project):null;
      this.select(id,owner === null || owner === id ? project:undefined);
      this.db.prepare("UPDATE plans SET active=NULL,token=NULL,queue=?,revision=revision+1 WHERE fork=?")
        .run(JSON.stringify(queue),id);
    }).immediate();
  }
  recover(id: number): void {
    this.db.transaction(() => {
      const plan=this.get(id);
      if (!this.row(id).token) return;
      const queue=plan.active ? [plan.active,...plan.nextWakes]:plan.nextWakes;
      this.db.prepare("UPDATE plans SET active=NULL,token=NULL,queue=?,revision=revision+1 WHERE fork=?")
        .run(JSON.stringify(queue),id);
    }).immediate();
  }
  /** Only a worker whose process tree has ended may retire its queued reservation. */
  releaseSelection(id: number): void { this.db.prepare("DELETE FROM selections WHERE fork=?").run(id); }
}
