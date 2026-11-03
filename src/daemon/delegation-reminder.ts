import fs from "node:fs";
import path from "node:path";

type Row = Record<string, unknown>;
const row = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : undefined;

export const DELEGATION_REMINDER =
  "END-OF-RESPONSE REMINDER — No subsession launch or resumption was verified during this turn. Delegate development and specific execution work to subsessions. Keep the conversation with NLR, vision, choices and planning here. If concrete work needs to advance, launch or resume a suitable subsession with a precise assignment. A simple conversation does not require inventing a task to delegate. This reminder does not trigger another reminder; human messages, Pause and Force-off retain priority.";

/** Installation-local opt-in. Missing or malformed data never enables an extra turn. */
export function delegationReminderEnabled(workspace: string): boolean {
  try {
    const file = path.join(workspace, "artifacts", "delegation-reminder.json");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return false;
    const value = row(JSON.parse(fs.readFileSync(file, "utf8")));
    return value?.["version"] === 1 && value["enabled"] === true;
  } catch {
    return false;
  }
}

function repoAccepted(value: unknown): boolean {
  const result = row(value);
  if (!result || result["isError"] === true || result["error"]) return false;
  let data = row(result["structuredContent"]) ?? result;
  if (Array.isArray(result["content"]))
    for (const block of result["content"]) {
      const text = row(block)?.["text"];
      if (typeof text === "string")
        try {
          data = row(JSON.parse(text)) ?? data;
        } catch {
          /* not evidence */
        }
    }
  return typeof data["thread_id"] === "string" && typeof data["job_id"] === "string";
}

/** Only runtime tool events count; assistant prose and waits are not launches. */
export class DelegationEvidence {
  accepted = false;
  private claudeCalls = new Map<string, string>();
  codex(value: unknown, principalThreadId: string | null): void {
    const event = row(value);
    if (!event) return;
    if (
      event["type"] === "collabAgentToolCall" &&
      event["status"] === "completed" &&
      event["senderThreadId"] === principalThreadId &&
      ["spawnAgent", "followupTask", "resumeAgent", "sendMessage"].includes(
        String(event["tool"]),
      ) &&
      Array.isArray(event["receiverThreadIds"]) &&
      event["receiverThreadIds"].some((id) => typeof id === "string" && id.length > 0) &&
      !event["error"]
    ) {
      this.accepted = true;
    }
    if (
      event["type"] === "mcpToolCall" &&
      event["status"] === "completed" &&
      /(?:^|__)send_repo_request$/.test(String(event["tool"])) &&
      !event["error"] &&
      repoAccepted(event["result"])
    )
      this.accepted = true;
  }
  claude(value: unknown): void {
    const event = row(value);
    if (!event || event["parent_tool_use_id"] != null) return;
    const blocks = row(event["message"])?.["content"];
    if (!Array.isArray(blocks)) return;
    for (const raw of blocks) {
      const block = row(raw);
      if (!block) continue;
      if (
        event["type"] === "assistant" &&
        block["type"] === "tool_use" &&
        typeof block["id"] === "string" &&
        (block["name"] === "Agent" ||
          block["name"] === "Task" ||
          /(?:^|__)send_repo_request$/.test(String(block["name"])))
      )
        this.claudeCalls.set(block["id"], String(block["name"]));
      const name =
        typeof block["tool_use_id"] === "string"
          ? this.claudeCalls.get(block["tool_use_id"])
          : undefined;
      if (
        event["type"] === "user" &&
        block["type"] === "tool_result" &&
        name &&
        block["is_error"] !== true
      ) {
        if (name === "Agent" || name === "Task") this.accepted = true;
        else if (typeof block["content"] === "string")
          try {
            if (repoAccepted(JSON.parse(block["content"]))) this.accepted = true;
          } catch {
            /* no acknowledgment */
          }
      }
    }
  }
}
