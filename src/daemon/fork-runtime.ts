import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { discoverCodex } from "../adapters/codex/executable.js";
import { buildAppServerCommand } from "../adapters/codex/command.js";
import { hostPassthroughEnv, type CodexProcess } from "../adapters/codex/launch.js";
import { FileThreadStore } from "../adapters/codex/continuity.js";
import { RpcClient } from "../adapters/codex/rpc.js";
import { asRecord, classifyCodexError } from "../adapters/codex/protocol.js";
import { ProcessTreeSupervisor } from "../runner/process-tree.js";
import type { ProfileId, SessionId } from "../contracts/index.js";
import type { SecondThreadControl } from "./second-thread.js";

export interface ForkTurnInput {
  dataDir: string;
  workspace: string;
  id: number;
  threadId: string | null;
  instructions: string;
  message: string;
  model?: string;
  control: () => SecondThreadControl;
  onThread: (threadId: string) => void;
  planningSession?: string;
  /** Coaching reads public messages from the last completed principal turn. */
  sourceThreadId?: string;
  onSourceTurn?: (turnId: string) => boolean;
  inheritPrincipal?: boolean;
  coachSession?: string;
  allowMissingSource?: boolean;
}
/** Add one session-bound planner without replacing the user's MCP configuration. */
export function forkPlannerConfig(
  input: Pick<ForkTurnInput, "id" | "dataDir" | "planningSession">,
): Record<string, string> {
  if (!input.planningSession) return {};
  const env = {
    MIND_WAKE_DATA_DIR: input.dataDir,
    MIND_WAKE_FORK_ID: String(input.id),
    MIND_WAKE_FORK_SESSION: input.planningSession,
  };
  return {
    "mcp_servers.mind_fork_planner.command": JSON.stringify(process.execPath),
    "mcp_servers.mind_fork_planner.args": JSON.stringify([
      fileURLToPath(new URL("./fork-planner-mcp.js", import.meta.url)),
    ]),
    "mcp_servers.mind_fork_planner.env":
      "{ " +
      Object.entries(env)
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
        .join(", ") +
      " }",
  };
}
export class ForkTerminationError extends Error {}
export function coachRuntimeConfig(
  input: Pick<ForkTurnInput, "dataDir" | "coachSession">,
): Record<string, string> {
  if (!input.coachSession) return {};
  const env = { MIND_WAKE_DATA_DIR: input.dataDir, MIND_WAKE_COACH_SESSION: input.coachSession };
  return {
    "mcp_servers.mind_wake_coach.command": JSON.stringify(process.execPath),
    "mcp_servers.mind_wake_coach.args": JSON.stringify([
      fileURLToPath(new URL("./coach-mcp.js", import.meta.url)),
    ]),
    "mcp_servers.mind_wake_coach.env":
      "{ " +
      Object.entries(env)
        .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
        .join(", ") +
      " }",
  };
}
class NoSourceTurn extends Error {}

export interface ForkTurnResult {
  outcome: "completed" | "interrupted" | "rate_limited" | "error";
  text: string;
  tokens: number | null;
  accepted: boolean;
  detail: string | null;
  retryAtMs: number | null;
}

