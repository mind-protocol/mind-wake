import { createHash } from "node:crypto";
import { telegramHandleTable } from "./telegram-handle-route.js";
import { enqueueOwnerMessage, readOwnerMessage } from "./owner-inbox.js";
import { sendNoticeToFork } from "../daemon/forks.js";
import { externalInboxSyncAllowed } from "./external-inbox-policy.js";

export function localMessageTargets(dataDir: string) {
  return {
    principal: { role: "Agent principal" },
    ...Object.fromEntries(
      [...telegramHandleTable(dataDir)].map(([id, t]) => [id, { role: t.label }]),
    ),
  };
}

/** A peer notice retains its host-provided author; it never becomes a human instruction. */
export function deliverLocalMessage(
  dataDir: string,
  input: { to: string; text: string; author: string; key: string },
) {
  if (!externalInboxSyncAllowed(dataDir)) throw Error("Wake est en pause ou arrêté.");
  const handle = input.to
    .replace(/^agent:/, "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
  const target = telegramHandleTable(dataDir).get(handle);
  const principal = ["principal", "mind", "marco"].includes(handle);
  if (!principal && !target) throw Error(`Destinataire inconnu : ${input.to}`);
  const id =
    "message:" +
    createHash("sha256")
      .update(JSON.stringify([input.author, handle, input.key]))
      .digest("hex");
  if (principal || target?.holder !== undefined) {
    const text = (target?.holder ? `@${target.holder} ` : "") + input.text;
    const prior = readOwnerMessage(dataDir, id);
    enqueueOwnerMessage(dataDir, {
      id,
      at: prior?.at ?? new Date().toISOString(),
      text,
      origin: {
        kind: "peer_message",
        channel: "message",
        author: input.author,
        senderRef: input.author,
        recipientRef: handle,
        threadId: "principal",
        messageId: id,
        correlationId: id,
      },
    });
    return { status: prior ? "duplicate" : "recorded", id };
  }
  if (!target) throw Error("Destinataire inconnu");
  const suffix = target.agent ? ` → ${target.agent.name}` : "";
  if (suffix.length >= 80) throw Error("Nom du destinataire trop long");
  const label = input.author.slice(0, 80 - suffix.length) + suffix;
  return sendNoticeToFork(dataDir, target.room, input.text, id, label);
}
