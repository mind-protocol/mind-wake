import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { BackgroundJobStore } from "../../src/daemon/background-jobs.js";
import { openStoreReadOnly } from "../../src/store/index.js";
import { controlDbPath } from "../../src/daemon/paths.js";
import { DEFAULT_PROFILE_ID } from "../../src/cli/context.js";
import { resolvePolicy } from "../../src/policy/index.js";

export function registerBackgroundTools(
  server: McpServer,
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (env["MIND_WAKE_BACKGROUND_JOBS"] !== "1") return;
  const call = (mutate: boolean, fn: (jobs: BackgroundJobStore) => unknown) => {
    let jobs: BackgroundJobStore | undefined;
    try {
      const dir = env["MIND_WAKE_DATA_DIR"];
      if (!dir) throw new Error("Missing local Wake profile");
      const control = openStoreReadOnly(controlDbPath(dir));
      try {
        const policy = resolvePolicy(control.uow.policies, DEFAULT_PROFILE_ID);
        const profile = control.uow.profiles.get(DEFAULT_PROFILE_ID);
        if (
          policy.status !== "active" ||
          policy.revision.groups.runtime.hostUnsandboxedAcknowledged !== true
        )
          throw new Error("Background jobs require the already authorized Wake host mode");
        if (
          mutate &&
          (!profile ||
            profile.emergencyStopLocked ||
            ["paused", "checkpointing", "stopped", "disabled"].includes(profile.state))
        )
          throw new Error("Wake is paused or stopped; no background job may start");
      } finally {
        control.close();
      }
      jobs = new BackgroundJobStore(dir);
      return { content: [{ type: "text" as const, text: JSON.stringify(fn(jobs)) }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          },
        ],
      };
    } finally {
      jobs?.close();
    }
  };
  server.registerTool(
    "start_background_job",
    {
      description:
        "Queue a local Node .mjs script you created under jobs/. Wake's daemon supervises it across wakes; Pause/Force-off stop its process tree. Outputs: jobs/runs/<id>/ and MIND_WAKE_JOB_OUTPUT. This does not authorize external spending, extra AI sessions or bypassing provider limits. Use idempotency_key to avoid launching duplicates. The daemon must be running.",
      inputSchema: z.strictObject({
        title: z.string().trim().min(1),
        script: z.string().min(1),
        args: z.array(z.string()).default([]),
        idempotency_key: z.string().min(8).max(128),
      }),
      annotations: { openWorldHint: false },
    },
    (a) => call(true, (s) => ({ job: s.submit(a.title, a.script, a.args, a.idempotency_key) })),
  );
  server.registerTool(
    "list_background_jobs",
    {
      description:
        "Read durable statuses and result/log paths of your supervised background jobs. A queued job has not yet started. Interrupted jobs are never silently replayed.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      call(false, (s) => ({ jobs: s.list().map((j) => ({ ...j, output: `jobs/runs/${j.id}/` })) })),
  );
  server.registerTool(
    "cancel_background_job",
    {
      description:
        "Cancel one queued or running job; the daemon terminates its full process tree. Results/logs are retained.",
      inputSchema: z.strictObject({ job_id: z.string().regex(/^job_[0-9a-f-]{36}$/) }),
      annotations: { openWorldHint: false },
    },
    (a) => call(false, (s) => ({ job: s.cancel(a.job_id) })),
  );
}
