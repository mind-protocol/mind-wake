import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  OwnerMessages,
  OwnerMessageError,
  readOwnerMessages,
} from "../../src/communication/owner-messages.js";
import { processContext } from "../../src/cli/context.js";
import { messages as localConversation, readReplies } from "../../src/cli/commands/messages.js";
import { MAX_REPLY_CHARS } from "../../src/cli/commands/messages.js";
import { openStoreReadOnly } from "../../src/store/index.js";
import { resolvePolicy } from "../../src/policy/index.js";
import { controlDbPath } from "../../src/daemon/paths.js";
import { DEFAULT_PROFILE_ID } from "../../src/cli/context.js";

/** Explicit local owner-channel capability, independent of the inter-agent hub. */
export function registerOwnerTools(
  server: McpServer,
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (env["MIND_WAKE_OWNER_MESSAGES"] !== "1") return;
  const dir = env["MIND_WAKE_DATA_DIR"];
  const call = (name: string, fn: (store: OwnerMessages) => unknown) => {
    let messages: OwnerMessages | undefined;
    try {
      if (!dir)
        throw new OwnerMessageError("permission_denied", "Owner channel has no Wake profile.");
      const control = openStoreReadOnly(controlDbPath(dir));
      let agentId: string;
      try {
        const policy = resolvePolicy(control.uow.policies, DEFAULT_PROFILE_ID);
        if (policy.status !== "active")
          throw new OwnerMessageError("permission_denied", "No active authorized Wake policy.");
        agentId = policy.revision.groups.identity.agentId;
      } finally {
        control.close();
      }
      const dataDir = { path: dir, source: "environment" as const };
      const managed = readOwnerMessages(dir);
      const legacy =
        managed === null ? localConversation(processContext(), dataDir).data.agentNote : null;
      const replies = readReplies(dataDir);
      if (name === "list_owner_messages" && managed === null) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                schema: `mind.mcp/${name}`,
                messages:
                  legacy === null
                    ? []
                    : [
                        {
                          id: "legacy-note",
                          text: legacy.text,
                          version: Date.parse(legacy.updatedAt),
                          createdAt: legacy.updatedAt,
                          updatedAt: legacy.updatedAt,
                        },
                      ],
                replies,
              }),
            },
          ],
        };
      }
      messages = new OwnerMessages(dir, agentId);
      if (legacy !== null)
        messages.adoptLegacy(legacy.text, Date.parse(legacy.updatedAt), legacy.updatedAt);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ schema: `mind.mcp/${name}`, ...(fn(messages) as object) }),
          },
        ],
      };
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              schema: "mind.mcp/error",
              error: e instanceof OwnerMessageError ? e.code : "internal",
              message:
                e instanceof OwnerMessageError
                  ? e.message
                  : "Local owner-channel operation failed.",
            }),
          },
        ],
      };
    } finally {
      messages?.close();
    }
  };
  const id = z.union([z.literal("legacy-note"), z.string().regex(/^own_[0-9a-f-]{36}$/)]);
  const version = z.int().min(1);
  const text = z.string().trim().min(1).max(MAX_REPLY_CHARS);
  server.registerTool(
    "list_owner_messages",
    {
      description:
        "Read your local messages to your human, with stable IDs and versions. Human replies remain available through the local conversation files.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      call("list_owner_messages", (store) => ({
        messages: store.list(),
        replies: readReplies({ path: dir!, source: "environment" }),
      })),
  );
  server.registerTool(
    "message_owner",
    {
      description:
        "Publish one short message in your human's desktop conversation. Use a unique idempotency_key per message; edit that message later instead of reposting the whole history. No external delivery or automatic wake.",
      inputSchema: z.strictObject({ text, idempotency_key: z.string().min(8).max(128) }),
      annotations: { openWorldHint: false },
    },
    (args) =>
      call("message_owner", (store) => ({
        message: store.publish(args.text, args.idempotency_key),
      })),
  );
  server.registerTool(
    "edit_owner_message",
    {
      description:
        "Replace one of your messages in place by its ID and current version. Does not change human replies or create another message.",
      inputSchema: z.strictObject({ message_id: id, expected_version: version, text }),
      annotations: { openWorldHint: false },
    },
    (args) =>
      call("edit_owner_message", (store) => ({
        message: store.change(args.message_id, args.expected_version, args.text),
      })),
  );
  server.registerTool(
    "delete_owner_message",
    {
      description:
        "Remove one of your messages from the displayed conversation by ID. Human replies are kept; a local revision history is retained. Repeating deletion is safe.",
      inputSchema: z.strictObject({ message_id: id, expected_version: version }),
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    (args) =>
      call("delete_owner_message", (store) => ({
        message: store.change(args.message_id, args.expected_version, null),
      })),
  );
}
