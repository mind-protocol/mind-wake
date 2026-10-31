/** Host-only receipt persistence. No execution transitions or model queue writes. */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { validHookAck, wire, type HookAckEnvelope } from "./peer-task-protocol.js";

export function persistPeerHookAck(
  dir: string,
  localRef: string,
  senderRef: string,
  threadId: string,
  ack: HookAckEnvelope,
  endpoint?: string,
): void {
  if (
    !validHookAck(wire(ack)) ||
    ack.recipient_ref !== localRef ||
    ack.receiver_ref !== senderRef ||
    !senderRef.startsWith("agent-")
  )
    return;
  const file = path.join(dir, "peer-tasks.sqlite");
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw Error("Invalid peer task store");
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma("busy_timeout=5000");
    db.transaction(() => {
      const row = db.prepare("SELECT json FROM tasks WHERE id=?").get(ack.request_id) as
        { json: string } | undefined;
      if (!row) return;
      const task = JSON.parse(row.json) as {
        localRef: string;
        peerRef: string;
        direction: string;
        sharedEndpoint?: string;
        request: { prompt_hash: string; hook_ack?: boolean };
        threadId: string | null;
        messageId: string | null;
        state: string;
        hookAck?: HookAckEnvelope;
      };
      if (
        task.localRef !== localRef ||
        task.peerRef !== senderRef ||
        task.direction !== "outgoing" ||
        task.request.hook_ack !== true ||
        task.request.prompt_hash !== ack.prompt_hash ||
        (endpoint !== undefined && task.sharedEndpoint !== endpoint)
      )
        return;
      // An ACK may race the send response. Leave the host cursor retryable.
      if (task.state === "outbound_pending") throw Error("Peer request send still pending");
      if (task.threadId !== threadId || task.messageId !== ack.request_message_id) return;
      if (task.hookAck) {
        if (wire(task.hookAck) !== wire(ack)) throw Error("Conflicting peer hook receipt");
        return;
      }
      task.hookAck = ack;
      db.prepare("UPDATE tasks SET json=? WHERE id=?").run(JSON.stringify(task), ack.request_id);
    })();
  } finally {
    db.close();
  }
}
