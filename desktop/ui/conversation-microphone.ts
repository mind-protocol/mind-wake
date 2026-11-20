import { requestConversationReply, type ConversationInvoke } from "./conversation-send.js";
import { voiceChatController } from "./voice-chat-controller.js";
import { voiceScreenshotsPreference } from "./voice-screenshots.js";
import { selectedDictationProvider } from "./dictation-provider.js";

export function mountConversationMicrophone(invoke: ConversationInvoke, field: HTMLTextAreaElement, saveDraft: () => void, refresh: () => Promise<void>): void {
  const button = document.getElementById("chat-microphone") as HTMLButtonElement | null;
  const cancel = document.getElementById("chat-microphone-cancel") as HTMLButtonElement | null;
  const status = document.getElementById("chat-microphone-status");
  const provider = document.getElementById("chat-transcription-provider") as HTMLSelectElement | null;
  if (!button || !cancel || !status || !provider) return;
  let recording = false, pending = 0, starting = false;
  const render = () => {
    button.textContent = starting ? "◌ Connexion…" : recording ? (pending ? "◌ Envoi… · ⏹ Arrêter" : "⏹ Arrêter le micro") : pending ? "◌ Envoi…" : "🎙 Micro";
    button.setAttribute("aria-pressed", String(recording));
    button.setAttribute("aria-busy", String(starting || pending > 0));
    button.disabled = starting || (pending > 0 && !recording);
    cancel.disabled = !(starting || recording || pending > 0);
    provider.disabled = starting || recording || pending > 0;
  };
  const input = voiceChatController({
    owner: "le fil principal",
    overlapMs: 0,
    provider: () => selectedDictationProvider(provider.value),
    screenshots: voiceScreenshotsPreference(undefined, false),
    snapshot: async () => "",
    invoke: async (command, args) => {
      const result = await invoke(command, args);
      if (result.ok !== true) throw Error(String(result.error?.message ?? "Transcription indisponible."));
      return result.data ?? {};
    },
    send: async (text, _images, metadata) => {
      if (!text.trim() || input.cancelled(metadata.requestId)) return;
      try {
        if (text.length > 4000) throw Error("La transcription dépasse 4 000 caractères.");
        const result = await invoke("wake_reply", {text: text.trim(), idempotencyKey: `voice-${metadata.requestId}`});
        if (result.ok !== true) throw Error(String(result.error?.message ?? "Envoi refusé."));
      } catch (error) {
        field.value = [field.value.trimEnd(), text.trim()].filter(Boolean).join("\n");
        saveDraft();
        throw Error(`Envoi vocal échoué : ${String(error)} Transcription conservée en brouillon.`);
      }
      void refresh();
      if (!input.cancelled(metadata.requestId)) status.textContent = await requestConversationReply(invoke);
    },
    state: (active, note) => {
      recording = active;
      status.textContent = note;
      render();
    },
    processing: count => { pending = count; render(); },
  });
  button.addEventListener("click", () => {
    if (input.active()) { input.stop(); return; }
    starting = true;
    render();
    void input.start().finally(() => { starting = false; render(); });
  });
  cancel.addEventListener("click", () => input.stop(true));
  window.addEventListener("pagehide", () => input.stop(true));
  render();
}
