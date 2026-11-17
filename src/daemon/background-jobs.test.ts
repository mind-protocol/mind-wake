import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  BackgroundJobs,
  BackgroundJobStore,
  jobOutputDir,
  RELAUNCH_RETRY_WINDOW_MS,
} from "./background-jobs.js";
import { readOwnerMessages } from "../communication/owner-messages.js";
import { activateWorkspace } from "./workspace-config.js";
import { configureWorkspaceSync } from "./workspace-git-sync.js";
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
  "uses the selected workspace for real job cwd and results, preserving historical result paths",
  async () => {
    script("");
    const oldStore = new BackgroundJobStore(dir);
    const old = oldStore.submit("old", "jobs/test.mjs", [], "old-workspace-job");
    const oldOutput = jobOutputDir(dir, old.id);
    oldStore.close();
    const custom = path.join(dir, "custom-home");
    fs.mkdirSync(path.join(custom, "jobs"), { recursive: true });
    fs.writeFileSync(
      path.join(custom, "jobs", "selected.mjs"),
      `import fs from 'node:fs';import path from 'node:path';fs.writeFileSync(path.join(process.env.MIND_WAKE_JOB_OUTPUT,'cwd.txt'),process.cwd());`,
    );
    await configureWorkspaceSync(dir, { workspaceDir: custom, githubUrl: "", enabled: false });
    activateWorkspace(dir);
    manager = new BackgroundJobs(dir, () => true);
    manager.store.cancel(old.id);
    const job = manager.store.submit("selected", "jobs/selected.mjs", [], "selected-workspace-job");
    await manager.tick();
    const active = manager;
    await until(() => active.store.get(job.id).status === "succeeded");
    expect(fs.readFileSync(path.join(jobOutputDir(dir, job.id), "cwd.txt"), "utf8")).toBe(custom);
    expect(jobOutputDir(dir, old.id)).toBe(oldOutput);
    expect(jobOutputDir(dir, job.id)).toBe(path.join(custom, "jobs", "runs", job.id));
  },
  30_000,
);
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

it("relaunches only opted-in loops interrupted by a stop, once Wake is allowed again", async () => {
  script("setInterval(() => {}, 1000);");
  let allowed = true;
  const relaunched: string[] = [];
  manager = new BackgroundJobs(dir, () => allowed, (job) => relaunched.push(job.id));
  const loop = manager.store.submit("boucle", "jobs/test.mjs", [], "loop-key", { relaunch: true });
  const once = manager.store.submit("ponctuel", "jobs/test.mjs", ["x"], "once-key");
  await manager.tick();
  await until(() => manager?.store.get(loop.id).status === "running");
  await until(() => manager?.store.get(once.id).status === "running");
  allowed = false;
  await manager.tick();
  expect(manager.store.get(loop.id).status).toBe("interrupted");
  expect(manager.store.get(once.id).status).toBe("interrupted");
  await manager.tick();
  expect(relaunched).toEqual([]);
  allowed = true;
  await manager.tick();
  const next = manager.store.get(loop.id).relaunchedAs;
  expect(next).toBeDefined();
  expect(relaunched).toEqual([next]);
  expect(manager.store.get(once.id).relaunchedAs).toBeUndefined();
  await until(() => next !== undefined && manager?.store.get(next).status === "running");
  expect(manager.store.get(next ?? "").relaunch).toBe(true);
  await manager.tick();
  expect(manager.store.list().filter((j) => j.title === "boucle")).toHaveLength(2);
});

// ------------------------------------------------ boucles `relaunch` en échec (Simulation muette)

const T0 = Date.parse("2026-11-15T22:34:00Z");
function fail(store: BackgroundJobStore, id: string, at: number, exitCode = 1): void {
  store.update(id, {
    status: "failed",
    exitCode,
    startedAt: new Date(at - 1000).toISOString(),
    endedAt: new Date(at).toISOString(),
  });
}

