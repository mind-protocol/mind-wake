import { claimDuoReminder, finishDuoReminder } from "./duo-reminder.js";
/** Trusted Claude command hook. Paths/session come from launcher args, never tool input. */
import { heldForFastReply, takeOwnerMessagesForHook } from "./owner-inbox.js";
import { ownerMessageText } from "./owner-content.js";
import { randomUUID } from "node:crypto";
import { claimProgressReminder, finishProgressReminder } from "./owner-progress-reminder.js";
import { claimSessionReminders, finishSessionReminders } from "../daemon/wake-reminders.js";

export function ownerInboxHook(
  dataDir: string,
  expectedSession: string,
  input: unknown,
): object | null {
  if (input === null || typeof input !== "object") return null;
  const event = input as Record<string, unknown>;
  if (event["session_id"] !== expectedSession || event["agent_id"] !== undefined) return null;
  const name = event["hook_event_name"];
  if (
    name !== "SessionStart" &&
    name !== "PostToolUse" &&
    name !== "PostToolUseFailure" &&
    name !== "Stop"
  )
    return null;
  // The inbox itself holds messages while a fast reply is being written (every runtime);
  // no reminder replaces them meanwhile. The fast reply arrives as an inbox message.
  if (name !== "Stop" && heldForFastReply(dataDir)) return null;
  const batch = takeOwnerMessagesForHook(dataDir, expectedSession);
  const messages = batch.messages;
  const claim = randomUUID();
  const duo = messages.length ? null : claimDuoReminder(dataDir, claim);
  const reminder = duo ?? (messages.length ? null : claimProgressReminder(dataDir, expectedSession, claim));
  // Rappels ponctuels en minutes échus (set_reminder) : livrés une fois, à côté du reste.
  const timed = claimSessionReminders(dataDir, claim);
  if (messages.length === 0 && reminder === null && timed === null && batch.deferred === 0) return null;
  const context = [
    ...(timed === null ? [] : [timed]),
    ...(reminder === null ? [] : [reminder]),
    messages.map(({ image: _image, ...message }) => ownerMessageText(message)).join("\n\n"),
    ...(batch.deferred > 0 ? [`+${String(batch.deferred)} autres messages en attente`] : []),
  ].filter(Boolean).join("\n\n");
  if (timed) finishSessionReminders(dataDir, claim, true);
  if (duo) finishDuoReminder(dataDir, claim, true);
  else if (reminder) finishProgressReminder(dataDir, expectedSession, claim, true);
  return name === "Stop"
    ? { decision: "block", reason: context }
    : { hookSpecificOutput: { hookEventName: name, additionalContext: context } };
}

// This module is an executable hook as well as an importable test boundary.
if (process.argv[2] === "--deliver-owner-inbox") {
  try {
    let stdin = "";
    for await (const chunk of process.stdin) stdin += String(chunk);
    const output = ownerInboxHook(process.argv[3]!, process.argv[4]!, JSON.parse(stdin));
    if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stderr.write(
      `MIND inbox delivery failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
