import { enqueueOwnerMessage } from "../communication/owner-inbox.js";
import { appendRepoMessage } from "../communication/repo-conversations.js";
import path from "node:path";
import fs from "node:fs";
import { SecondThreadStore } from "./second-thread.js";

export function appendCoachReply(dataDir: string, id: string, text: string): void {
  const dir = path.join(dataDir, "coach");
  fs.mkdirSync(dir, { recursive: true });
  const store = new SecondThreadStore(dir);
  try {
    if (!store.get(`message:${id}`)) {
      store.add("agent", text);
      store.set(`message:${id}`, "stored");
    }
  } finally {
    store.close();
  }
}

export function publishCoachMessage(
  dataDir: string,
  threadId: string,
  id: string,
  text: string,
  correlationId: string,
): void {
  const at = new Date().toISOString();
  enqueueOwnerMessage(dataDir, {
    id,
    at,
    text,
    origin: {
      kind: "peer_message",
      channel: "wake-coach",
      author: "Coach",
      senderRef: "wake-coach",
      recipientRef: "principal",
      threadId,
      messageId: id,
      correlationId,
    },
  });
  appendRepoMessage(dataDir, {
    thread: {
      id: "wake-coach",
      repo: "Coach",
      runtime: "Codex",
      sessionId: threadId,
      transcript: "",
    },
    message: { id, at, from: "repo", text },
  });
  appendCoachReply(dataDir, id, text);
}
