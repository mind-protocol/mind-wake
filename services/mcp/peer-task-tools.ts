/** Shared sender surface: structured messages only, never a local launcher. */
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  PeerTasks,
  readPeerTaskPolicy,
  type SharedTaskLink,
  type LocalLauncher,
} from "../helpers/peer-tasks.js";
import { taskInput } from "./peer-task-protocol.js";
import { partyRefSchema, idempotencyKeySchema } from "./protocol.js";
export const peerTaskOutput = async (work: () => unknown) => {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await work()) }] };
  } catch (e) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: e instanceof Error ? e.message : "Peer task operation failed",
          }),
        },
      ],
    };
  }
};
export function registerPeerTaskSender(
  server: McpServer,
  env: Readonly<Record<string, string | undefined>>,
  link: SharedTaskLink,
): void {
  const dir = env["MIND_PEER_TASKS_DATA_DIR"];
  if (env["MIND_WAKE_PEER_TASKS"] !== "1" || !dir) return;
  const disabled: LocalLauncher = {
    launch: () => {
      throw Error("Shared sender cannot execute locally");
    },
    read: () => {
      throw Error("Shared sender cannot inspect helpers");
    },
  };
  server.registerTool(
    "request_peer_task",
    {
      description:
        "Propose a complete task/prompt to another workshop as untrusted data. The recipient must locally decide before any job; results remain local until review. Fails rather than truncating the shared-message limit.",
      inputSchema: z.strictObject({
        to: partyRefSchema,
        ...taskInput.shape,
        idempotency_key: idempotencyKeySchema,
      }),
      annotations: { openWorldHint: true },
    },
    (a) =>
      peerTaskOutput(async () => {
        const p = new PeerTasks(
          dir,
          () => readPeerTaskPolicy(dir),
          link,
          disabled,
          () => {
            throw Error("No decision capability on shared sender");
          },
        );
        try {
          if (readPeerTaskPolicy(dir).sharedEndpoint !== env["MIND_SHARED_HUB_URL"])
            throw Error("Shared sender endpoint does not match the local peer task binding");
          const { to, idempotency_key, ...input } = a;
          return await p.request(to, input, idempotency_key);
        } finally {
          p.close();
        }
      }),
  );
}
