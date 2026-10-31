/** Local authenticated decision capability. Never registered on the remote MCP. */
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  PeerTasks,
  readPeerTaskPolicy,
  type LocalActor,
  type SharedTaskLink,
} from "../helpers/peer-tasks.js";
import { directProfile, queueDirectAdvice, readDirectThread } from "../helpers/direct-advice.js";
import { RemoteHubLink } from "./shared-https.js";
import { StopFlag } from "../../src/runner/controls.js";
import { taskId } from "./peer-task-protocol.js";
import { idempotencyKeySchema } from "./protocol.js";
import { peerTaskOutput } from "./peer-task-tools.js";
type Env = Readonly<Record<string, string | undefined>>;
export function registerPeerTaskLocalTools(
  server: McpServer,
  env: Env,
  actor: () => Promise<LocalActor>,
): void {
  const dir = env["MIND_WAKE_DATA_DIR"];
  if (env["MIND_WAKE_PEER_TASKS"] !== "1" || env["MIND_WAKE_BACKGROUND_JOBS"] !== "1" || !dir)
    return;
  const call = (work: (tasks: PeerTasks, local: LocalActor) => unknown) =>
    peerTaskOutput(async () => {
      const policy = readPeerTaskPolicy(dir),
        local = await actor();
      if (policy.decider.kind !== local.kind || policy.decider.ref !== local.ref)
        throw Error("Local peer task decision capability is not mapped to this actor");
      const s = fs.lstatSync(policy.sharedKeyFile);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 32768)
        throw Error("Invalid shared link key file");
      const remote = new RemoteHubLink(
        policy.sharedEndpoint,
        fs.readFileSync(policy.sharedKeyFile, "utf8").trim(),
      );
      const link: SharedTaskLink = { call: (r) => remote.call(r as never) };
      const tasks = new PeerTasks(
        dir,
        () => readPeerTaskPolicy(dir),
        link,
        { launch: (i) => queueDirectAdvice(env, i), read: (id) => readDirectThread(env, id) },
        () => {
          if (new StopFlag(dir).exists()) throw Error("Wake stopped");
          directProfile(env, true);
        },
      );
      try {
        tasks.ingest();
        return await work(tasks, local);
      } finally {
        tasks.close();
      }
    });
  server.registerTool(
    "list_peer_tasks",
    {
      description:
        "Import structured proposals from authenticated local inbox history and list durable task states. Does not launch a helper or create a wake.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => call((t) => ({ tasks: t.list() })),
  );
  server.registerTool(
    "get_peer_task",
    {
      description:
        "Read a full peer prompt, decision and locally held result; refresh a running local helper result without sharing it.",
      inputSchema: z.strictObject({ request_id: taskId }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (a) => call((t, local) => t.refresh(local, a.request_id)),
  );
  server.registerTool(
    "decide_peer_task",
    {
      description:
        "The configured LOCAL decision-maker accepts the exact prompt hash and chooses an already authorised local repo session, declines with explanation, or explicitly resumes an interrupted/uncertain attempt. No remote command or new repo access.",
      inputSchema: z.strictObject({
        request_id: taskId,
        action: z.enum(["accept", "decline", "resume"]),
        prompt_hash: z.string().regex(/^[a-f0-9]{64}$/),
        target: z.string().min(1).max(1000).optional(),
        explanation: z.string().min(1).max(4000).optional(),
        idempotency_key: idempotencyKeySchema,
      }),
      annotations: { openWorldHint: false },
    },
    (a) =>
      call((t, local) =>
        t.decide(local, {
          id: a.request_id,
          action: a.action,
          promptHash: a.prompt_hash,
          key: a.idempotency_key,
          ...(a.target === undefined ? {} : { target: a.target }),
          ...(a.explanation === undefined ? {} : { explanation: a.explanation }),
        }),
      ),
  );
  server.registerTool(
    "review_peer_task",
    {
      description:
        "Review the exact current local result: amend retains it locally and needs a later accept; accept shares only that reviewed version; relaunch starts an explicit linked attempt within the same approved target/prompt. Oversize results are never silently truncated.",
      inputSchema: z.strictObject({
        request_id: taskId,
        action: z.enum(["accept", "amend", "relaunch"]),
        result_version: z.int().min(1),
        result_hash: z.string().regex(/^[a-f0-9]{64}$/),
        text: z.string().min(1).optional(),
        idempotency_key: idempotencyKeySchema,
      }),
      annotations: { openWorldHint: true },
    },
    (a) =>
      call((t, local) =>
        t.review(local, {
          id: a.request_id,
          action: a.action,
          version: a.result_version,
          resultHash: a.result_hash,
          key: a.idempotency_key,
          ...(a.text === undefined ? {} : { text: a.text }),
        }),
      ),
  );
}
