import os from "node:os";
import path from "node:path";
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
}
export class ForkTerminationError extends Error {}

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
    const parent = new FileThreadStore(path.join(input.dataDir, "codex-threads")).load("default");
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
      await rpc.request("turn/start", { threadId, input: [{ type: "text", text: input.message }] });
      result.accepted = true;
      await done;
    }
  } catch (error) {
    if (result.outcome !== "interrupted") {
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
