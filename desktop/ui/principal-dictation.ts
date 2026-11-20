import type { ConversationInvoke } from "./conversation-send.js";
import { voiceChatController } from "./voice-chat-controller.js";
import { voiceScreenshotsPreference } from "./voice-screenshots.js";
import { selectedDictationProvider } from "./dictation-provider.js";
import type { InlineMessage, PrincipalFileInvoke } from "./principal-file-editor.js";

/** First segment adds `Humain : …` after the element; later segments of the same dictation extend that line. */
export function dictationRequest(target: InlineMessage, added: InlineMessage | null, text: string): Record<string, unknown> {
  const spoken = text.replace(/\s+/g, " ").trim();
  return added
    ? {action: "principalMessageSave", source: added.source, id: added.id, revision: added.revision, text: `${added.text} ${spoken}`}
    : {action: "principalMessageAppend", source: target.source, id: target.id, revision: target.revision, text: spoken};
}

/**
 * 🎤 on each element of the principal fil (NLR, 20 nov.): dictation with the app's existing STT
 * (same provider selector as the chat microphone), appended to the end of that element.
 */
export function principalDictation(invoke: ConversationInvoke, editFile: PrincipalFileInvoke, saved: () => void) {
  const provider = document.getElementById("chat-transcription-provider") as HTMLSelectElement | null;
  const buttons = new Map<string, Set<HTMLButtonElement>>();
  let target: {message: InlineMessage; added: InlineMessage | null; status: HTMLElement} | null = null;
  let recording = false, pending = 0;
  const render = () => {
    for (const [id, set] of buttons) for (const button of set) {
      if (!button.isConnected) { set.delete(button); continue; }
      const mine = target?.message.id === id;
      button.textContent = mine && recording ? "⏹" : mine && pending ? "◌" : "🎤";
      button.setAttribute("aria-pressed", String(mine && recording));
      button.dataset["active"] = String(mine && (recording || pending > 0));
    }
  };
  const input = voiceChatController({
    owner: "un élément du fil principal",
    overlapMs: 0,
    provider: () => selectedDictationProvider(provider?.value ?? ""),
    screenshots: voiceScreenshotsPreference(undefined, false),
    snapshot: async () => "",
    invoke: async (command, args) => {
      const result = await invoke(command, args);
      if (result.ok !== true) throw Error(String(result.error?.message ?? "Transcription indisponible."));
      return result.data ?? {};
    },
    send: async (text, _images, metadata) => {
      const current = target;
      if (!current || !text.trim() || input.cancelled(metadata.requestId)) return;
      try {
        const result = await editFile(dictationRequest(current.message, current.added, text));
        const id = typeof result["id"] === "string" ? result["id"] : null, revision = typeof result["revision"] === "string" ? result["revision"] : null;
        current.added = id && revision ? {source: current.message.source, id, revision, text: String(result["text"] ?? text)} : null;
        current.status.textContent = "";
        saved();
      } catch (error) {
        current.status.textContent = `Transcription non ajoutée : ${error instanceof Error ? error.message : String(error)} — « ${text.trim()} »`;
        throw error;
      }
    },
    state: (active, note) => { recording = active; if (target && note) target.status.textContent = note; render(); },
    processing: count => { pending = count; render(); },
  });
  window.addEventListener("pagehide", () => input.stop(true));
  return {
    button(bubble: HTMLElement, message: InlineMessage): HTMLButtonElement {
      const button = document.createElement("button"), status = document.createElement("span");
      button.type = "button"; button.className = "principal-dictate"; button.textContent = "🎤";
      button.setAttribute("aria-label", "Dicter un ajout à la fin de cet élément"); button.title = "Dicter un ajout à la fin de cet élément";
      status.className = "principal-delete-status"; status.setAttribute("role", "status");
      bubble.append(status);
      const set = buttons.get(message.id) ?? new Set();
      set.add(button); buttons.set(message.id, set);
      button.onclick = event => {
        event.stopPropagation();
        if (input.active()) { input.stop(); return; }
        target = {message, added: null, status};
        status.textContent = "";
        render();
        void input.start().finally(render);
      };
      render();
      return button;
    },
  };
}
