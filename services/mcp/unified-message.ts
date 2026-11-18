import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { deliverLocalMessage } from "../../src/communication/local-message.js";
import { externalInboxSyncAllowed } from "../../src/communication/external-inbox-policy.js";
import {
  readSettings,
  resolveFromDisk,
  enqueueRequest,
  awaitResult,
  serviceAlive,
  messageStatus,
} from "../pont-p2p/state.mjs";

const recipient = z.string().trim().min(1).max(100);
const toast = z.strictObject({
  text: z.string().trim().min(1).max(240),
  duration_ms: z.int().min(3000).max(30000).optional(),
});
type OwnerInput = {
  text: string;
  idempotency_key: string;
  toast?: { text: string; duration_ms?: number };
};
export function registerUnifiedMessage(
  server: McpServer,
  env: Readonly<Record<string, string | undefined>>,
  owner: (a: OwnerInput) => unknown,
) {
  const dir = env["MIND_WAKE_DATA_DIR"];
  if (!dir) return;
  const author = env["MIND_WAKE_MESSAGE_SIGNATURE"] ?? "Principal";
  server.registerTool(
    "message",
    {
      description:
        "Send one punctual message to one or several recipients: @nlr (local human), an agent handle, room3, or ⬡colony/agent. Use to as a string or array. Each destination receives a separate delivery; this does not create a lasting conversation space. Use call for that. Author comes from your runtime. Reuse idempotency_key for retries. Remote pending is not delivered; follow colony_status using its id.",
      inputSchema: z.strictObject({
        to: z.union([recipient, z.array(recipient).min(1).max(32)]),
        text: z.string().trim().min(1).max(4000),
        idempotency_key: z.string().regex(/^[A-Za-z0-9_.:-]{8,100}$/),
        toast: toast.optional(),
      }),
    },
    async (a) => {
      const results: Record<string, unknown>[] = [];
      for (const to of [
        ...new Set((Array.isArray(a.to) ? a.to : [a.to]).map((t) => t.toLowerCase())),
      ]) {
        try {
          if (!externalInboxSyncAllowed(dir)) throw Error("Wake est en pause ou arrêté.");
          const key = createHash("sha256")
            .update(JSON.stringify([author, to, a.idempotency_key]))
            .digest("hex");
          if (["@nlr", "nlr", "user:nlr", "human", "user"].includes(to)) {
            const response = (await owner({
              text: a.text,
              idempotency_key: key,
              ...(a.toast
                ? {
                    toast: {
                      text: a.toast.text,
                      ...(a.toast.duration_ms === undefined
                        ? {}
                        : { duration_ms: a.toast.duration_ms }),
                    },
                  }
                : {}),
            })) as { isError?: boolean; content: { text: string }[] };
            results.push({
              to,
              status: response.isError ? "failed" : "recorded",
              result: JSON.parse(response.content[0]?.text ?? "{}") as unknown,
            });
          } else if (to.startsWith("⬡")) {
            if (!readSettings(dir).enabled) throw Error("Pont pair-à-pair désactivé.");
            const resolved = resolveFromDisk(dir, to);
            if (!resolved.ok) throw Error(String(resolved["reason"]));
            const id = "m" + key.slice(0, 16);
            const old = messageStatus(dir, id);
            if (old.ok) {
              results.push({
                ...old,
                to,
                id,
                status:
                  old["status"] === "échec"
                    ? "failed"
                    : old["status"] === "livré"
                      ? "delivered"
                      : "pending",
              });
              continue;
            }
            const rid = enqueueRequest(dir, {
              op: "send",
              id,
              to,
              body: `${author} : ${a.text}`,
              kind: "message",
            });
            const r = serviceAlive(dir) ? await awaitResult(dir, rid, 5000) : null;
            const sent = r?.["message"] as Record<string, unknown> | undefined;
            results.push({
              to,
              id,
              status:
                r?.["ok"] === false || sent?.["status"] === "échec"
                  ? "failed"
                  : sent?.["status"] === "livré"
                    ? "delivered"
                    : "pending",
              result: r,
            });
          } else {
            results.push({ to, ...deliverLocalMessage(dir, { to, text: a.text, author, key }) });
          }
        } catch (error) {
          results.push({
            to,
            status: "failed",
            error: error instanceof Error ? error.message : "message_failed",
          });
        }
      }
      return {
        isError: results.some((r) => r["status"] === "failed"),
        content: [
          { type: "text" as const, text: JSON.stringify({ schema: "mind.message.v1", results }) },
        ],
      };
    },
  );
}
