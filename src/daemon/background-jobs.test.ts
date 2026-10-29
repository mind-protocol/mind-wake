import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BackgroundJobs, BackgroundJobStore, jobOutputDir } from "./background-jobs.js";
let dir: string;
let manager: BackgroundJobs | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-bg-"));
  fs.mkdirSync(path.join(dir, "workspace", "jobs"), { recursive: true });
});
afterEach(async () => {
  await manager?.close();
  manager = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});
function script(text: string): void {
  fs.writeFileSync(path.join(dir, "workspace", "jobs", "test.mjs"), text);
}
async function until(fn: () => boolean): Promise<void> {
  const end = Date.now() + 15_000;
  while (!fn()) {
    if (Date.now() > end) throw new Error("Job condition timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}
it("deduplicates submissions, rejects conflicting keys and paths outside jobs", () => {
  script("");
  const store = new BackgroundJobStore(dir);
  try {
    const a = store.submit("test", "jobs/test.mjs", [], "same-key");
    expect(store.submit("test", "jobs/test.mjs", [], "same-key").id).toBe(a.id);
    expect(() => store.submit("other", "jobs/test.mjs", [], "same-key")).toThrow();
    fs.writeFileSync(path.join(dir, "workspace", "other.mjs"), "");
    expect(() => store.submit("bad", "jobs/../other.mjs", [], "bad-key")).toThrow();
    expect(store.cancel(a.id).status).toBe("cancelled");
  } finally {
    store.close();
  }
});
it.skipIf(process.platform !== "win32")(
  "runs real Node work between wakes, stores logs/results, announces completion once",
  async () => {
    script(
      `import fs from 'node:fs';import path from 'node:path';console.log('hello');console.error('diagnostic');setTimeout(()=>fs.writeFileSync(path.join(process.env.MIND_WAKE_JOB_OUTPUT,'result.txt'),process.argv[2]),200);`,
    );
    manager = new BackgroundJobs(dir, () => true);
    const job = manager.store.submit("render", "jobs/test.mjs", ["done"], "job-test-01");
    await manager.tick();
    await until(() => manager!.store.get(job.id).status === "succeeded");
    const output = jobOutputDir(dir, job.id);
    expect(fs.readFileSync(path.join(output, "result.txt"), "utf8")).toBe("done");
    expect(fs.readFileSync(path.join(output, "stdout.log"), "utf8")).toContain("hello");
    expect(fs.readFileSync(path.join(output, "stderr.log"), "utf8")).toContain("diagnostic");
    expect(manager.store.events(true)).toHaveLength(1);
    expect(manager.store.events()).toEqual([]);
    const other = new BackgroundJobStore(dir);
    try {
      expect(other.get(job.id).status).toBe("succeeded");
    } finally {
      other.close();
    }
  },
  30_000,
);
it.skipIf(process.platform !== "win32")(
  "pause kills parent and grandchild; queued tasks wait and never silently restart interrupted work",
  async () => {
    script(
      `import {spawn} from 'node:child_process';import fs from 'node:fs';import path from 'node:path';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(path.join(process.env.MIND_WAKE_JOB_OUTPUT,'pid.txt'),String(c.pid));setInterval(()=>{},1000);`,
    );
    let allowed = true;
    manager = new BackgroundJobs(dir, () => allowed);
    const job = manager.store.submit("long", "jobs/test.mjs", [], "job-test-02");
    await manager.tick();
    const pidfile = path.join(jobOutputDir(dir, job.id), "pid.txt");
    await until(() => fs.existsSync(pidfile));
    const pid = Number(fs.readFileSync(pidfile, "utf8"));
    allowed = false;
    await manager.tick();
    expect(manager.store.get(job.id).status).toBe("interrupted");
    expect(() => process.kill(pid, 0)).toThrow();
    allowed = true;
    await manager.tick();
    expect(manager.running.size).toBe(0);
  },
  30_000,
);
it.skipIf(process.platform !== "win32")(
  "reports failure and cancels running jobs without losing their logs",
  async () => {
    script(`console.error('intentional failure');process.exitCode=7;`);
    manager = new BackgroundJobs(dir, () => true);
    const failed = manager.store.submit("failure", "jobs/test.mjs", [], "job-test-03");
    await manager.tick();
    await until(() => manager!.store.get(failed.id).status === "failed");
    expect(manager.store.get(failed.id).exitCode).toBe(7);
    script(`setInterval(()=>{},1000);`);
    const cancel = manager.store.submit("cancel", "jobs/test.mjs", [], "job-test-04");
    await manager.tick();
    await until(() => manager!.store.get(cancel.id).status === "running");
    manager.store.cancel(cancel.id);
    await manager.tick();
    expect(manager.store.get(cancel.id).status).toBe("cancelled");
  },
  30_000,
);
