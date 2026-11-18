/** Réglages · Vocabulaire de transcription (stt-vocabulary.json du profil).
 * Une ligne par mot ou expression ; lu par la dictée desktop, les vocaux Telegram et les appels
 * Lumina (faster-whisper `hotwords`) ; ElevenLabs Scribe seulement si la case payante est cochée.
 * Passe par la commande Tauri existante `voice_input` (actions `vocabulary` / `vocabulary_save`). */

export interface SttVocabularyView { text: string; elevenlabsKeyterms: boolean; source?: string; error?: string }
type Envelope = { ok?: unknown; data?: unknown; error?: { message?: unknown } };
export type VoiceInputInvoke = (action: "vocabulary" | "vocabulary_save", audio?: string) => Promise<Envelope>;

export const STT_VOCABULARY_UNAVAILABLE = "Disponible seulement dans l’app desktop MIND Wake.";

function view(envelope: Envelope): SttVocabularyView {
  if (!envelope.ok) throw Error(typeof envelope.error?.message === "string" ? envelope.error.message : "refusé");
  const data = envelope.data as Partial<SttVocabularyView> | undefined;
  if (typeof data?.text !== "string") throw Error("Réponse de vocabulaire invalide.");
  return { text: data.text, elevenlabsKeyterms: data.elevenlabsKeyterms === true, ...(data.source ? { source: data.source } : {}), ...(data.error ? { error: data.error } : {}) };
}

export function mountSttVocabularySettings(
  form: HTMLFormElement,
  terms: HTMLTextAreaElement,
  elevenlabs: HTMLInputElement,
  status: HTMLElement,
  invoke: VoiceInputInvoke | undefined,
): Promise<void> {
  const controls = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input,textarea,button")];
  const busy = (on: boolean) => { for (const control of controls) control.disabled = on; };
  if (!invoke) { busy(true); status.textContent = STT_VOCABULARY_UNAVAILABLE; return Promise.resolve(); }
  const show = (value: SttVocabularyView, saved: boolean) => {
    terms.value = value.text;
    elevenlabs.checked = value.elevenlabsKeyterms;
    const count = value.text.split("\n").filter(Boolean).length;
    status.textContent = value.error
      ? `Fichier illisible (${value.error}) : liste initiale utilisée.`
      : `${count} mot${count > 1 ? "s" : ""}${saved ? " enregistrés" : value.source === "default" ? " (liste initiale)" : ""}. Pris en compte à la prochaine transcription.`;
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    busy(true);
    status.textContent = "Enregistrement…";
    void invoke("vocabulary_save", JSON.stringify({ text: terms.value, elevenlabsKeyterms: elevenlabs.checked }))
      .then((envelope) => show(view(envelope), true))
      .catch((error: unknown) => { status.textContent = error instanceof Error ? error.message : String(error); })
      .finally(() => busy(false));
  });
  busy(true);
  return invoke("vocabulary")
    .then((envelope) => show(view(envelope), false))
    .catch((error: unknown) => { status.textContent = error instanceof Error ? error.message : String(error); })
    .finally(() => busy(false));
}
