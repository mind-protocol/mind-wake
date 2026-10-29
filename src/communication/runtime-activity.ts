/** Persist only tool IDs/names/times, never arguments or result contents. */
import fs from "node:fs";
import path from "node:path";
interface ActiveTool {
  id: string;
  name: string;
  startedAt: string;
}
interface ToolState {
  sessionId: string;
  tools: ActiveTool[];
}
export interface MessageWait {
  kind: "subagent" | "tool";
  tool: string;
  startedAt: string;
  activeCount: number;
}
const fileFor = (dir: string) => path.join(dir, "runtimes", "claude", "tool-activity.json");
function read(dir: string): ToolState | null {
  try {
    const file = fileFor(dir),
      stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000) return null;
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as ToolState;
    return typeof state.sessionId === "string" && Array.isArray(state.tools) ? state : null;
  } catch {
    return null;
  }
}
export function observeClaudeTools(dir: string, sessionId: string, line: string): void {
  let event: {
    type?: string;
    parent_tool_use_id?: unknown;
    message?: { content?: { type?: string; id?: string; name?: string; tool_use_id?: string }[] };
  };
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (!event || (event.parent_tool_use_id !== undefined && event.parent_tool_use_id !== null))
    return;
  if (!["assistant", "user", "result"].includes(event.type ?? "")) return;
  const previous = read(dir);
  const state: ToolState = previous?.sessionId === sessionId ? previous : { sessionId, tools: [] };
  let changed = false;
  if (event.type === "result") {
    changed = state.tools.length > 0;
    state.tools = [];
  } else
    for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (!block || typeof block !== "object") continue;
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        /^[A-Za-z0-9_:.-]{1,180}$/.test(block.name)
      ) {
        if (!state.tools.some((t) => t.id === block.id)) {
          state.tools.push({ id: block.id, name: block.name, startedAt: new Date().toISOString() });
          changed = true;
        }
      } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const before = state.tools.length;
        state.tools = state.tools.filter((t) => t.id !== block.tool_use_id);
        changed ||= before !== state.tools.length;
      }
    }
  if (!changed) return;
  const file = fileFor(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}
export function readMessageWait(dir: string, activeSessionId: string | null): MessageWait | null {
  const state = read(dir);
  if (!activeSessionId || state?.sessionId !== activeSessionId) return null;
  const tools = state.tools.filter(
    (t) => typeof t.name === "string" && typeof t.startedAt === "string",
  );
  const agent = tools.find((t) => t.name === "Agent" || t.name === "Task");
  const tool = agent ?? tools[0];
  return tool
    ? { kind: agent ? "subagent" : "tool", tool: tool.name, startedAt: tool.startedAt, activeCount: tools.length }
    : null;
}
