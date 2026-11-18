import { withRoomRoleMcpApprovals } from "./room-role-mcp-approvals.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { discoverCodex } from "../adapters/codex/executable.js";
import { hostPassthroughEnv } from "../adapters/codex/launch.js";
import type { ProfileId, SessionId } from "../contracts/index.js";
import { ProcessTreeSupervisor } from "../runner/process-tree.js";
import type { SecondThreadTurnResult } from "./second-thread.js";
import {withCodexCallApprovals} from "../communication/human-call-capability.js";
import { nativeForkTurn } from "./fork-runtime.js";
import { prepareRoomInbox, type RoomInboxHookArgs } from "../communication/room-inbox-hook.js";
import type { CodexProcess } from "../adapters/codex/launch.js";

export type RoleWebSearch = "live" | "cached" | "disabled";
export function roleWebSearchConfig(mode: RoleWebSearch = "disabled"): string {
  if (!["live", "cached", "disabled"].includes(mode)) throw Error("Invalid role web search capability");
  return "web_search=" + JSON.stringify(mode);
}

type Options = {
  dataDir: string;
  cwd: string;
  instructions: string;
  message: string;
  key?: string;
  mcpConfig?: string;
  addDirs?: readonly string[];
  images?: readonly { data: string; mediaType: string }[];
  textOnly?: boolean;
  webSearch?: RoleWebSearch;
  nativeDelegation?: boolean;
  workspaceWrite?: boolean;
  allowed: () => boolean;
  /** null means no local session cap; host cancellation and provider limits still apply. */
  timeoutMs: number | null;
  roomInbox?: RoomInboxHookArgs;
};
export function roleTurnStopReason(allowed:boolean,deadline:number|null,now=Date.now()):"interrupted"|"timed_out"|null {
  if(!allowed)return "interrupted";
  return deadline!==null&&now>deadline?"timed_out":null;
}
export function roleMcpServers(servers: Record<string, unknown>, dataDir?: string): Record<string, unknown> {
  const requiredCalls=servers["mind_calls"];
  if(requiredCalls && typeof requiredCalls==="object" && !Array.isArray(requiredCalls)){ const config=requiredCalls as Record<string,unknown>; servers={...servers,mind_calls:{...withCodexCallApprovals(config,dataDir),required:true,startup_timeout_sec:config["startup_timeout_sec"]??30}}; }
  const mind = servers["mind"];
  if (!mind || typeof mind !== "object" || Array.isArray(mind)) return servers;
  const config = mind as Record<string, unknown>;
  if (!Array.isArray(config["args"]) || !config["args"].some(arg => typeof arg === "string" && /(?:^|[\\/])(?:fork-owner-main|human-call-main)\.(?:ts|js)$/.test(arg))) return servers;
  // Owner tools are part of this role: never start its model with a silently incomplete catalog.
  return { ...servers, mind: { ...withRoomRoleMcpApprovals(withCodexCallApprovals(config,dataDir),dataDir), required: true, startup_timeout_sec: config["startup_timeout_sec"] ?? 30 } };
}

function toml(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(toml).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .map(([k, v]) => JSON.stringify(k) + "=" + toml(v))
        .join(",") +
      "}"
    );
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  throw Error("Configuration MCP non compatible");
}