it("relaunches a failed loop once its 30 s wait has elapsed, carrying the retry count", () => {
  script("");
  const store = new BackgroundJobStore(dir);
  try {
    const loop = store.submit("Simulation NLR", "jobs/test.mjs", ["a"], "sim", { relaunch: true });
    const once = store.submit("ponctuel", "jobs/test.mjs", [], "once");
    fail(store, loop.id, T0);
    fail(store, once.id, T0);
    expect(store.scheduleRetry(loop.id, T0).retryAt).toBe(new Date(T0 + 30_000).toISOString());
    expect(store.scheduleRetry(once.id, T0).retryAt).toBeUndefined();
    expect(store.relaunchFailed(T0 + 29_999)).toEqual([]);
    const [next] = store.relaunchFailed(T0 + 30_000);
    expect(next).toMatchObject({ status: "queued", relaunch: true, script: "jobs/test.mjs", args: ["a"] });
    expect(next?.autoRetries).toEqual([new Date(T0 + 30_000).toISOString()]);
    expect(store.get(loop.id).relaunchedAs).toBe(next?.id);
    expect(store.relaunchFailed(T0 + 60_000)).toEqual([]);
    expect(store.deadLoops(T0 + 3_600_000)).toEqual([]);
  } finally {
    store.close();
  }
});

it("waits 30 s, 2 min, 10 min, caps retries at 3 per hour, then stays stopped", () => {
  script("");
  const store = new BackgroundJobStore(dir);
  try {
    let job = store.submit("Simulation NLR", "jobs/test.mjs", [], "sim", { relaunch: true });
    let now = T0;
    const waits: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      fail(store, job.id, now);
      const retryAt = Date.parse(store.scheduleRetry(job.id, now).retryAt ?? "");
      waits.push(retryAt - now);
      now = retryAt;
      const [next] = store.relaunchFailed(now);
      if (!next) throw new Error("expected a relaunch");
      job = next;
      now += 1000;
    }
    expect(waits).toEqual([30_000, 120_000, 600_000]);
    fail(store, job.id, now);
    const stopped = store.scheduleRetry(job.id, now);
    expect(stopped.retriesExhausted).toBe(true);
    expect(stopped.retryAt).toBeUndefined();
    expect(store.relaunchFailed(now + RELAUNCH_RETRY_WINDOW_MS * 2)).toEqual([]);
    expect(store.list().filter((j) => j.status === "queued")).toEqual([]);
    expect(store.list()).toHaveLength(4);
    // Une heure après le premier essai, une nouvelle chaîne repart de 30 s.
    const later = store.submit("Simulation NLR", "jobs/test.mjs", [], "sim-2", {
      relaunch: true,
      autoRetries: job.autoRetries ?? [],
    });
    const after = T0 + RELAUNCH_RETRY_WINDOW_MS + 15 * 60_000;
    fail(store, later.id, after);
    expect(store.scheduleRetry(later.id, after).retryAt).toBe(new Date(after + 30_000).toISOString());
  } finally {
    store.close();
  }
});

it("never relaunches a loop after a cancellation", () => {
  script("");
  const store = new BackgroundJobStore(dir);
  try {
    const raced = store.submit("boucle", "jobs/test.mjs", [], "raced", { relaunch: true });
    store.update(raced.id, { cancel: true });
    fail(store, raced.id, T0); // annulée puis sortie en erreur avant l'arrêt confirmé
    const cancelled = store.submit("boucle", "jobs/test.mjs", ["b"], "cancelled", {
      relaunch: true,
    });
    store.cancel(cancelled.id);
    expect(store.scheduleRetry(raced.id, T0).retryAt).toBeUndefined();
    expect(store.scheduleRetry(cancelled.id, T0).retryAt).toBeUndefined();
    expect(store.relaunchFailed(T0 + RELAUNCH_RETRY_WINDOW_MS)).toEqual([]);
    expect(store.relaunchInterrupted()).toEqual([]);
    expect(store.deadLoops(T0 + 20 * 60_000)).toEqual([]);
    expect(store.list()).toHaveLength(2);
  } finally {
    store.close();
  }
});

it("posts one single-line alert per dead state in the owner's main thread", async () => {
  script("");
  let now = T0;
  const sent: { text: string; key: string }[] = [];
  manager = new BackgroundJobs(dir, () => true, undefined, {
    now: () => now,
    notify: (text, key) => sent.push({ text, key }),
  });
  const store = manager.store;
  const job = store.submit("Simulation NLR", "jobs/test.mjs", [], "sim", { relaunch: true });
  fs.mkdirSync(jobOutputDir(dir, job.id), { recursive: true });
  fs.writeFileSync(
    path.join(jobOutputDir(dir, job.id), "stderr.log"),
    "start\nError: EEXIST: file already exists, open 'runtime.lock'\n\n",
  );
  fail(store, job.id, T0);
  store.update(job.id, { retriesExhausted: true });
  await manager.tick();
  await manager.tick();
  now += 3_600_000;
  await manager.tick();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.text).not.toContain("\n");
  expect(sent[0]?.text).toContain("Simulation NLR");
  expect(sent[0]?.text).toContain("2026-11-15 22:34Z");
  expect(sent[0]?.text).toContain("EEXIST: file already exists, open 'runtime.lock'");
  expect(sent[0]?.text).toContain("relances épuisées");

  // Absente : une boucle en échec sans relance prévue (antérieure à la supervision) après 10 min.
  const old = store.submit("Présence", "jobs/test.mjs", ["p"], "presence", { relaunch: true });
  fail(store, old.id, now, 3);
  now += 9 * 60_000;
  await manager.tick();
  expect(sent).toHaveLength(1);
  now += 2 * 60_000;
  await manager.tick();
  await manager.tick();
  expect(sent).toHaveLength(2);
  expect(sent[1]?.text).toContain("Présence");
  expect(sent[1]?.text).toContain("absente");
  expect(sent[1]?.text).toContain("code de sortie 3");
  expect(new Set(sent.map((s) => s.key)).size).toBe(2);
});

