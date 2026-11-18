import { conversation, conversationText, plainText, renderConversationMeta } from "./conversation.js";
import { conversationWindow, conversationMessageCount } from "./conversation-viewport.js";
import { bindChatDraft } from "./chat-draft.js";
import { copyButton } from "./copy-button.js";
import { authorMarker } from "./author-tint.js";

/** The saved human/agent conversation is independent of the lifetime of a call. */
export function mountConversation(options: {
  invoke(command: string, args: Record<string, unknown>): Promise<{ok?: unknown; error?: {message?: unknown}}>;
  decorate(body: HTMLElement, text: string): void;
}): {refresh(): Promise<void>} {
  const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const panel = el("view-chat"), list = el("chat"), note = el("chat-note"), status = el("chat-status");
  const field = el<HTMLTextAreaElement>("chat-text"), form = el<HTMLFormElement>("chat-form");
  const older = el<HTMLButtonElement>("chat-older");
  let storage: Storage | undefined;
  try { storage = localStorage; } catch { /* Storage is optional. */ }
  const saveDraft = bindChatDraft(field, {value: "owner", addEventListener() {}}, storage);
  let count = 100, busy = false, again = false, signature = "", history = false;
  let sending = false, pending: {text: string; key: string} | null = null;
  async function refresh(): Promise<void> {
    if (panel.hidden) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const model = conversation(await options.invoke("wake_messages", {limit: count * 3 + 60}));
      if (!model) throw new Error("Format des messages inattendu.");
      const items = conversationWindow(model.items, count);
      const next = JSON.stringify(items);
      note.textContent = model.note ?? (items.length ? "" : "Aucun message pour le moment.");
      older.hidden = conversationMessageCount(model.items) <= count && !model.truncated;
      if (next === signature) return;
      const follow = !history && (!signature || list.scrollHeight - list.scrollTop - list.clientHeight < 100);
      const top = list.scrollTop, height = list.scrollHeight;
      list.replaceChildren(...items.map(item => {
        const li = document.createElement("li"), meta = document.createElement("small"), body = document.createElement("div");
        li.dataset["self"] = String(item.from === "human");
        li.dataset["from"] = item.from;
        if (item.id) li.dataset["messageId"] = item.id;
        renderConversationMeta(meta, item);
        const marker = authorMarker(li, item.from === "human" ? "owner" : null);
        if (marker) meta.prepend(marker);
        body.textContent = conversationText(item, plainText);
        body.style.whiteSpace = "pre-wrap";
        options.decorate(body, item.text);
        li.append(meta, body, copyButton(() => item.text));
        return li;
      }));
      list.scrollTop = follow ? list.scrollHeight : history ? top + list.scrollHeight - height : top;
      signature = next;
      history = false;
    } catch (error) {
      note.textContent = `Messages indisponibles : ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      busy = false;
      if (again) { again = false; void refresh(); }
    }
  }
  older.addEventListener("click", () => {count += 100; history = true; void refresh();});
  form.addEventListener("submit", event => {
    event.preventDefault();
    void send();
  });
  field.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  async function send(): Promise<void> {
    const text = field.value.trim();
    if (!text || sending) return;
    if (pending?.text !== text) pending = {text, key: `ui-${crypto.randomUUID()}`};
    sending = true;
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    button.disabled = true;
    status.textContent = "Envoi…";
    try {
      const result = await options.invoke("wake_reply", {text, idempotencyKey: pending.key});
      if (result.ok !== true) throw new Error(String(result.error?.message ?? "Envoi refusé."));
      if (field.value.trim() === text) { field.value = ""; saveDraft(); }
      pending = null;
      status.textContent = "Message enregistré.";
      await refresh();
    } catch (error) {
      status.textContent = `Non envoyé : ${error instanceof Error ? error.message : String(error)}. Brouillon conservé.`;
    } finally { sending = false; button.disabled = false; }
  }
  setInterval(() => void refresh(), 5000);
  return {refresh};
}
