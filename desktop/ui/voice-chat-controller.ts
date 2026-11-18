import { voiceInput, audioBase64 } from "./voice-input.js";
import { transcribeUsingProvider, type DictationProvider } from "./dictation-provider.js";
import { realtimeRecorder, type RealtimeRecorder } from "./realtime-transcription.js";
import { watchVoiceSilence } from "./voice-silence.js";
import { watchBargeIn } from "./voice-barge-in.js";

type CaptureOptions = Parameters<typeof voiceInput>[0];
let microphoneLease: { token: symbol; owner: string } | undefined;
let speaking = false;
let captionSequence = 0;
const liveStreams = new Set<MediaStream>();
const currentLease = () => microphoneLease;
let bargeIn: { enabled(): boolean; interrupt(): void } | undefined;
let bargeInWatch: { stream: MediaStream; stop(): void } | undefined;
type BargeInWatcher = (stream: MediaStream, onVoice: () => void) => { stream: MediaStream; stop(): void } | undefined;
let bargeInWatcher: BargeInWatcher = watchBargeIn;

/** Registers who stops the agent's voice when the human speaks over it (none: today's behaviour). */
export function voiceChatBargeIn(
  options: { enabled(): boolean; interrupt(): void } | undefined,
  watcher: BargeInWatcher = watchBargeIn,
): void {
  disarmBargeIn();
  bargeIn = options;
  bargeInWatcher = watcher;
  if (speaking) armBargeIn();
}
function disarmBargeIn(stream?: MediaStream): void {
  if (!bargeInWatch || (stream && bargeInWatch.stream !== stream)) return;
  bargeInWatch.stop();
  bargeInWatch = undefined;
}
function armBargeIn(): void {
  if (bargeInWatch || !bargeIn?.enabled()) return;
  for (const stream of liveStreams) {
    const watch = bargeInWatcher(stream, () => {
      // Once per playback: the detector is gone before the player reacts.
      disarmBargeIn();
      bargeIn?.interrupt();
    });
    if (watch) {
      bargeInWatch = watch;
      return;
    }
  }
}

/** One playback gate for every dictation surface, including acquisition during playback.
 * Dictation tracks stay muted while the agent speaks; barge-in listens on a separate clone. */
export function voiceChatPlayback(active: boolean): void {
  speaking = active;
  for (const stream of liveStreams) for (const track of stream.getTracks()) track.enabled = !active;
  if (active) armBargeIn();
  else disarmBargeIn();
}

/** Shared microphone lease, acquisition, continuous slicing, STT and cancellation.
 * Delivery remains an adapter: principal fanout is not Fork delivery. */
export function voiceChatController(
  options: Omit<
    CaptureOptions,
    "microphone" | "recorder" | "transcribe" | "cancelTranscription"
  > & {
    owner: string;
    provider(): DictationProvider;
    invoke(command: string, args: Record<string, unknown>): Promise<{ text?: string; token?: string; keyterms?: unknown }>;
  },
) {
  let stream: MediaStream | undefined;
  let lease: symbol | undefined;
  let request: { id: string; provider: DictationProvider } | undefined;
  const realtime = new Set<RealtimeRecorder>();
  const currentRequest = () => request;
  const release = (token: symbol | undefined): void => {
    if (token && microphoneLease?.token === token) microphoneLease = undefined;
    if (lease === token) lease = undefined;
  };
  const input = voiceInput({
    ...options,
    microphone: async () => {
      if (microphoneLease)
        throw Error(
          `Microphone utilisé par ${microphoneLease.owner}. Arrêter Voice sur cette surface avant de démarrer ici.`,
        );
      const token = Symbol(options.owner);
      lease = token;
      microphoneLease = { token, owner: options.owner };
      try {
        if (!("mediaDevices" in navigator) || !("MediaRecorder" in globalThis))
          throw Error("Microphone indisponible dans cette fenêtre.");
        const provider = options.provider();
        const acquired = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        if (currentLease()?.token !== token) {
          for (const track of acquired.getTracks()) track.stop();
          throw Error("Capture annulée pendant l’autorisation du microphone.");
        }
        for (const track of acquired.getTracks()) track.enabled = !speaking;
        const event = (globalThis as typeof globalThis & { __TAURI__?: { event?: {
          emitTo?(target: string, event: string, payload: string): Promise<void>;
        } } }).__TAURI__?.event;
        const captions = (text: string): void => {
          void event?.emitTo?.("paint", "voice-dictation-subtitle", text).catch(() => {});
        };
        return {
          transcriptionProvider: provider,
          activate: () => {
            stream = acquired;
            liveStreams.add(acquired);
            if (speaking) armBargeIn();
          },
          watchSilence: (finalize) => watchVoiceSilence(acquired, () => speaking, finalize),
          recorder: () => {
            if (provider !== "elevenlabs" || !event?.emitTo) return new MediaRecorder(acquired);
            const sequence = ++captionSequence;
            captions("");
            const recorder = realtimeRecorder(acquired, async () => {
              const response = await options.invoke("elevenlabs", { action: "realtime_transcription_token" });
              if (!response.token) throw Error("ElevenLabs temps réel : jeton indisponible.");
              return { token: response.token, keyterms: Array.isArray(response.keyterms) ? response.keyterms.filter((term): term is string => typeof term === "string") : [] };
            }, text => {
              if (sequence === captionSequence && !speaking) captions(text);
            }, () => realtime.delete(recorder));
            realtime.add(recorder);
            return recorder;
          },
          stop: (discard) => {
            disarmBargeIn(acquired);
            for (const track of acquired.getTracks()) track.stop();
            liveStreams.delete(acquired);
            if (stream === acquired) stream = undefined;
            release(token);
            if (discard) {
              ++captionSequence;
              captions("");
            }
          },
        };
      } catch (error) {
        release(token);
        throw error;
      }
    },
    recorder: () => {
      if (!stream) throw Error("Microphone fermé");
      return new MediaRecorder(stream);
    },
    transcribe: async (audio, metadata) => {
      const provider = metadata.transcriptionProvider ?? "current";
      request = { id: metadata.requestId, provider };
      try {
        const encoded = await audioBase64(audio);
        if (input.cancelled(metadata.requestId)) return "";
        return await transcribeUsingProvider(provider, {
          current: async () =>
            (
              await options.invoke("voice_input", {
                action: "transcribe",
                audio: encoded,
              })
            ).text ?? "",
          elevenlabs: async () =>
            (
              await options.invoke("elevenlabs", {
                action: "transcribe",
                payload: {
                  audio: encoded,
                  request_id: metadata.requestId,
                  capturedAt: metadata.capturedAt,
                },
              })
            ).text ?? "",
        });
      } finally {
        if (currentRequest()?.id === metadata.requestId) request = undefined;
      }
    },
    cancelTranscription: () => {
      for (const recorder of realtime) recorder.abort();
      if (request?.provider === "elevenlabs")
        void options
          .invoke("elevenlabs", {
            action: "cancel_transcription",
            payload: request.id,
          })
          .catch(() => {});
    },
  });
  return {
    ...input,
    stream: () => stream,
    stop: (discard = false) => {
      input.stop(discard);
      release(lease);
    },
    dispose: () => {
      input.stop(true);
      release(lease);
    },
  };
}