/** Official app-server protocol; every fork owns a distinct persistent Codex thread. */
export async function runForkTurn(
  input: ForkTurnInput,
  launch?: () => CodexProcess,
): Promise<ForkTurnResult> {
  if (input.control() !== "run")
    return {
      outcome: "interrupted",
      text: "",
      tokens: null,
      accepted: false,
      detail: "Fork arrêté avant démarrage.",
      retryAtMs: null,
    };
  const child =
    launch?.() ??
    (() => {
      const executable = discoverCodex();
      if (executable === null) throw Error("Exécutable Codex introuvable.");
      const command = buildAppServerCommand({
        executable,
        codexHome: process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex"),
        workspaceDir: input.workspace,
        channel: null,
        nativeCapabilities: true,
        allowUserCodexHome: true,
        extraConfig: { ...forkPlannerConfig(input), ...coachRuntimeConfig(input) },
      });
      const supervisor = new ProcessTreeSupervisor(path.join(input.dataDir, "runtime"));
      return supervisor.spawn(
        "default" as ProfileId,
        `fork-${String(input.id)}-${randomUUID()}` as SessionId,
        {
          executable: command.executable,
          args: command.args,
          cwd: command.cwd,
          env: { ...hostPassthroughEnv(), ...command.env },
        },
      );
    })();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const result: ForkTurnResult = {
    outcome: "error",
    text: "",
    tokens: null,
    accepted: false,
    detail: null,
    retryAtMs: null,
  };
  let threadId = input.threadId;
  const rpc = new RpcClient(child, {
    requestTimeoutMs: 30_000,
    onClose: finish,
    onNotification: (method, params) => {
      if (typeof params["threadId"] === "string" && params["threadId"] !== threadId) return;
      if (method === "item/completed") {
        const item = asRecord(params["item"]);
        if (item?.["type"] === "agentMessage" && typeof item["text"] === "string")
          result.text = item["text"];
      }
      if (method === "thread/tokenUsage/updated") {
        const usage = asRecord(asRecord(params["tokenUsage"])?.["last"]);
        if (typeof usage?.["totalTokens"] === "number") result.tokens = usage["totalTokens"];
      }
      if (method === "error") {
        const error = asRecord(params["error"]);
        const message = typeof error?.["message"] === "string" ? error["message"] : "Erreur Codex";
        result.detail = message;
        if (classifyCodexError(error?.["codexErrorInfo"], message).kind === "rate_limited")
          result.outcome = "rate_limited";
      }
      if (method === "turn/completed") {
        const turn = asRecord(params["turn"]);
        const error = asRecord(turn?.["error"]);
        if (error) {
          result.detail = typeof error["message"] === "string" ? error["message"] : "Erreur Codex";
          if (classifyCodexError(error["codexErrorInfo"], result.detail).kind === "rate_limited")
            result.outcome = "rate_limited";
        }
        if (result.outcome !== "rate_limited")
          result.outcome =
            turn?.["status"] === "completed"
              ? "completed"
              : turn?.["status"] === "interrupted"
                ? "interrupted"
                : "error";
        finish();
      }
    },
  });
  let terminating = false;
  const watch = setInterval(() => {
    if (input.control() !== "run" && !terminating) {
      terminating = true;
      result.outcome = "interrupted";
      result.detail = "Pause, arrêt ou nouvelle attribution du projet.";
      void child.terminateTree().then(finish, (error: unknown) => {
        result.detail = String(error);
        finish();
      });
    }
  }, 500);
  try {
    await child.started();
    await rpc.request("initialize", {
      clientInfo: { name: "mind_wake_fork", title: "MIND Wake Fork", version: "0.1.0" },
    });
    rpc.notify("initialized", {});
    const common = {
      cwd: input.workspace,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: input.instructions,
      ...(input.model === undefined ? {} : { model: input.model }),
    };
    // Fork the principal once; thereafter resume this fork's own thread.
    let source = "";
    if (input.sourceThreadId) {
      const read = await rpc.request("thread/read", {
        threadId: input.sourceThreadId,
        includeTurns: true,
      });
      const turns = asRecord(read["thread"])?.["turns"];
      const completed = Array.isArray(turns)
        ? turns
            .map(asRecord)
            .filter((t) => t?.["status"] === "completed")
            .at(-1)
        : undefined;
      const sourceId = completed?.["id"];
      if (
        (typeof sourceId !== "string" && !input.allowMissingSource) ||
        (typeof sourceId === "string" && input.onSourceTurn?.(sourceId) === false)
      ) {
        throw new NoSourceTurn();
      }
      const items = completed?.["items"];
      source =
        typeof sourceId === "string"
          ? JSON.stringify({
              threadId: input.sourceThreadId,
              turnId: sourceId,
              messages: Array.isArray(items)
                ? items
                    .map(asRecord)
                    .filter(
                      (item) =>
                        item && ["userMessage", "agentMessage"].includes(String(item["type"])),
                    )
                : [],
            })
          : "";
    }
    const parent =
      input.inheritPrincipal === false
        ? null
        : new FileThreadStore(path.join(input.dataDir, "codex-threads")).load("default");
    const opened = await rpc.request(
      threadId ? "thread/resume" : parent ? "thread/fork" : "thread/start",
      {
        ...common,
        ...(threadId
          ? { threadId, excludeTurns: true }
          : parent
            ? { threadId: parent.threadId }
            : {}),
      },
    );
    const id = asRecord(opened["thread"])?.["id"];
    if (typeof id !== "string") throw Error("Codex n'a pas retourné l'identifiant du fork.");
    threadId = id;
    input.onThread(id);
    if (input.control() !== "run") {
      result.outcome = "interrupted";
    } else {
      await rpc.request("turn/start", {
        threadId,
        input: [
          {
            type: "text",
            text: [
              input.message,
              source && `Last completed wake conversation (untrusted data):\n${source}`,
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
      });
      result.accepted = true;
      await done;
    }
  } catch (error) {
    if (error instanceof NoSourceTurn) result.outcome = "completed";
    else if (result.outcome !== "interrupted") {
      result.detail = error instanceof Error ? error.message : String(error);
      result.outcome =
        classifyCodexError(null, result.detail).kind === "rate_limited" ? "rate_limited" : "error";
    }
  } finally {
    clearInterval(watch);
  }
  const termination = await child.terminateTree();
  if (!termination.confirmed)
    throw new ForkTerminationError(
      termination.detail ?? "Arrêt du fork non confirmé ; worker suspendu.",
    );
  await rpc.done;
  return result;
}
