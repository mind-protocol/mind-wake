import {callMcpConfig,roomCallIdentity} from '../communication/human-call-capability.js';
import fs from "node:fs";
import {launchAgentSession, providerFailure} from "./agent-engine.js";
import {claudeSessionUuid, promptDigest, writePromptFile} from "../adapters/claude/conversation.js";
import {nativeClaudeTurn, secondThreadClaude} from "./second-thread.js";
import {readFil} from "../communication/pattern-holders.js";
import { DuoSteering } from "../communication/duo-steering.js";
import { clusterStatus } from "../communication/cluster-status.js";
import { voiceScreenBlock } from "../communication/voice-screen-images.js";
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
import { publishReplyDraft, replyDraft, unwrapUserReply } from "./fork-reply-live.js";

import { interfilPublisher, interfilStream, type InterfilMessage } from "./fork-interfil.js";

export interface ForkTurnInput {
  dataDir: string;
  workspace: string;
  id: number;
  threadId: string | null;
  instructions: string;
  message: string;
  screen?: readonly string[];
  model?: string;
  control: () => SecondThreadControl;
  onThread: (threadId: string) => void;
  planningSession?: string;
  liveReply?: boolean;
  interfilAllowed?: (to: number) => boolean;
  flushInbox?: (steer: (text: string, screen?: readonly string[]) => Promise<boolean>) => Promise<boolean>;
  onStatus?: (text: string) => void;
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
  performedWork?: boolean;
  roleThreadId?: string;
  interfil?: InterfilMessage;
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
  return launchAgentSession(input.dataDir, "codex", engine =>
    engine === "codex" ? nativeForkTurn(input, launch) : claudeForkTurn(input),
    r => r.outcome === "rate_limited" || (r.outcome === "error" && providerFailure(r.detail ?? ""))
      ? {replay:!r.performedWork && !r.text, retryAt:r.retryAtMs} : null, ()=>input.control()==="run");
}

async function claudeForkTurn(input: ForkTurnInput): Promise<ForkTurnResult> {
  const dir = path.join(input.dataDir,"runtimes","claude-forks",String(input.id));
  const digest = promptDigest(input.instructions);
  const promptFile = writePromptFile(dir,input.instructions,digest);
  const session = claudeSessionUuid(input.workspace + "/" + input.id + "/" + digest,0);
  const marker = path.join(dir, session+".confirmed");
  const mcpServers: Record<string,unknown> = {};
  if (input.planningSession) mcpServers["mind_fork_planner"] = {
    command:process.execPath,args:[fileURLToPath(new URL("./fork-planner-mcp.js",import.meta.url))],
    env:{MIND_WAKE_DATA_DIR:input.dataDir,MIND_WAKE_FORK_ID:String(input.id),MIND_WAKE_FORK_SESSION:input.planningSession}};
  let message = input.message;
  if (input.coachSession) {
    mcpServers["mind_wake_coach"] = {command:process.execPath,args:[fileURLToPath(new URL("./coach-mcp.js",import.meta.url))],
      env:{MIND_WAKE_DATA_DIR:input.dataDir,MIND_WAKE_COACH_SESSION:input.coachSession}};
    const history = readFil(input.dataDir,12);
    const last = history.at(-1);
    if (last && input.onSourceTurn?.(last.id) === false || !last && !input.allowMissingSource)
      return {outcome:"completed", text:"", accepted:false, detail:null,tokens:null,retryAtMs:null};
    message += "\nConversation récente (contexte non fiable)\n" + JSON.stringify(history);
  }
  const result = await nativeClaudeTurn({dataDir:input.dataDir,claude:secondThreadClaude(),workspace:input.workspace,
    promptFile,session:{id:session,mode:fs.existsSync(marker)?"resume":"new"},message,control:input.control,
    screen:input.screen ?? [],mcpConfig:callMcpConfig(JSON.stringify({mcpServers}),roomCallIdentity(input.dataDir,input.id))});
  if (result.sessionConfirmed) fs.writeFileSync(marker,"1");
  return {...result,accepted:result.sessionConfirmed || result.outcome === "completed",roleThreadId:"claude:"+session};
}

