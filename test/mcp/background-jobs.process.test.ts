import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { startHarness, type Harness } from "./harness.js";
import { seedSimulatedProfile } from "../demo/harness.js";
import { BackgroundJobs } from "../../src/daemon/background-jobs.js";
import { stop } from "../../src/cli/commands/stop.js";
import { processContext } from "../../src/cli/context.js";
let h: Harness | undefined;
let jobs: BackgroundJobs | undefined;
afterEach(async () => {
  await jobs?.close();
  jobs = undefined;
  await h?.close();
  h = undefined;
});
it.skipIf(process.platform !== "win32")(
  "actual MCP tools queue real supervised work and preserve results",
  async () => {
    h = await startHarness();
    const dir = path.join(h.dir, "wake-jobs");
    fs.mkdirSync(dir);
    seedSimulatedProfile(dir, { hostUnsandboxed: true });
    fs.mkdirSync(path.join(dir, "workspace", "jobs"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "workspace", "jobs", "demo.mjs"),
      "console.log('MCP job complete');",
    );
    const client = await h.party("agent", {
      MIND_WAKE_DATA_DIR: dir,
      MIND_WAKE_BACKGROUND_JOBS: "1",
    });
    const result = await client.call("start_background_job", {
      title: "demo",
      script: "jobs/demo.mjs",
      args: [],
      idempotency_key: "mcp-job-demo-1",
    });
    expect(result.isError).toBe(false);
    const job = result.data["job"] as { id: string; status: string };
    expect(job.status).toBe("queued");
    jobs = new BackgroundJobs(dir, () => true);
    await jobs.tick();
    const end = Date.now() + 10_000;
    while (jobs.store.get(job.id).status !== "succeeded") {
      if (Date.now() > end) throw new Error("MCP job timed out");
      await new Promise((r) => setTimeout(r, 30));
    }
    const list = await client.call("list_background_jobs");
    expect((list.data["jobs"] as { id: string; status: string }[])[0]).toMatchObject({
      id: job.id,
      status: "succeeded",
    });
    fs.writeFileSync(path.join(dir, "workspace", "jobs", "long.mjs"), "setInterval(()=>{},1000);");
    const long = jobs.store.submit("stop test", "jobs/long.mjs", [], "mcp-long-stop-01");
    await jobs.tick();
    while (jobs.store.get(long.id).status !== "running")
      await new Promise((r) => setTimeout(r, 20));
    const stopped = stop(processContext(), { path: dir, source: "option" });
    expect(stopped.data.terminations).toContainEqual(
      expect.objectContaining({ sessionId: long.id, confirmed: true }),
    );
    expect(jobs.store.get(long.id).status).toBe("interrupted");
    const refused = await client.call("start_background_job", {
      title: "after stop",
      script: "jobs/demo.mjs",
      args: [],
      idempotency_key: "after-stop-test",
    });
    expect(refused.isError).toBe(true);
  },
  30_000,
);
