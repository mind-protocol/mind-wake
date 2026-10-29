import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { observeClaudeTools, readMessageWait } from "./runtime-activity.js";
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-tool-wait-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const emit = (type: string, content: unknown[], parent: string | null = null) =>
  observeClaudeTools(
    dir,
    "wake-1",
    JSON.stringify({ type, parent_tool_use_id: parent, message: { content } }),
  );
it("detects a foreground subagent and clears only its matching result", () => {
  emit("assistant", [
    { type: "tool_use", id: "a", name: "Agent", input: { prompt: "PRIVATE" } },
    { type: "tool_use", id: "b", name: "Bash" },
  ]);
  expect(readMessageWait(dir, "wake-1")?.kind).toBe("subagent");
  emit("user", [{ type: "tool_result", tool_use_id: "other" }]);
  expect(readMessageWait(dir, "wake-1")?.kind).toBe("subagent");
  emit("user", [{ type: "tool_result", tool_use_id: "a", is_error: true }]);
  expect(readMessageWait(dir, "wake-1")?.kind).toBe("tool");
  emit("user", [{ type: "tool_result", tool_use_id: "b" }]);
  expect(readMessageWait(dir, "wake-1")).toBeNull();
  expect(
    fs.readFileSync(path.join(dir, "runtimes", "claude", "tool-activity.json"), "utf8"),
  ).not.toContain("PRIVATE");
});
it("ignores child activity and stale sessions and clears terminal results", () => {
  emit("assistant", [{ type: "tool_use", id: "a", name: "Task" }]);
  emit("user", [{ type: "tool_result", tool_use_id: "a" }], "child");
  expect(readMessageWait(dir, "wake-1")?.kind).toBe("subagent");
  expect(readMessageWait(dir, "wake-2")).toBeNull();
  expect(readMessageWait(dir, null)).toBeNull();
  observeClaudeTools(dir, "wake-1", JSON.stringify({ type: "result" }));
  expect(readMessageWait(dir, "wake-1")).toBeNull();
});
