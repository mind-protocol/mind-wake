/** Explicit outgoing peer records. Never infer an emission from an owner message or body JSON. */
import fs from "node:fs";
import path from "node:path";
import { readRepoConversations } from "./repo-conversations.js";

export interface SentMessage {
  id: string;
  at: string;
  text: string;
  channel: "mind-shared-hub" | "repo-session";
  sender: { ref: string; name: string };
  recipient: { ref: string; name: string };
  threadId: string;
  messageId: string;
  idempotencyKey?: string;
  state: "hub_stored" | "recorded";
  /** Operator time is an observation time, not an invented server timestamp. */
  historical?: boolean;
}
const FILE = "sent-peer-messages.jsonl";
const party = /^(agent|human)-[a-z2-9]{10}$/;
function file(dataDir: string): string {
  const value = path.join(dataDir, FILE);
  if (fs.existsSync(value)) {
    const stat = fs.lstatSync(value);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error("Invalid sent peer store");
  }
  return value;
}
function journal(dataDir: string): SentMessage[] {
  const value = file(dataDir);
  if (!fs.existsSync(value)) return [];
  return fs.readFileSync(value, "utf8").split("\n").filter(Boolean).map(line => {
    const m = JSON.parse(line) as SentMessage;
    if (m.channel !== "mind-shared-hub" || m.state !== "hub_stored" || typeof m.id !== "string" ||
      typeof m.text !== "string" || !Number.isFinite(Date.parse(m.at)) || !party.test(m.sender?.ref) || !party.test(m.recipient?.ref))
      throw Error("Invalid sent peer record");
    return m;
  });
}
export interface SharedSentInput {
  request: { tool: "send_message" | "reply_to_thread"; arguments: { text: string; idempotency_key: string; to?: string; thread_id?: string } };
  /** Direct successful SDK tool result, not a peer body containing a result-shaped object. */
  result: { isError?: boolean; content: readonly { type: string; text?: string }[] };
  sender: { ref: string; name: string };
  /** Resolved by the local operator from directory/thread context, never from message text. */
  recipient: { ref: string; name: string };
  at: string;
  historical?: boolean;
}
export function recordSharedSent(dataDir: string, input: SharedSentInput): SentMessage {
  const { request, sender, recipient } = input;
  if (!["send_message", "reply_to_thread"].includes(request.tool) || input.result.isError === true ||
    !party.test(sender.ref) || !sender.ref.startsWith("agent-") || !party.test(recipient.ref) ||
    typeof sender.name !== "string" || typeof recipient.name !== "string" ||
    !Number.isFinite(Date.parse(input.at)) || typeof request.arguments.text !== "string" || !request.arguments.text.trim() ||
    !/^[A-Za-z0-9_.:-]{8,128}$/.test(request.arguments.idempotency_key)) throw Error("Invalid confirmed shared send");
  const blocks = input.result.content.filter(block => block.type === "text" && typeof block.text === "string");
  if (blocks.length !== 1) throw Error("Expected direct shared result");
  const result = JSON.parse(blocks[0]!.text!) as Record<string, unknown>;
  if (result["schema"] !== `mind.shared/${request.tool}` || result["schema_version"] !== 1 ||
    typeof result["message_id"] !== "string" || !/^msg_[A-Za-z0-9_-]{8,64}$/.test(result["message_id"]) ||
    typeof result["thread_id"] !== "string" || !/^thr_[A-Za-z0-9_-]{8,64}$/.test(result["thread_id"]) ||
    (request.tool === "send_message" ? request.arguments.to !== recipient.ref : request.arguments.thread_id !== result["thread_id"]))
    throw Error("Shared send result does not match operator request");
  const entry: SentMessage = {
    id: `shared-sent:${sender.ref}:${result["message_id"]}`, at: input.at, text: request.arguments.text,
    channel: "mind-shared-hub", sender, recipient, threadId: result["thread_id"], messageId: result["message_id"],
    idempotencyKey: request.arguments.idempotency_key, state: "hub_stored",
    ...(input.historical ? { historical: true } : {}),
  };
  const existing = journal(dataDir).find(m => m.id === entry.id || (m.sender.ref === sender.ref && m.idempotencyKey === entry.idempotencyKey));
  if (existing) {
    if (existing.id !== entry.id || existing.text !== entry.text || existing.recipient.ref !== recipient.ref || existing.threadId !== entry.threadId)
      throw Error("Conflicting shared send identity");
    return existing;
  }
  fs.appendFileSync(file(dataDir), JSON.stringify(entry) + "\n", "utf8");
  return entry;
}
export function readSentMessages(dataDir: string): SentMessage[] {
  const messages = journal(dataDir);
  // Only explicit repo records. Exclude the legacy synthetic join of owner text containing a thread ID.
  for (const thread of readRepoConversations(dataDir, false)) for (const m of thread.messages) {
    if (m.from !== "wake" || !Number.isFinite(Date.parse(m.at))) continue;
    messages.push({ id: `repo-sent:${thread.id}:${m.id}`, at: m.at, text: m.text, channel: "repo-session",
      sender: { ref: "local-wake-agent", name: "Ton agent" }, recipient: { ref: thread.sessionId || thread.id, name: `${thread.runtime || "Session"} · ${thread.repo}` },
      threadId: thread.id, messageId: m.id, state: "recorded" });
  }
  return [...new Map(messages.map(m => [m.id, m])).values()].sort((a,b) => Date.parse(a.at)-Date.parse(b.at));
}