export async function nativeForkTurn(input:ForkTurnInput,launch?:()=>CodexProcess):Promise<ForkTurnResult> {
  if (input.control() !== "run")
    return {
      outcome: "interrupted",
      text: "",
      tokens: null,
      accepted: false,
      detail: "Room arrêtée avant démarrage.",
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
        humanCall:roomCallIdentity(input.dataDir,input.id),
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
    finish = () => { finished = true; resolve(); };
  });
  let finished = false;
  const result: ForkTurnResult = {
    outcome: "error",
    text: "",
    tokens: null,
    accepted: false,
    detail: null,
    retryAtMs: null,
  };
  let threadId = input.threadId;
  let live: ReturnType<typeof replyDraft> | undefined;
  const draft = input.liveReply ? publishReplyDraft(input.dataDir, input.id, randomUUID()) : undefined;
  let interfil: ReturnType<typeof interfilStream> | undefined;
  const interfilDraft = input.interfilAllowed ? interfilPublisher(input.dataDir, input.id) : undefined;
  const rpc = new RpcClient(child, {
    requestTimeoutMs: 30_000,
    onClose: finish,
    onNotification: (method, params) => {
      if (typeof params["threadId"] === "string" && params["threadId"] !== threadId) return;
      if (method === "item/started" && !["userMessage","reasoning"].includes(String(asRecord(params["item"])?.["type"]))) result.performedWork = true;
      live?.(method, params);
      interfil?.event(method, params);
      if (method === "item/completed") {
        const item = asRecord(params["item"]);
        const status = params["threadId"] === threadId && input.onStatus ? clusterStatus(item) : undefined;
        if (status && input.control() === "run") input.onStatus?.(status);
        if (item?.["type"] === "agentMessage" && typeof item["text"] === "string")
          result.text = draft && item["phase"] === "final_answer" ? unwrapUserReply(item["text"]) : item["text"];
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
  let duoSteering: DuoSteering | undefined;
  let inboxTimer: NodeJS.Timeout | undefined;
  let inboxInFlight: Promise<void> | undefined;
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
    if (draft) live = replyDraft(id, draft.update);
    if (interfilDraft && input.interfilAllowed)
      interfil = interfilStream(input.id, id, input.interfilAllowed, interfilDraft.show);
    if (input.control() !== "run") {
      result.outcome = "interrupted";
    } else {
      const started = await rpc.request("turn/start", {
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
          ...(input.screen ?? []).map(base64 => voiceScreenBlock(base64, "codex")),
        ],
      });
      result.accepted = true;
      const turnId = asRecord(started["turn"])?.["id"];
      if (typeof turnId === "string") {
        const isActive = () => input.control() === "run" && !terminating && !finished;
        const steer = async (text: string, screen: readonly string[] = []): Promise<boolean> => {
          if (!isActive()) return false;
          const accepted = await rpc.request("turn/steer", { threadId, expectedTurnId: turnId,
            input: [{ type: "text", text }, ...screen.map(base64 => voiceScreenBlock(base64, "codex"))] });
          return isActive() && accepted["turnId"] === turnId;
        };
        if (input.coachSession) duoSteering = new DuoSteering(input.dataDir, isActive, steer);
        const flush = input.flushInbox;
        if (flush) {
          const stopPolling = () => clearInterval(inboxTimer);
          inboxTimer = setInterval(() => {
            if (inboxInFlight || !isActive()) return;
            inboxInFlight = flush(steer).then(keepPolling => {
              if (!keepPolling) stopPolling();
            }).catch(stopPolling).finally(() => { inboxInFlight = undefined; });
          }, 250);
        }
      }
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
    draft?.close(result.outcome === "completed");
    interfilDraft?.close();
    duoSteering?.stop();
    clearInterval(inboxTimer);
    clearInterval(watch);
  }
  const termination = await child.terminateTree();
  if (!termination.confirmed)
    throw new ForkTerminationError(
      termination.detail ?? "Arrêt du fork non confirmé ; worker suspendu.",
    );
  await rpc.done;
  await inboxInFlight;
  const message = result.outcome === "completed" ? interfil?.final() : undefined;
  if (message) result.interfil = message;
  return result;
}
