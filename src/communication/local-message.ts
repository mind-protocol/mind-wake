import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { OWNER_MESSAGES_DB, OwnerMessages } from "./owner-messages.js";
import { telegramHandleTable } from "./telegram-handle-route.js";
import { enqueueOwnerMessage, readOwnerMessage } from "./owner-inbox.js";
import { sendNoticeToFork } from "../daemon/forks.js";
import { externalInboxSyncAllowed } from "./external-inbox-policy.js";

/** Auteur des messages `message` adressés à un holder dans `owner-messages.sqlite`. */
export const LOCAL_MESSAGE_AGENT_ID = "local-message";

export function localMessageTargets(dataDir: string) {
  return {
    principal: { role: "Agent principal" },
    ...Object.fromEntries(
      [...telegramHandleTable(dataDir)].map(([id, t]) => [id, { role: t.label }]),
    ),
  };
}

/**
 * Message à un pattern holder du fil principal : publié dans ce fil (`owner-messages.sqlite`, côté
 * agent), là où `readFil` et `mention-wake.ts` lisent. Le `@slug` en tête réveille le holder par
 * mention (`wakeReason`) et chaque autre `@id` du texte réveille sa cible (`routeMentionWakes`).
 * La boîte de la session principale n'est pas le fil des holders : un message posé là seul
 * n'atteignait personne (test du 18 nov. 2026, 20:30Z).
 */
function deliverToHolder(
  dataDir: string,
  slug: string,
  input: { text: string; author: string },
  id: string,
): { status: "recorded" | "duplicate"; id: string } {
  const author = input.author.replace(/\s+/g, " ").trim().slice(0, 80) || "Agent";
  const text = `${author} : @${slug} ${input.text}`.slice(0, 4000);
  const file = path.join(dataDir, OWNER_MESSAGES_DB);
  let prior = false;
  if (fs.existsSync(file)) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      prior = db.prepare("SELECT 1 FROM messages WHERE request_key=?").get(id) !== undefined;
    } catch {
      prior = false;
    } finally {
      db.close();
    }
  }
  const messages = new OwnerMessages(dataDir, LOCAL_MESSAGE_AGENT_ID);
  try {
    messages.publish(text, id);
  } finally {
    messages.close();
  }
  return { status: prior ? "duplicate" : "recorded", id };
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
  if (target?.holder !== undefined) return deliverToHolder(dataDir, target.holder, input, id);
  if (principal) {
    const text = input.text;
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
