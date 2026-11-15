import fs from "node:fs";
import path from "node:path";
import { asRecord } from "../adapters/codex/protocol.js";

const OPEN = "[user]";
const CLOSE = "[/user]";
const MAX_DRAFT = 500;
const PUBLISH_INTERVAL = 125;

/** Keep the existing final message, including any text outside the optional wrapper. */
export function unwrapUserReply(text: string): string {
  const start = text.trimStart();
  if (!start.startsWith(OPEN)) return text;
  const end = start.indexOf(CLOSE, OPEN.length);
  if (end === -1) return start.slice(OPEN.length).trimStart();
  return [start.slice(OPEN.length, end).trim(), start.slice(end + CLOSE.length).trim()]
    .filter(Boolean)
    .join("\n\n");
}

/** The app-server delta has no phase. Admit it only after a matching public final item starts. */
export function replyDraft(threadId: string, show: (text: string) => void) {
  let active: { turnId: string; itemId: string; text: string } | undefined;
  return (method: string, params: Record<string, unknown>): void => {
    if (params["threadId"] !== threadId || typeof params["turnId"] !== "string") return;
    const item = asRecord(params["item"]);
    if (method === "item/started" && item?.["type"] === "agentMessage") {
      if (active) show("");
      active =
        item["phase"] === "final_answer" && typeof item["id"] === "string"
          ? { turnId: params["turnId"], itemId: item["id"], text: "" }
          : undefined;
      return;
    }
    if (!active || active.turnId !== params["turnId"]) return;
    if (method === "item/completed" && item?.["id"] === active.itemId) {
      active = undefined;
      return;
    }
    if (
      method !== "item/agentMessage/delta" ||
      params["itemId"] !== active.itemId ||
      typeof params["delta"] !== "string"
    )
      return;
    active.text = (active.text + params["delta"]).trimStart();
    if (!active.text.startsWith(OPEN)) {
      if (!OPEN.startsWith(active.text)) active = undefined;
      return;
    }
    let body = active.text.slice(OPEN.length);
    const close = body.indexOf(CLOSE);
    if (close >= 0) {
      body = body.slice(0, close);
      active = undefined;
    } else {
      // A trailing prefix of the closing marker may be split over multiple deltas.
      for (let length = CLOSE.length - 1; length > 0; length--) {
        if (!body.endsWith(CLOSE.slice(0, length))) continue;
        body = body.slice(0, -length);
        break;
      }
      // Bound the parsing buffer while allowing a long answer to continue scrolling.
      if (active.text.length > MAX_DRAFT + OPEN.length + CLOSE.length)
        active.text = OPEN + active.text.slice(-MAX_DRAFT - CLOSE.length);
    }
    if (body.trim()) show(body.trim().slice(-MAX_DRAFT));
  };
}

/** Replace a bounded, private live snapshot. Delivery of the final reply never depends on it. */
export function publishReplyDraft(dataDir: string, id: number, turn: string) {
  const file = path.join(dataDir, "forks", String(id), "reply-live.json");
  const temp = path.join(path.dirname(file), `reply-live-${turn}.tmp`);
  let text = "";
  let lastWrite = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    lastWrite = Date.now();
    try {
      fs.writeFileSync(temp, JSON.stringify({ turn, text, at: lastWrite }), { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        /* Keep delivery independent. */
      }
    }
  };
  const removeOwn = () => {
    try {
      if (asRecord(JSON.parse(fs.readFileSync(file, "utf8")))?.["turn"] === turn)
        fs.rmSync(file, { force: true });
    } catch {
      /* Desktop also expires old snapshots. */
    }
  };
  return {
    update(next: string) {
      if (next === text) return;
      text = next;
      if (timer) return;
      const remaining = PUBLISH_INTERVAL - (Date.now() - lastWrite);
      if (remaining <= 0) flush();
      else timer = setTimeout(flush, remaining);
    },
    close(completed: boolean) {
      if (timer) clearTimeout(timer);
      if (completed && text) {
        // Let the desktop render a fast answer from real deltas even if it finishes between polls.
        if (timer) flush();
        setTimeout(removeOwn, 4_000).unref();
      } else removeOwn();
    },
  };
}