it("does not alert while a retry is pending or once the same loop runs again", () => {
  script("");
  const store = new BackgroundJobStore(dir);
  try {
    const job = store.submit("Simulation NLR", "jobs/test.mjs", [], "sim", { relaunch: true });
    fail(store, job.id, T0);
    store.update(job.id, { retryAt: new Date(T0 + 3_600_000).toISOString() });
    expect(store.deadLoops(T0 + 20 * 60_000)).toEqual([]);
    // Relance en retard (Wake ne pouvait pas la faire) : la boucle reste absente, on alerte.
    store.update(job.id, { retryAt: new Date(T0 + 30_000).toISOString() });
    expect(store.deadLoops(T0 + 20 * 60_000)).toHaveLength(1);
    const manual = store.submit("Simulation NLR", "jobs/test.mjs", [], "manual", { relaunch: true });
    store.update(manual.id, { status: "running", startedAt: new Date(T0).toISOString() });
    expect(store.deadLoops(T0 + 20 * 60_000)).toEqual([]);
    // Au-delà de 24 h, un arrêt ancien n'est plus signalé.
    store.update(manual.id, { status: "succeeded" });
    expect(store.deadLoops(T0 + 25 * 3_600_000)).toEqual([]);
  } finally {
    store.close();
  }
});

it("uses the runtime notice path of the owner's main thread by default", async () => {
  script("");
  manager = new BackgroundJobs(dir, () => true, undefined, { now: () => T0 + 60_000 });
  const job = manager.store.submit("Simulation NLR", "jobs/test.mjs", [], "sim", {
    relaunch: true,
  });
  fail(manager.store, job.id, T0);
  manager.store.update(job.id, { retriesExhausted: true });
  await manager.tick();
  await manager.tick();
  const messages = readOwnerMessages(dir) ?? [];
  expect(messages).toHaveLength(1);
  expect(messages[0]?.text).toContain("Simulation NLR");
});

it.skipIf(process.platform !== "win32")(
  "really relaunches a loop whose first run hit a transient failure",
  async () => {
    script(
      `import fs from 'node:fs';import path from 'node:path';const m=path.join(process.cwd(),'jobs','seen.txt');if(!fs.existsSync(m)){fs.writeFileSync(m,'1');console.error('EEXIST runtime.lock');process.exit(1);}setInterval(()=>{},1000);`,
    );
    const relaunched: string[] = [];
    const sent: string[] = [];
    manager = new BackgroundJobs(dir, () => true, (job, after) => relaunched.push(after), {
      retryDelaysMs: [50, 50, 50],
      notify: (text) => sent.push(text),
    });
    const loop = manager.store.submit("Simulation NLR", "jobs/test.mjs", [], "sim", {
      relaunch: true,
    });
    await manager.tick();
    await until(() => manager?.store.get(loop.id).retryAt !== undefined);
    expect(manager.store.get(loop.id).status).toBe("failed");
    await new Promise((r) => setTimeout(r, 80));
    await manager.tick();
    const next = manager.store.get(loop.id).relaunchedAs ?? "";
    expect(relaunched).toEqual(["échec"]);
    await until(() => manager?.store.get(next).status === "running");
    expect(manager.store.get(next).autoRetries).toHaveLength(1);
    manager.store.cancel(next);
    await manager.tick();
    expect(manager.store.get(next).status).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 80));
    await manager.tick();
    expect(manager.store.get(next).relaunchedAs).toBeUndefined();
    expect(manager.store.list()).toHaveLength(2);
    expect(sent).toEqual([]);
  },
  30_000,
);
