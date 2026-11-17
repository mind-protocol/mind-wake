import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openRepairQueue, type AppErrorReport } from "../communication/app-error-relay.js";
import { runClaudeTurn, secondThreadClaude } from "./second-thread.js";

interface Incident {
  id: string;
  report: string;
  occurrences: number;
}

/** Owned by the singleton daemon. In-flight incidents stay pending across a crash. */
export class RepairAgent {
  private timer?: ReturnType<typeof setInterval>;
  private active: Promise<void> | undefined;
  private closed = false;
  private nextTurn = 0;

  constructor(
    private readonly dataDir: string,
    private readonly allowed: () => boolean,
    private readonly log: (message: string) => void,
    private readonly turn = runClaudeTurn,
  ) {}

  start(): void {
    const poll = () => {
      if (this.closed || this.active || Date.now() < this.nextTurn) return;
      this.active = this.processBatch().catch(error => {
        this.log(`Réparateur : ${String(error)}`);
        this.nextTurn = Date.now() + 60_000;
      }).finally(() => { this.active = undefined; });
    };
    this.timer = setInterval(poll, 5000);
    poll();
  }

  async processBatch(): Promise<void> {
    if (!fs.existsSync(path.join(this.dataDir, "repair-incidents.sqlite")) || !this.allowed()) return;
    const db = openRepairQueue(this.dataDir);
    try {
      const rows = db.prepare("SELECT id, report, occurrences FROM incidents WHERE pending = 1 AND next_attempt <= ? ORDER BY rowid LIMIT 8")
        .all(Date.now()) as Incident[];
      if (!rows.length) return;
      this.nextTurn = Date.now() + 60_000;
      const session = randomUUID();
      this.log(`Réparateur : ouverture du tour ${session} pour ${rows.length} incident(s).`);
      const result = await this.turn({
        dataDir: this.dataDir,
        workspace: fileURLToPath(new URL("../../", import.meta.url)),
        promptFile: fileURLToPath(new URL("../../docs/agent-reparateur.md", import.meta.url)),
        claude: secondThreadClaude(),
        session: { id: session, mode: "new" },
        control: () => !this.closed && this.allowed() ? "run" : "stop",
        maxMs: 600_000,
        message: JSON.stringify(rows.map(row => ({
          id: row.id, occurrences: row.occurrences, diagnostic: JSON.parse(row.report) as AppErrorReport,
        }))),
      });
      const completed = result.outcome === "completed";
      const retry = Math.max(Date.now() + 5 * 60_000, result.retryAtMs ?? 0);
      const record = db.prepare("UPDATE incidents SET pending = ?, result = ?, next_attempt = ? WHERE id = ?");
      db.transaction(() => {
        for (const row of rows) record.run(completed ? 0 : 1, result.text || result.detail, retry, row.id);
      })();
      this.log(`Réparateur : tour ${session} terminé (${result.outcome}).`);
    } finally { db.close(); }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.active;
  }
}
