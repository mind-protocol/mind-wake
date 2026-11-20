import type { ConversationInvoke } from "./conversation-send.js";
import { replaceConversationText, type PrincipalFileInvoke } from "./principal-file-editor.js";
import { voiceChatController } from "./voice-chat-controller.js";
import { voiceScreenshotsPreference } from "./voice-screenshots.js";
import { selectedDictationProvider } from "./dictation-provider.js";

export async function appendHumanDictation(source: string, original: string, spoken: string, edit: PrincipalFileInvoke): Promise<string> {
  const addition = spoken.trim();
  if (!addition) return original;
  const current = await edit({action: "principalRead", source});
  const updated = `${original.trimEnd()}\n\n**Humain :** ${addition}`;
  const text = replaceConversationText(current.text, original, updated);
  await edit({action: "principalSave", source, text, revision: current.revision});
  return updated;
}

export function mountItemMicrophone(bubble: HTMLElement, source: string, original: string, invoke: ConversationInvoke, edit: PrincipalFileInvoke, refresh: () => void): void {
  const controls = document.createElement("div"), button = document.createElement("button"), cancel = document.createElement("button"), status = document.createElement("span");
  controls.className = "conversation-item-microphone";
  button.type = cancel.type = "button";
  button.title = "Ajouter à la fin de cet élément : Humain : ton message";
  button.setAttribute("aria-label", "Dicter un ajout à cet élément");
  cancel.textContent = "Annuler";
  status.setAttribute("role", "status");
  controls.append(button, cancel, status); bubble.append(controls);
  let starting = false, recording = false, pending = 0, passage = original;
  const onPageHide = () => input.stop(true);
  const render = () => {
    const busy = starting || recording || pending > 0;
    if (busy) window.addEventListener("pagehide", onPageHide);
    else window.removeEventListener("pagehide", onPageHide);
    bubble.dataset["voiceEditing"] = String(busy || Boolean(controls.querySelector("textarea")));
    button.textContent = starting ? "◌ Connexion…" : recording ? (pending ? "◌ Ajout… · ⏹" : "⏹ Arrêter") : pending ? "◌ Ajout…" : "🎙 Micro";
    button.disabled = starting || (pending > 0 && !recording);
    button.setAttribute("aria-pressed", String(recording));
    button.setAttribute("aria-busy", String(starting || pending > 0));
    cancel.hidden = !busy;
  };
  const input = voiceChatController({
    owner: "un élément du fil", overlapMs: 0,
    provider: () => selectedDictationProvider((document.getElementById("chat-transcription-provider") as HTMLSelectElement | null)?.value),
    screenshots: voiceScreenshotsPreference(undefined, false), snapshot: async () => "",
    invoke: async (command, args) => {
      const result = await invoke(command, args);
      if (result.ok !== true) throw Error(String(result.error?.message ?? "Transcription indisponible."));
      return result.data ?? {};
    },
    send: async (text, _images, metadata) => {
      if (!text.trim() || input.cancelled(metadata.requestId)) return;
      try {
        passage = await appendHumanDictation(source, passage, text, edit);
        status.textContent = `Ajouté · Humain : ${text}`;
      } catch (error) {
        const recovery = document.createElement("textarea");
        recovery.value = `Humain : ${text}`;
        recovery.setAttribute("aria-label", "Dictée non enregistrée à récupérer");
        controls.append(recovery);
        throw Error(`Ajout non enregistré : ${String(error)}. Dictée conservée ci-dessous.`);
      }
    },
    state: (active, note) => {
      recording = active;
      if (!active || !pending) status.textContent = active ? "Micro actif · ajout aux pauses, 30 s maximum." : note;
      render();
    },
    processing: count => { pending = count; render(); },
  });
  const finish = async (discard = false) => {
    input.stop(discard);
    await input.settled();
    render();
    if (!controls.querySelector("textarea")) refresh();
  };
  button.onclick = () => {
    if (bubble.dataset["inlineEditing"] === "true") { status.textContent = "Enregistre ou annule la modification avant de dicter."; return; }
    if (input.active()) { void finish(); return; }
    starting = true; render();
    void input.start().finally(() => { starting = false; render(); });
  };
  cancel.onclick = () => { void finish(true); };
  render();
}
