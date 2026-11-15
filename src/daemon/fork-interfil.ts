import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { asRecord } from "../adapters/codex/protocol.js";

const CLOSE = "[/agent]";
const OPEN = /^\[agent:fork([2-8])\]/;
const MAX_BODY = 3800;

export interface InterfilDraft {
  from: number;
  to: number;
  text: string;
  at: number;
}
export interface InterfilMessage extends InterfilDraft {
  key: string;
}

function body(text: string): { to: number; text: string; complete: boolean } | null {
  const open = OPEN.exec(text.trimStart());
  if (!open) return null;
  const value = text.trimStart().slice(open[0].length);
  const end = value.indexOf(CLOSE);
  if (end !== -1) {
    if (value.slice(end + CLOSE.length).trim()) return null;
    return { to: Number(open[1]), text: value.slice(0, end).trim(), complete: true };
  }
  let length = CLOSE.length - 1;
  while (length > 0 && !value.endsWith(CLOSE.slice(0, length))) length--;
  return { to: Number(open[1]), text: value.slice(0, value.length - length).trim(), complete: false };
}

export function interfilStream(
  from: number,
  thread: string,
  permitted: (to: number) => boolean,
  show: (draft: InterfilDraft | null) => void,
) {
  let active: { turn: string; item: string; text: string } | undefined;
  let message: InterfilMessage | undefined;
  return {
    event(method: string, params: Record<string, unknown>) {
      const turn = params["turnId"];
      if (params["threadId"] !== thread || typeof turn !== "string") return;
      const item = asRecord(params["item"]);
      if (method === "item/started" && item?.["type"] === "agentMessage") {
        if (active) show(null);
        active = item["phase"] === "final_answer" && typeof item["id"] === "string"
          ? { turn, item: item["id"], text: "" } : undefined;
        return;
      }
      if (!active || active.turn !== turn) return;
      if (method === "item/agentMessage/delta" && params["itemId"] === active.item
        && typeof params["delta"] === "string") {
        active.text += params["delta"];
        if (active.text.length > MAX_BODY + 64) {
          active = undefined;
          show(null);
          return;
        }
        const parsed = body(active.text);
        if (parsed?.text && parsed.to !== from && permitted(parsed.to))
          show({ from, to: parsed.to, text: parsed.text, at: Date.now() });
        else show(null);
      }
      if (method === "item/completed" && item?.["id"] === active.item
        && item["type"] === "agentMessage" && item["phase"] === "final_answer") {
        const parsed = typeof item["text"] === "string" ? body(item["text"]) : null;
        if (!message && parsed?.complete && parsed.text.length > 0 && parsed.text.length <= MAX_BODY
          && parsed.to !== from && permitted(parsed.to)) {
          const key = createHash("sha256").update(JSON.stringify([thread, turn, active.item])).digest("hex");
          message = { from, to: parsed.to, text: parsed.text, at: Date.now(), key: `interfil:${key}` };
        }
        active = undefined;
      }
    },
    final() {
      return message && permitted(message.to) ? message : undefined;
    },
  };
}

function draftPath(dataDir: string, from: number) {
  return path.join(dataDir, "forks", String(from), "interfil-live.json");
}

export function interfilPublisher(dataDir: string, from: number) {
  const file = draftPath(dataDir, from);
  const temp = file + ".tmp";
  let pending: InterfilDraft | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    pending = null;
    try { fs.rmSync(file, { force: true }); } catch { /* Expiry also clears stale drafts. */ }
  };
  return {
    show(draft: InterfilDraft | null) {
      if (!draft) { if (pending) close(); return; }
      pending = draft;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!pending) return;
        try {
          fs.writeFileSync(temp, JSON.stringify(pending), { mode: 0o600 });
          fs.renameSync(temp, file);
        } catch {
          try { fs.rmSync(temp, { force: true }); } catch { /* Draft is best effort. */ }
        }
      }, 125);
    },
    close,
  };
}

