import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { seedSimulatedProfile } from "../demo/harness.js";
import { stop } from "../../src/cli/commands/stop.js";
import { processContext } from "../../src/cli/context.js";
import {
  BackgroundJobs,
  BackgroundJobStore,
  jobOutputDir,
} from "../../src/daemon/background-jobs.js";
import { answerText } from "../../services/helpers/wake.js";
import { appendRepoMessage } from "../../src/communication/repo-conversations.js";
import {
  directProfile,
  executeDirectAdvice,
  queueDirectAdvice,
  readDirectThread,
  selectDirectSession,
  sessionRef,
} from "../../services/helpers/direct-advice.js";
import { refreshIndex, type IndexedSession } from "../../services/helpers/session-index.js";
vi.mock("../../services/helpers/session-index.js", () => ({ refreshIndex: vi.fn() }));
let dir: string;
let env: Record<string, string>;
let manager: BackgroundJobs | undefined;
const session: IndexedSession = {
  runtime: "claude",
  sessionId: "fixed-session",
  cwd: "C:/authorized-repo",
  file: "C:/transcript",
  updatedAt: "2026-10-29",
  mtimeMs: Date.now(),
  terms: {},
};
const input = {
  target: sessionRef(session),
  topic: "Critique directe",
  context: "Sans mots communs au corpus",
  idempotencyKey: "direct-test-001",
};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "direct-advice-test-"));
  seedSimulatedProfile(dir, { hostUnsandboxed: true });
  env = {
    MIND_WAKE_DATA_DIR: dir,
    MIND_WAKE_BACKGROUND_JOBS: "1",
    MIND_WAKE_HELPERS_DIR: path.join(dir, "helpers"),
  };
  vi.mocked(refreshIndex).mockResolvedValue({ sessions: [session], reread: 0 });
});
afterEach(async () => {
  await manager?.close();
  manager = undefined;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  vi.clearAllMocks();
});
it("keeps long answers complete by default and in the persisted thread", async () => {
  const full = "a".repeat(7000) + " final objection";
  expect(answerText(full)).toBe(full);
  expect(answerText(full, 4000)).toHaveLength(4000);
  expect(answerText(full, null)).toBe(full);
  const q = await queueDirectAdvice(env, input);
  await executeDirectAdvice(
    dir,
    { id: q.thread_id, ...input, createdAt: "now" },
    [session],
    vi.fn().mockResolvedValue({ ok: true, text: full, detail: "test" }),
  );
  expect(readDirectThread(env, q.thread_id).messages.find((m) => m.from === "repo")?.text).toBe(
    full,
  );
});
it.skipIf(process.platform !== "win32")(
  "runs the actual worker under the supervisor's stripped environment and reports target revocation in the thread",
  async () => {
    fs.mkdirSync(env["MIND_WAKE_HELPERS_DIR"]!, { recursive: true });
    fs.writeFileSync(
      path.join(env["MIND_WAKE_HELPERS_DIR"]!, "helpers.json"),
      JSON.stringify({ roots: [] }),
    );
    const q = await queueDirectAdvice(env, input);
    manager = new BackgroundJobs(dir, () => true);
    await manager.tick();
    const until = Date.now() + 12000;
    while (["queued", "running"].includes(manager.store.get(q.job_id).status)) {
      if (Date.now() > until) throw new Error("Direct worker timeout");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(manager.store.get(q.job_id).status).toBe("failed");
    const result = JSON.parse(
      fs.readFileSync(path.join(jobOutputDir(dir, q.job_id), "result.json"), "utf8"),
    );
    expect(result).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("currently authorized roots"),
    });
    expect(readDirectThread(env, q.thread_id).messages).toContainEqual(
      expect.objectContaining({
        from: "system",
        text: expect.stringContaining("Consultation échouée"),
      }),
    );
  },
  20000,
);
it.skipIf(
  process.platform !== "win32" ||
    !fs.existsSync("C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
)(
  "captures the default Codex path at submission and carries a full fake CLI answer through a stripped supervised process",
  async () => {
    const localApp = path.join(dir, "fake-localapp"),
      exe = path.join(localApp, "Programs/OpenAI/Codex/bin/codex.exe");
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    const source = path.join(dir, "FakeCodex.cs");
    fs.writeFileSync(
      source,
      'using System; using System.IO; class FakeCodex { static void Main(string[] a) { Console.In.ReadToEnd(); for(int i=0;i<a.Length-1;i++) if(a[i]=="-o") File.WriteAllText(a[i+1],new string(\'x\',7000)+" FINAL_OBJECTION"); } }',
    );
    const compiled = spawnSync(
      "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
      ["/nologo", "/out:" + exe, source],
      { windowsHide: true },
    );
    expect(compiled.status).toBe(0);
    const codexSession = { ...session, runtime: "codex" as const, cwd: dir };
    vi.mocked(refreshIndex).mockResolvedValue({ sessions: [codexSession], reread: 0 });
    const q = await queueDirectAdvice(
      { ...env, LOCALAPPDATA: localApp },
      { ...input, target: sessionRef(codexSession) },
    );
    const requestFile = path.join(dir, "direct-advice", q.thread_id + ".json");
    const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
    expect(request.cli.codexBin).toBe(exe);
    const store = new BackgroundJobStore(dir);
    store.cancel(q.job_id);
    store.close();
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const runner = path.join(dir, "workspace/jobs/provider-chain.mjs");
    fs.writeFileSync(
      runner,
      `import fs from 'node:fs'; import path from 'node:path'; import {createOfficialWaker} from ${JSON.stringify(pathToFileURL(path.join(root, "services/helpers/wake.ts")).href)}; import {executeDirectAdvice} from ${JSON.stringify(pathToFileURL(path.join(root, "services/helpers/direct-advice.ts")).href)}; const req=JSON.parse(fs.readFileSync(${JSON.stringify(requestFile)},'utf8')); const r=await executeDirectAdvice(${JSON.stringify(dir)},req,[${JSON.stringify(codexSession)}],createOfficialWaker({maxAnswerChars:null,...req.cli})); fs.writeFileSync(path.join(process.env.MIND_WAKE_JOB_OUTPUT,'result.json'),JSON.stringify(r)); if(r.status!=='answered')process.exitCode=1;`,
    );
    const launcher = path.join(dir, "workspace/jobs/provider-launch.mjs");
    const args = [
      "--experimental-transform-types",
      "--disable-warning=ExperimentalWarning",
      "--import",
      pathToFileURL(path.join(root, "test/fixtures/store-ledger/ts-hooks.ts")).href,
      runner,
    ];
    fs.writeFileSync(
      launcher,
      `import {spawn} from 'node:child_process';const c=spawn(process.execPath,${JSON.stringify(args)},{stdio:'inherit',windowsHide:true,env:process.env});c.on('exit',code=>process.exit(code??1));`,
    );
    manager = new BackgroundJobs(dir, () => true);
    const job = manager.store.submit(
      "Fake provider chain",
      "jobs/provider-launch.mjs",
      [],
      "fake-provider-chain",
    );
    await manager.tick();
    const until = Date.now() + 12000;
    while (["queued", "running"].includes(manager.store.get(job.id).status)) {
      if (Date.now() > until) throw new Error("Fake CLI chain timeout");
      await new Promise((r) => setTimeout(r, 30));
    }
    const resultPath = path.join(jobOutputDir(dir, job.id), "result.json");
    expect(
      fs.existsSync(resultPath),
      fs.readFileSync(path.join(jobOutputDir(dir, job.id), "stderr.log"), "utf8"),
    ).toBe(true);
    expect(manager.store.get(job.id).status).toBe("succeeded");
    expect(readDirectThread(env, q.thread_id).messages.find((m) => m.from === "repo")?.text).toBe(
      "x".repeat(7000) + " FINAL_OBJECTION",
    );
  },
  20000,
);
it("selects the explicit session even when no keywords match, never another target", () => {
  expect(selectDirectSession([session], input.target)).toBe(session);
  expect(() => selectDirectSession([session], "claude:other")).toThrow("unavailable");
});
it("queues immediately, deduplicates a retry, and refuses a conflicting key", async () => {
  const first = await queueDirectAdvice(env, input);
  expect(first.status).toBe("queued");
  expect(await queueDirectAdvice(env, input)).toEqual(first);
  expect(readDirectThread(env, first.thread_id)).toMatchObject({
    status: "queued",
    job_id: first.job_id,
  });
  await expect(queueDirectAdvice(env, { ...input, context: "changed" })).rejects.toThrow(
    "different target or question",
  );
  const store = new BackgroundJobStore(dir);
  try {
    expect(store.list()).toHaveLength(1);
  } finally {
    store.close();
  }
});
it("does not queue a request for an unauthorized or unavailable target", async () => {
  vi.mocked(refreshIndex).mockResolvedValue({ sessions: [], reread: 0 });
  await expect(queueDirectAdvice(env, input)).rejects.toThrow("authorized roots");
  expect(fs.existsSync(path.join(dir, "repo-conversations.jsonl"))).toBe(false);
});
it("rechecks the target before execution and does not fall back after revocation", async () => {
  const wake = vi.fn();
  await expect(
    executeDirectAdvice(
      dir,
      { id: "direct_" + "a".repeat(32), ...input, createdAt: "now" },
      [],
      wake,
    ),
  ).rejects.toThrow("authorized roots");
  expect(wake).not.toHaveBeenCalled();
});
it("stores a real text answer in the same readable conversation", async () => {
  const queued = await queueDirectAdvice(env, input);
  const request = {
    id: queued.thread_id,
    target: input.target,
    topic: input.topic,
    context: input.context,
    createdAt: "now",
  };
  const wake = vi
    .fn()
    .mockResolvedValue({ ok: true, text: "Une objection précise", detail: "test" });
  expect(await executeDirectAdvice(dir, request, [session], wake)).toMatchObject({
    status: "answered",
  });
  expect(wake.mock.calls[0]![0]).toBe(session);
  expect(readDirectThread(env, request.id)).toMatchObject({
    status: "answered",
    messages: expect.arrayContaining([
      expect.objectContaining({ from: "repo", text: "Une objection précise" }),
    ]),
  });
});
it("does not count a success flag with an empty response as answered", async () => {
  const q = await queueDirectAdvice(env, input);
  const result = await executeDirectAdvice(
    dir,
    { id: q.thread_id, ...input, createdAt: "now" },
    [session],
    vi.fn().mockResolvedValue({ ok: true, text: " ", detail: "empty" }),
  );
  expect(result.status).toBe("failed");
  expect(readDirectThread(env, q.thread_id).status).toBe("queued");
});
it("a text-free conversation remains distinct from an answer", () => {
  const id = "direct_" + "b".repeat(32);
  appendRepoMessage(dir, {
    thread: {
      id,
      repo: session.cwd,
      runtime: session.runtime,
      sessionId: session.sessionId,
      transcript: "",
    },
    message: { id: "q", at: "now", from: "wake", text: "question" },
  });
  expect(readDirectThread(env, id).status).toBe("not_queued");
  expect(() => readDirectThread(env, "../../outside")).toThrow("Invalid direct");
});
it("requires a managed authorized host and refuses mutations after stop", async () => {
  expect(() => directProfile({}, false)).toThrow("managed");
  stop(processContext(), { path: dir, source: "option" });
  await expect(queueDirectAdvice(env, input)).rejects.toThrow("paused or stopped");
  expect(directProfile(env, false)).toBe(dir);
});
