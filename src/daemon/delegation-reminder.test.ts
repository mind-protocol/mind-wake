import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { DelegationEvidence, delegationReminderEnabled } from "./delegation-reminder.js";
it("requires an explicit installation opt-in", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-reminder-"));
  try {
    fs.mkdirSync(path.join(dir, "artifacts"));
    expect(delegationReminderEnabled(dir)).toBe(false);
    fs.writeFileSync(
      path.join(dir, "artifacts/delegation-reminder.json"),
      JSON.stringify({ version: 1, enabled: true }),
    );
    expect(delegationReminderEnabled(dir)).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it.each(["spawnAgent", "followupTask", "resumeAgent", "sendMessage"])(
  "counts a successful principal %s event",
  (tool) => {
    const evidence = new DelegationEvidence();
    evidence.codex(
      {
        type: "collabAgentToolCall",
        tool,
        status: "completed",
        senderThreadId: "main",
        receiverThreadIds: ["child"],
      },
      "main",
    );
    expect(evidence.accepted).toBe(true);
  },
);
it("does not count prose, waits, failed calls or child-thread delegation", () => {
  const evidence = new DelegationEvidence();
  for (const event of [
    { type: "agentMessage", text: "I launched an agent" },
    {
      type: "collabAgentToolCall",
      tool: "wait",
      status: "completed",
      senderThreadId: "main",
      receiverThreadIds: ["child"],
    },
    {
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "failed",
      senderThreadId: "main",
      receiverThreadIds: ["child"],
    },
    {
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: "child",
      receiverThreadIds: ["other"],
    },
  ])
    evidence.codex(event, "main");
  expect(evidence.accepted).toBe(false);
});
it("requires both Claude tool call and its successful result", () => {
  const evidence = new DelegationEvidence();
  evidence.claude({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "call", name: "Agent" }] },
  });
  expect(evidence.accepted).toBe(false);
  evidence.claude({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "call", is_error: true }] },
  });
  expect(evidence.accepted).toBe(false);
  evidence.claude({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "call", content: "Async launch accepted" }],
    },
  });
  expect(evidence.accepted).toBe(true);
});
it("counts a repo launch acknowledgement but not an errored result", () => {
  const event = {
    type: "mcpToolCall",
    tool: "send_repo_request",
    status: "completed",
    result: { structuredContent: { job_id: "job", thread_id: "thread" } },
  };
  const evidence = new DelegationEvidence();
  evidence.codex({ ...event, error: { message: "refused" } }, "main");
  expect(evidence.accepted).toBe(false);
  evidence.codex(event, "main");
  expect(evidence.accepted).toBe(true);
});
