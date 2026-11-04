export type VoiceState = { phase: 'idle' | 'requesting' | 'recording' | 'transcribing'; message: string | null };
export type VoiceClip = { audio: Blob | ArrayBuffer; mime: string; cleanup?: () => Promise<void> };
export type VoiceRecording = { stop: () => Promise<VoiceClip>; cancel: () => Promise<void> };
export class VoiceError extends Error { code: string; constructor(code: string) { super(code); this.code = code; } }
export function voiceErrorMessage(error: unknown) {
  if (!(error instanceof VoiceError)) return 'Le micro n’a pas pu être utilisé. Aucun message n’a été envoyé.';
  return ({ permission_denied: 'Accès au microphone refusé. Aucun enregistrement n’a démarré.',
    secure_context_required: 'Le micro web nécessite HTTPS ou localhost. Depuis ce lien Wi-Fi en HTTP, utilise le chat texte.',
    microphone_unavailable: 'Aucun microphone compatible n’est disponible.', recording_too_large: 'L’enregistrement dépasse 4 Mo.',
    recording_cancelled: 'Enregistrement annulé.', empty_audio: 'Aucun audio n’a été enregistré.' } as Record<string, string>)[error.code]
    ?? 'Enregistrement indisponible. Aucun message n’a été envoyé.';
}
export function createVoiceController({ begin, transcribe, onTranscript, onState, describeError = voiceErrorMessage,
  maxDurationMs = 60_000 }: { begin: (signal: AbortSignal) => Promise<VoiceRecording>;
  transcribe: (clip: VoiceClip, signal: AbortSignal) => Promise<string>; onTranscript: (text: string) => void;
  onState: (state: VoiceState) => void; describeError?: (error: unknown) => string; maxDurationMs?: number }) {
  let phase: VoiceState['phase'] = 'idle'; let generation = 0; let recording: VoiceRecording | null = null;
  let abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const set = (next: VoiceState['phase'], message: string | null = null) => { phase = next; onState({ phase, message }); };
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const api = {
    async start() {
      if (phase !== 'idle') return;
      const current = ++generation; abort = new AbortController(); set('requesting');
      try {
        const result = await begin(abort.signal);
        if (current !== generation) { await result.cancel(); return; }
        recording = result; set('recording'); timer = setTimeout(() => { void api.finish(); }, maxDurationMs);
      } catch (error) { if (current === generation) set('idle', describeError(error)); }
    },
    async finish() {
      if (phase !== 'recording' || !recording) return;
      clearTimer(); const current = generation; const rec = recording; recording = null; set('transcribing');
      let clip: VoiceClip | undefined;
      try {
        clip = await rec.stop();
        if (current !== generation) return;
        const text = await transcribe(clip, abort.signal);
        if (current !== generation) return;
        if (text.trim()) onTranscript(text.trim());
        set('idle', text.trim() ? 'Transcription ajoutée au brouillon. Relis-la avant d’envoyer.' : 'Aucune parole reconnue. Aucun message envoyé.');
      } catch (error) { if (current === generation) set('idle', describeError(error)); }
      finally { await clip?.cleanup?.(); }
    },
    async cancel() {
      ++generation; clearTimer(); abort.abort(); const rec = recording; recording = null;
      set('idle', 'Enregistrement annulé. Aucun message envoyé.');
      try { await rec?.cancel(); } catch { /* Discard, never transcribe a cancelled clip. */ }
    },
  };
  return api;
}
