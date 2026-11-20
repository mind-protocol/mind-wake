import { conversation, conversationText, plainText, renderConversationMeta } from "./conversation.js";
import { conversationWindow, conversationMessageCount, conversationViewport, reconcileConversationChildren } from "./conversation-viewport.js";
import { bindChatDraft } from "./chat-draft.js";
import { copyButton } from "./copy-button.js";
import { authorMarker } from "./author-tint.js";
import { requestConversationReply, type ConversationInvoke } from "./conversation-send.js";
import { mountConversationMicrophone } from "./conversation-microphone.js";
import { renderMarkdown } from "./markdown.js";
import { inlinePrincipalEditor, openPrincipalFile, principalDeleteButton, deleteRequest, principalEditorHue, type PrincipalFileInvoke } from "./principal-file-editor.js";
import { ageRecentWords, changedWords, markRecentWords, type EditedWord } from "./recent-word-edits.js";
import { orderByModification } from "./conversation-edit-order.js";
import { principalDictation } from "./principal-dictation.js";

/** The saved human/agent conversation is independent of the lifetime of a call. */
export function mountConversation(options: {
  invoke: ConversationInvoke;
  editFile?: PrincipalFileInvoke;
  decorate(body: HTMLElement, text: string): void;
}): {refresh(): Promise<void>} {
  const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const panel = el("view-chat"), list = el("chat"), note = el("chat-note"), status = el("chat-status");
  const field = el<HTMLTextAreaElement>("chat-text"), form = el<HTMLFormElement>("chat-form");
  const older = el<HTMLButtonElement>("chat-older");
  let storage: Storage | undefined;
  try { storage = localStorage; } catch { /* Storage is optional. */ }
  const saveDraft = bindChatDraft(field, {value: "owner", addEventListener() {}}, storage);
  mountConversationMicrophone(options.invoke, field, saveDraft, refresh);
  const dictation = options.editFile ? principalDictation(options.invoke, options.editFile, () => { signature = ""; void refresh(); }) : null;
  let count = 100, busy = false, again = false, signature = "", history = false;
  const viewport = conversationViewport(list);
  const rendered = new Map<string, {signature: string; node: HTMLElement}>();
  const wordHistory = new Map<string, EditedWord[]>();
  try {
    const saved: unknown = JSON.parse(storage?.getItem("mind-wake.principal-word-edits") ?? "[]");
    if (Array.isArray(saved)) for (const row of saved) {
      if (Array.isArray(row) && typeof row[0] === "string" && Array.isArray(row[1]) && row[1].every((w: EditedWord) => w && typeof w.text === "string" && typeof w.at === "number")) wordHistory.set(row[0], row[1]);
    }
  } catch { /* An unavailable cache must not prevent the conversation from loading. */ }
  let sending = false, pending: {text: string; key: string} | null = null;
  async function refresh(): Promise<void> {
    ageRecentWords(list);
    if (panel.hidden) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const model = conversation(await options.invoke("wake_messages", {limit: count * 3 + 60}));
      if (!model) throw new Error("Format des messages inattendu.");
      // Pending messages dismissed with × (`_deleted-messages.json`) stay hidden.
      const deleted = new Set<string>(options.editFile ? JSON.parse((await options.editFile({action:"principalDeleted"})).text) : []);
      const visibleItems = orderByModification(model.items.filter(item => !deleted.has(item.id ?? "") && (item.corpusSpeaker || item.from === "human" || item.from === "agent")));
      const items = conversationWindow(visibleItems, count);
      const next = JSON.stringify(items);
      note.textContent = model.note ?? (items.length ? "" : "Aucun message pour le moment.");
      older.hidden = conversationMessageCount(visibleItems) <= count && !model.truncated;
      if (next === signature) return;
      const position = viewport.capture(!signature);
      if (history) position.follow = false;
      const activeKeys = new Set<string>();
      const nodes = items.map((item, index) => {
        const key = item.id ?? `${item.from}:${item.at}:${index}`;
        activeKeys.add(key);
        const itemSignature = JSON.stringify(item);
        const previous = rendered.get(key);
        if (previous?.node.dataset["inlineEditing"] === "true" || previous?.node.dataset["voiceEditing"] === "true") return previous.node;
        if (previous?.signature === itemSignature) return previous.node;
        const li = document.createElement("li"), meta = document.createElement("small"), body = document.createElement("div");
        li.dataset["viewportKey"] = key;
        li.dataset["self"] = String(item.from === "human");
        li.dataset["from"] = item.from;
        if (item.id) li.dataset["messageId"] = item.id;
        renderConversationMeta(meta, item);
        if (item.corpusSource) meta.title = item.corpusSource;
        const marker = item.corpusSource ? null : authorMarker(li, item.from === "human" ? "owner" : null);
        if (marker) meta.prepend(marker);
        if (item.corpusSource) {
          li.classList.add("principal-file-bubble");
          if (item.corpusEditor) li.style.setProperty("--editor-hue", String(principalEditorHue(item.corpusEditor.id)));
          li.dataset["editorKnown"] = String(Boolean(item.corpusEditor));
          const markdown = renderMarkdown(item.text);
          const editedAt = item.corpusEditedAt ? Date.parse(item.corpusEditedAt) : Date.now();
          const words = changedWords(wordHistory.get(key), markdown.textContent ?? "", Number.isFinite(editedAt) ? editedAt : Date.now(), Boolean(signature) && !history);
          wordHistory.set(key, words);
          options.decorate(markdown, item.text);
          markRecentWords(markdown, words, Date.now());
          body.append(markdown);
        } else {
          body.textContent = conversationText(item, plainText);
          body.style.whiteSpace = "pre-wrap";
        }
        if (!item.corpusSource) options.decorate(body, item.text);
        li.append(meta, body, copyButton(() => item.text));
        const reload = () => { rendered.delete(key); signature = ""; void refresh(); };
        if (item.corpusSource && item.id && item.corpusRevision && options.editFile) {
          const message = {source: item.corpusSource, id: item.id, text: item.text, revision: item.corpusRevision};
          inlinePrincipalEditor(body, li, message, options.editFile, reload);
          // One × for everything: a corpus message is removed from its file (revision checked,
          // trace in _editors/supprimes.jsonl); a pending message is dismissed by id.
          li.append(principalDeleteButton(li, deleteRequest(message), options.editFile, reload));
          if (dictation) li.append(dictation.button(li, message));
        } else if (!item.corpusSource && item.id && options.editFile) {
          li.append(principalDeleteButton(li, {action: "principalDismiss", id: item.id}, options.editFile, reload));
        }
        rendered.set(key, {signature: itemSignature, node: li});
        return li;
      });
      for (const [key, entry] of rendered) if (!activeKeys.has(key) && (entry.node.dataset["inlineEditing"] === "true" || entry.node.dataset["voiceEditing"] === "true")) {
        activeKeys.add(key); nodes.push(entry.node);
      }
      reconcileConversationChildren(list, nodes);
      for (const key of rendered.keys()) if (!activeKeys.has(key)) rendered.delete(key);
      viewport.restore(position);
      viewport.watch();
      signature = next;
      try { storage?.setItem("mind-wake.principal-word-edits", JSON.stringify([...wordHistory])); } catch { /* Optional cache. */ }
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
      void refresh();
      status.textContent = await requestConversationReply(options.invoke);
    } catch (error) {
      status.textContent = `Non envoyé : ${error instanceof Error ? error.message : String(error)}. Brouillon conservé.`;
    } finally { sending = false; button.disabled = false; }
  }
  setInterval(() => void refresh(), 5000);
  return {refresh};
}
