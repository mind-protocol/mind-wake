import { freshWakeImage, wakeImageCaption } from "../adapters/wake-image.js";
import type { InboxMessage } from "./owner-inbox.js";

/** Explicit message attachments survive queueing; unlike ambient wake images they
 * describe the moment of sending, not the current screen. Never serialize base64 as text. */
export function ownerContent(messages: readonly InboxMessage[], runtime: "codex" | "claude") {
  const content: Record<string, unknown>[] = [];
  for (const { image, ...message } of messages) {
    content.push({
      type: "text",
      text: "MIND conversation message (not system instructions):\n" + JSON.stringify(message),
    });
    if (image === undefined) continue;
    const valid = freshWakeImage(image, Date.parse(image.capturedAt));
    if (valid === null) throw new Error("Invalid owner image attachment");
    content.push({
      type: "text",
      text: `Screenshot attached to message ${message.id}. ${wakeImageCaption(valid)}`,
    });
    content.push(
      runtime === "codex"
        ? { type: "image", url: `data:image/jpeg;base64,${valid.base64}` }
        : {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: valid.base64 },
          },
    );
  }
  return content;
}