/** Isolated role and session; the owner's personal MCP servers are not inherited. */
export async function codexRoleTurn(input: Options, launch?: () => CodexProcess): Promise<SecondThreadTurnResult> {
  const result: SecondThreadTurnResult = {
    outcome: "error",
    text: "",
    tokens: null,
    sessionConfirmed: false,
    retryAtMs: null,
    detail: null,
  };
  if (!input.allowed()) return { ...result, outcome: "interrupted" };
  if (input.roomInbox) return codexRoomTurn(input, launch);
  const executable = discoverCodex();
  if (!executable) return { ...result, detail: "Exécutable Codex introuvable" };
  const dir = path.join(input.dataDir, "runtimes", "codex-roles");
  fs.mkdirSync(dir, { recursive: true });
  const key = createHash("sha256")
    .update(JSON.stringify([input.key, input.cwd, input.instructions]))
    .digest("hex");
  const saved = path.join(dir, key + ".thread");
  const thread = input.key && fs.existsSync(saved) ? fs.readFileSync(saved, "utf8").trim() : "";
  const args = [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--json",
    "-s",
    input.textOnly ? "read-only" : input.workspaceWrite ? "workspace-write" : "danger-full-access",
    "-c",
    'approval_policy="never"',
    "-c",
    roleWebSearchConfig(input.webSearch),
    "-c",
    "developer_instructions=" + JSON.stringify(input.instructions),
  ];
  for (const feature of [
    "apps",
    "plugins",
    "hooks",
    ...(input.nativeDelegation === true && !input.textOnly ? [] : ["multi_agent"]),
    ...(input.textOnly ? ["shell_tool", "unified_exec", "image_generation"] : []),
  ])
    args.push("--disable", feature);
  if (input.nativeDelegation === true && !input.textOnly) args.push("--enable", "multi_agent");
  if (input.mcpConfig) {
    const raw = input.mcpConfig.trimStart().startsWith("{")
      ? input.mcpConfig
      : fs.readFileSync(input.mcpConfig, "utf8");
    args.push("-c", "mcp_servers=" + toml(roleMcpServers(JSON.parse(raw).mcpServers,input.dataDir)));
  }
  for (const extra of input.addDirs ?? []) args.push("--add-dir", extra);
  if (!input.key) args.push("--ephemeral");
  if (thread) args.push("resume", thread);
  const attachments: string[] = [];
  try {
    for (const image of input.images ?? []) {
      const file = path.join(
        dir,
        randomUUID() + (image.mediaType === "image/png" ? ".png" : ".jpg"),
      );
      fs.writeFileSync(file, Buffer.from(image.data, "base64"));
      attachments.push(file);
      args.push("-i", file);
    }
    args.push("-");
    const child = new ProcessTreeSupervisor(path.join(input.dataDir, "runtime")).spawn(
      "default" as ProfileId,
      ("role-" + randomUUID()) as SessionId,
      {
        executable: executable.path,
        args: [...(executable.prefixArgs ?? []), ...args],
        cwd: input.cwd,
        env: {
          ...hostPassthroughEnv(),
          CODEX_HOME: process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex"),
        },
      },
    );
    let interrupted = false,
      timedOut = false,
      acted = false,
      text = "",
      detail = "",
      completed = false,
      tokens: number | null = null;
    const end = input.timeoutMs===null ? null : Date.now() + input.timeoutMs;
    const timer = setInterval(() => {
      if(interrupted||timedOut)return;
      const stop=roleTurnStopReason(input.allowed(),end);
      if (stop!==null) {
        interrupted = stop==="interrupted";
        timedOut = stop==="timed_out";
        void child.terminateTree();
      }
    }, 300);
    try {
      await child.started();
      for (const line of input.message.split(/\r?\n/)) child.send(line);
      child.closeInput?.();
      for (let line = await child.readLine(); line !== null; line = await child.readLine()) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "thread.started" && input.key && typeof event.thread_id === "string")
          fs.writeFileSync(saved, event.thread_id);
        if (event.type === "turn.completed") {
          completed = true;
          tokens = (event.usage?.input_tokens ?? 0) + (event.usage?.output_tokens ?? 0);
        }
        if (event.type === "turn.failed" || event.type === "error")
          detail = String(event.error?.message ?? event.message ?? "Erreur Codex");
        if (event.item && event.item.type !== "reasoning") acted = true;
        if (event.type === "item.completed" && event.item?.type === "agent_message")
          text = event.item.text;
      }
      const exit = await child.exited;
      const outcome = interrupted
        ? "interrupted"
        : completed && exit.mainExitCode === 0
          ? "completed"
          : /rate.?limit|usage.?limit|quota|429/i.test(detail)
            ? "rate_limited"
            : "error";
      return {
        outcome,
        text,
        tokens,
        performedWork: acted,
        sessionConfirmed: acted || completed,
        retryAtMs: null,
        detail:
          outcome === "completed"
            ? null
            : detail ||
              (timedOut
                ? "Délai Codex dépassé"
                : "Échec Codex (" + String(exit.mainExitCode) + ")"),
      };
    } finally {
      clearInterval(timer);
      if (!child.hasExited) await child.terminateTree();
    }
  } finally {
    for (const file of attachments) fs.rmSync(file, { force: true });
  }
}

/** Room roles keep their existing persistent thread and explicit MCP catalog, using live steering. */
async function codexRoomTurn(input: Options, launch?: () => CodexProcess): Promise<SecondThreadTurnResult> {
  const inbox = input.roomInbox!;
  const dir = path.join(input.dataDir, "runtimes", "codex-roles");
  fs.mkdirSync(dir, { recursive: true });
  const key = createHash("sha256").update(JSON.stringify([input.key, input.cwd, input.instructions])).digest("hex");
  const saved = path.join(dir, key + ".thread");
  const threadId = input.key && fs.existsSync(saved) ? fs.readFileSync(saved, "utf8").trim() : null;
  const deadline = input.timeoutMs === null ? null : Date.now() + input.timeoutMs;
  const control = () => roleTurnStopReason(input.allowed(), deadline) === null ? "run" as const : "stop" as const;
  const outcome = await nativeForkTurn({
    dataDir: input.dataDir, workspace: input.cwd, id: inbox.forkId,
    threadId, inheritPrincipal: false, instructions: input.instructions, message: input.message,
    control, onThread: id => { if (input.key) fs.writeFileSync(saved, id); },
    flushInbox: async steer => {
      if (control() !== "run") return false;
      const batch = prepareRoomInbox(inbox);
      if (!batch) return true;
      if (!await steer(batch.context)) return false;
      batch.confirm();
      return true;
    },
  }, launch ?? (() => {
    const executable = discoverCodex();
    if (!executable) throw Error("Exécutable Codex introuvable");
    const raw = input.mcpConfig
      ? input.mcpConfig.trimStart().startsWith("{") ? input.mcpConfig : fs.readFileSync(input.mcpConfig, "utf8")
      : '{"mcpServers":{}}';
    const args = [
      ...(executable.prefixArgs ?? []),
      "-c", 'approval_policy="never"',
      "-c", roleWebSearchConfig(input.webSearch),
      "-c", "mcp_servers=" + toml(roleMcpServers(JSON.parse(raw).mcpServers, input.dataDir)),
      "--disable", "apps", "--disable", "plugins", "--disable", "hooks",
      input.nativeDelegation ? "--enable" : "--disable", "multi_agent",
      "app-server", "--listen", "stdio://",
    ];
    return new ProcessTreeSupervisor(path.join(input.dataDir, "runtime")).spawn(
      "default" as ProfileId, ("role-" + randomUUID()) as SessionId,
      { executable: executable.path, args, cwd: input.cwd,
        env: { ...hostPassthroughEnv(), CODEX_HOME: process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex") } });
  }));
  return { ...outcome, sessionConfirmed: outcome.accepted, engine: "codex" };
}

