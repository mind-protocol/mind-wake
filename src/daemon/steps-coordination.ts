import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { readRepoConversations } from "../communication/repo-conversations.js";
import { readReplies } from "../cli/commands/messages.js";
import { readCounter, readCurrentProject } from "./project-change.js";

export function withProjectLock<T>(workspace: string, action: () => T): T | null {
  const folder = path.join(workspace, "artifacts");
  if (!containedDirectory(workspace, folder)) return null;
  const file = path.join(folder, "projets-compteur.json.lock");
  let fd: number;
  try {
    fd = fs.openSync(file, "wx");
  } catch {
    return null;
  }
  try {
    return action();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(file);
  }
}
export function atomicJson(file: string, value: unknown): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function humanCursor(dataDir: string): string | null {
  try {
    return hash(readReplies({ path: dataDir, source: "environment" }));
  } catch {
    return null;
  }
}
export function projectSnapshot(
  workspace: string,
  dataDir: string,
  projectId: string,
): string | null {
  const counter = readCounter(workspace);
  const p = (counter?.["projects"] as Record<string, unknown> | undefined)?.[projectId];
  if (!p || readCurrentProject(workspace) !== projectId) return null;
  // Whole target entry: concurrent target edits invalidate approval, other projects do not.
  const human = humanCursor(dataDir);
  if (human === null) return null;
  return hash({
    projectId,
    project: p,
    selectionRevision: counter?.["selectionRevision"] ?? 0,
    human,
  });
}
export interface StepsRequest {
  requestId: string;
  projectId: string;
  snapshotRef: string;
  sourceSessionId: string;
  state: "proposal_pending" | "proposal_ready" | "applied" | "stale" | "unavailable" | "failed";
  calls: Record<string, string>;
  proposals: Record<string, { text: string; tool: string }>;
  evidenceTruncated?: boolean | undefined;
  createdAt: string;
  fromProject?: string | undefined;
  instructions?: string | undefined;
  repoThread?: string | undefined;
  repoTarget?: string | undefined;
  repoJob?: string | undefined;
}
const requestSchema = z.object({
  requestId: z.uuid(),
  projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  snapshotRef: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceSessionId: z.string().min(1).max(200),
  state: z.enum([
    "proposal_pending",
    "proposal_ready",
    "applied",
    "stale",
    "unavailable",
    "failed",
  ]),
  calls: z
    .record(z.string().max(200), z.string().max(200))
    .refine((x) => Object.keys(x).length <= 64),
  proposals: z
    .record(
      z.string().max(300),
      z.object({ text: z.string().min(1).max(64000), tool: z.string().max(300) }),
    )
    .refine((x) => Object.keys(x).length <= 4),
  evidenceTruncated: z.boolean().optional(),
  createdAt: z.iso.datetime(),
  fromProject: z.string().max(128).optional(),
  instructions: z.string().max(20000).optional(),
  repoThread: z
    .string()
    .regex(/^direct_[a-f0-9]{32}$/u)
    .optional(),
  repoTarget: z.string().max(200).optional(),
  repoJob: z.string().max(200).optional(),
});
function containedDirectory(workspace: string, folder: string): boolean {
  try {
    const relative = path.relative(fs.realpathSync(workspace), fs.realpathSync(folder));
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}
const requestFile = (w: string, id: string) =>
  path.join(w, "artifacts", "steps-requests", id + ".json");
export function readStepsRequest(workspace: string, id: string): StepsRequest | null {
  if (!/^[a-f0-9-]{36}$/u.test(id)) return null;
  try {
    const file = requestFile(workspace, id);
    if (!containedDirectory(workspace, path.dirname(file))) return null;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const fd = fs.openSync(file, "r");
    let raw: string;
    try {
      if (fs.fstatSync(fd).size > 262144) return null;
      const b = Buffer.alloc(262145);
      const n = fs.readSync(fd, b, 0, b.length, 0);
      if (n > 262144) return null;
      raw = b.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    const parsed = requestSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.requestId === id ? parsed.data : null;
  } catch {
    return null;
  }
}
export function createStepsRequest(
  workspace: string,
  dataDir: string,
  projectId: string,
  sessionId: string,
): StepsRequest | null {
  const nowSnapshot = projectSnapshot(workspace, dataDir, projectId);
  const existing = pendingStepsRequests(workspace).find(
    (r) =>
      r.sourceSessionId === sessionId &&
      r.projectId === projectId &&
      r.state !== "stale" &&
      r.snapshotRef === nowSnapshot,
  );
  if (existing) return existing;
  const snapshotRef = projectSnapshot(workspace, dataDir, projectId);
  if (!snapshotRef) return null;
  const r: StepsRequest = {
    requestId: randomUUID(),
    projectId,
    snapshotRef,
    sourceSessionId: sessionId,
    state: "proposal_pending",
    calls: {},
    proposals: {},
    createdAt: new Date().toISOString(),
  };
  if (!containedDirectory(workspace, path.join(workspace, "artifacts"))) return null;
  fs.mkdirSync(path.dirname(requestFile(workspace, r.requestId)), { recursive: true });
  if (!containedDirectory(workspace, path.dirname(requestFile(workspace, r.requestId))))
    return null;
  atomicJson(requestFile(workspace, r.requestId), r);
  return r;
}
export function updateStepsRequest(workspace: string, request: StepsRequest): void {
  const calls = Object.entries(request.calls),
    proposals = Object.entries(request.proposals);
  if (calls.length > 64 || proposals.length > 4 || proposals.some(([, p]) => p.text.length > 8000))
    request.evidenceTruncated = true;
  request.calls = Object.fromEntries(calls.slice(0, 64));
  request.proposals = Object.fromEntries(
    proposals.slice(0, 4).map(([id, p]) => [id, { ...p, text: p.text.slice(0, 8000) }]),
  );
  if (Buffer.byteLength(JSON.stringify(request, null, 2), "utf8") > 262144)
    throw new Error("Steps request too large; prior request preserved");
  if (
    !requestSchema.safeParse(request).success ||
    !containedDirectory(workspace, path.dirname(requestFile(workspace, request.requestId)))
  )
    throw new Error("Invalid steps request");
  atomicJson(requestFile(workspace, request.requestId), request);
}
export function pendingStepsRequests(workspace: string): StepsRequest[] {
  try {
    return fs.readdirSync(path.join(workspace, "artifacts", "steps-requests")).flatMap((f) => {
      const r = readStepsRequest(workspace, f.replace(/\.json$/u, ""));
      return r && ["proposal_pending", "proposal_ready", "stale"].includes(r.state) ? [r] : [];
    });
  } catch {
    return [];
  }
}
function object(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}
/** Only adapter-observed tool events are admitted here; never model JSON assertions. */
export function observeStepsTool(
  workspace: string,
  requestId: string,
  runtime: "claude" | "codex",
  event: unknown,
  dataDir?: string,
  principalThreadId?: string,
): void {
  const r = readStepsRequest(workspace, requestId);
  if (!r || r.state === "applied") return;
  const before = JSON.stringify(r);
  const e = object(event);
  if (!e || e["parent_tool_use_id"] != null) return;
  const bound = (v: unknown) => {
    if (v === undefined) return false;
    const input = JSON.stringify(v);
    return input.includes(r.requestId) && input.includes(r.snapshotRef);
  };
  if (runtime === "claude") {
    const msg = object(e["message"]);
    const blocks = msg?.["content"];
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      const block = object(b);
      if (!block) continue;
      const id = block["id"],
        name = block["name"];
      if (
        e["type"] === "assistant" &&
        block["type"] === "tool_use" &&
        typeof id === "string" &&
        bound(block["input"]) &&
        (name === "Agent" ||
          name === "Task" ||
          (typeof name === "string" && /send_repo_request$/u.test(name)))
      ) {
        r.calls[id] = name;
        const target = object(block["input"])?.["target"];
        if (typeof target === "string") r.repoTarget = target;
      }
      const call = block["tool_use_id"];
      if (
        e["type"] === "user" &&
        block["type"] === "tool_result" &&
        typeof call === "string" &&
        r.calls[call] &&
        block["is_error"] !== true
      ) {
        const content = block["content"];
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .map((x) => object(x)?.["text"])
                  .filter((x) => typeof x === "string")
                  .join("\n")
              : "";
        // Background launch acknowledgment is not a recommendation.
        if (
          object(e["toolUseResult"])?.["isAsync"] === true ||
          object(e["toolUseResult"])?.["status"] === "async_launched"
        )
          continue;
        if (/send_repo_request$/u.test(r.calls[call])) {
          try {
            const reply = JSON.parse(text) as Record<string, unknown>;
            if (typeof reply["thread_id"] === "string" && typeof reply["job_id"] === "string") {
              r.repoThread = reply["thread_id"];
              r.repoJob = reply["job_id"];
            }
          } catch {
            /* malformed result is not evidence */
          }
        } else if (text.trim())
          r.proposals[call] = { text: text.slice(0, 64000), tool: r.calls[call] };
      }
    }
  } else {
    if (
      e["type"] === "mcpToolCall" &&
      e["status"] === "completed" &&
      e["tool"] === "send_repo_request" &&
      !e["error"] &&
      bound(e["arguments"])
    ) {
      const target = object(e["arguments"])?.["target"];
      if (typeof target === "string") r.repoTarget = target;
      const result = object(e["result"]);
      const structured = object(result?.["structuredContent"]);
      let answer = structured;
      if (!answer && Array.isArray(result?.["content"]))
        for (const c of result["content"]) {
          try {
            answer = object(JSON.parse(String(object(c)?.["text"])));
          } catch {
            /* no evidence */
          }
        }
      if (typeof answer?.["thread_id"] === "string" && typeof answer["job_id"] === "string") {
        r.repoThread = answer["thread_id"];
        r.repoJob = answer["job_id"];
      }
    }
    // Codex app-server v2 native collaboration item. Completed wait returns actual agent states/messages.
    if (
      e["type"] === "collabAgentToolCall" &&
      e["status"] === "completed" &&
      e["tool"] === "spawnAgent" &&
      e["senderThreadId"] === principalThreadId &&
      bound(e["prompt"]) &&
      Array.isArray(e["receiverThreadIds"])
    ) {
      for (const agent of e["receiverThreadIds"])
        if (typeof agent === "string") r.calls["agent:" + agent] = String(e["id"]);
    }
    if (
      e["type"] === "collabAgentToolCall" &&
      e["status"] === "completed" &&
      ["wait", "sendMessage", "followupTask"].includes(String(e["tool"])) &&
      e["senderThreadId"] === principalThreadId
    ) {
      const states = object(e["agentsStates"]),
        id = e["id"];
      if (states && typeof id === "string")
        for (const [agent, state] of Object.entries(states)) {
          const s = object(state);
          if (
            r.calls["agent:" + agent] &&
            s?.["status"] === "completed" &&
            typeof s["message"] === "string" &&
            s["message"].trim()
          ) {
            r.calls[id] = "collaboration.wait";
            r.proposals[id + ":" + agent] = {
              text: s["message"].slice(0, 64000),
              tool: "collaboration.wait",
            };
          }
        }
    }
  }
  if (dataDir) refreshRepoProposal(r, dataDir);
  if (Object.keys(r.proposals).length && r.state !== "stale") r.state = "proposal_ready";
  if (JSON.stringify(r) !== before) updateStepsRequest(workspace, r);
}

export function refreshRepoProposal(r: StepsRequest, dataDir: string): void {
  if (!r.repoThread) return;
  const thread = readRepoConversations(dataDir).find((t) => t.id === r.repoThread);
  if (
    !thread ||
    r.repoTarget !== `${thread.runtime}:${thread.sessionId}` ||
    !thread.messages.some(
      (m) => m.from === "wake" && m.text.includes(r.requestId) && m.text.includes(r.snapshotRef),
    )
  )
    return;
  const answer = thread.messages.findLast((m) => m.from === "repo" && m.text.trim());
  if (answer) {
    r.proposals[answer.id] = {
      text: answer.text.slice(0, 64000),
      tool: "send_repo_request:" + r.repoThread,
    };
    if (r.state !== "stale") r.state = "proposal_ready";
  }
}
