/** Received content only. Identity comes from the channel envelope, never the body. */
import fs from "node:fs";
import path from "node:path";
import { readRepoConversations } from "./repo-conversations.js";
import { readOwnerReceipts, readOwnerInboxHistory } from "./owner-inbox.js";
import { recipientEntries } from "./recipient-history.js";

export interface ReceivedMessage {
  id: string;
  at: string;
  text: string;
  source: {
    channel: "repo-session" | "mind-local-hub" | "mind-shared-hub" | "local-inbox";
    kind: string;
    ref: string;
    name: string;
    assurance: "channel_record" | "hub_authenticated";
    threadId: string;
    repo?: string;
    sessionId?: string;
    messageId?: string;
    originKind?: "context_copy" | "peer_message";
  };
  state: "stored" | "delivered";
  deliveredAt?: string;
}
const FILE = "received-messages.jsonl";
function regular(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1)
    throw new Error("Invalid received message store");
  return true;
}
/** Only called with the direct authenticated hub response, never with tool body text. */
export function recordHubReceived(dataDir: string, value: unknown, channel: "mind-local-hub" | "mind-shared-hub" = "mind-local-hub"): void {
  const page = value as { messages?: unknown[] };
  if (!Array.isArray(page?.messages)) return;
  const file = path.join(dataDir, FILE);
  regular(file);
  const known = new Map(readReceivedJournal(dataDir).map((m) => [m.id, m]));
  for (const raw of page.messages) {
    const m = raw as Record<string, unknown>;
    const p = m["provenance"] as Record<string, unknown> | undefined;
    if (
      m["from_self"] !== false ||
      typeof m["message_id"] !== "string" ||
      typeof m["from"] !== "string" ||
      typeof m["thread_id"] !== "string" ||
      typeof m["text"] !== "string" ||
      typeof p?.["received_at"] !== "string" ||
      !["agent", "human", "service"].includes(String(p["kind"])) ||
      p["channel"] !== channel || !Number.isFinite(Date.parse(p["received_at"]))
    )
      continue;
    const id = `${channel === "mind-shared-hub" ? "shared" : "hub"}:${m["message_id"]}`;
    const prior = known.get(id);
    if (prior) {
      if (prior.text !== m["text"] || prior.source.ref !== m["from"] || prior.source.threadId !== m["thread_id"])
        throw new Error("Conflicting received message identity");
      continue;
    }
    const message: ReceivedMessage = {
      id,
      at: p["received_at"],
      text: m["text"],
      state: channel === "mind-shared-hub" ? "stored" : "delivered",
      source: {
        channel,
        kind: String(p["kind"]),
        ref: m["from"],
        name: m["from"],
        assurance: "hub_authenticated",
        threadId: m["thread_id"],
        messageId: m["message_id"],
        originKind: "peer_message",
      },
    };
    fs.appendFileSync(file, JSON.stringify(message) + "\n", "utf8");
    known.set(id, message);
  }
}
function readReceivedJournal(dataDir: string): ReceivedMessage[] {
  const file = path.join(dataDir, FILE);
  if (!regular(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        const m = JSON.parse(line) as ReceivedMessage;
        return typeof m.id === "string" &&
          typeof m.text === "string" &&
          Number.isFinite(Date.parse(m.at)) &&
          (m.source?.channel === "mind-local-hub" || m.source?.channel === "mind-shared-hub") &&
          m.source.assurance === "hub_authenticated"
          ? [m]
          : [];
      } catch {
        return [];
      }
    });
}
export function readReceivedMessages(
  dataDir: string,
  humanIds: readonly string[] = [],
): ReceivedMessage[] {
  const receipts = readOwnerReceipts(dataDir);
  const messages = readReceivedJournal(dataDir);
  const known = new Set(humanIds);
  for (const m of recipientEntries(dataDir)) {
    known.add(m.id);
    if (m.direction !== "in") continue;
    if (messages.some((entry) => entry.source.channel === "mind-shared-hub" && entry.source.messageId === m.messageId)) continue;
    messages.push({
      id: m.id,
      at: m.at,
      text: m.text,
      state: receipts[m.id] ? "delivered" : "stored",
      source: {
        channel: "mind-shared-hub",
        kind: "agent",
        ref: m.senderRef,
        name: "Auroracle",
        assurance: "hub_authenticated",
        threadId: m.threadId!,
        messageId: m.messageId!,
        originKind: "peer_message",
      },
    });
  }
  for (const t of readRepoConversations(dataDir))
    for (const m of t.messages) {
      known.add(m.id);
      if (m.from !== "repo" || !Number.isFinite(Date.parse(m.at))) continue;
      const deliveredAt = receipts[m.id];
      messages.push({
        id: `repo:${t.id}:${m.id}`,
        at: m.at,
        text: m.text,
        source: {
          channel: "repo-session",
          kind: "agent",
          ref: t.sessionId || t.id,
          name: `${t.runtime || "Session"} · ${t.repo}`,
          repo: t.repo,
          sessionId: t.sessionId,
          threadId: t.id,
          assurance: "channel_record",
        },
        state: deliveredAt ? "delivered" : "stored",
        ...(deliveredAt ? { deliveredAt } : {}),
      });
    }
  for (const m of readOwnerInboxHistory(dataDir)) {
    if (known.has(m.id) || !Number.isFinite(Date.parse(m.at))) continue;
    const deliveredAt = receipts[m.id];
    const origin = m.origin;
    if (origin && messages.some((entry) => entry.source.channel === origin.channel && entry.source.messageId === origin.messageId)) continue;
    const channel = origin?.channel;
    messages.push({
      id: `inbox:${m.id}`,
      at: m.at,
      text: m.text,
      state: deliveredAt ? "delivered" : "stored",
      source: {
        channel: channel === "mind-shared-hub" || channel === "mind-local-hub" || channel === "repo-session" ? channel : "local-inbox",
        kind: origin?.kind === "context_copy" ? "contexte" : origin ? "pair" : "unknown",
        ref: origin?.senderRef ?? m.id,
        name: origin?.author ?? "Relais local · expéditeur non attesté",
        assurance: "channel_record",
        threadId: origin?.threadId ?? "inconnu",
        ...(origin ? { messageId: origin.messageId, originKind: origin.kind } : {}),
      },
      ...(deliveredAt ? { deliveredAt } : {}),
    });
  }
  return [...new Map(messages.map((m) => [m.id, m])).values()].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  );
}
