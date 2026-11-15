import type { VoiceRecorder } from "./voice-input.js";
import { hasVoice } from "./voice-silence.js";

const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 2_048;
const OPEN_TIMEOUT_MS = 15_000;
const MAX_BUFFERED_FRAMES = Math.ceil(OPEN_TIMEOUT_MS * SAMPLE_RATE / (1_000 * FRAME_SAMPLES));
const TRAILING_FRAMES = 3;
const PRE_ROLL_FRAMES = 2;

function pcmBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const pcm = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]!));
    pcm.setInt16(i * 2, value * (value < 0 ? 0x8000 : 0x7fff), true);
  }
  return btoa(String.fromCharCode(...bytes));
}

export interface RealtimeRecorder extends VoiceRecorder {
  transcript: Promise<string>;
  abort(): void;
}

export function realtimeRecorder(
  stream: MediaStream,
  getToken: () => Promise<string>,
  caption: (text: string) => void,
  onFinish: () => void,
): RealtimeRecorder {
  let context: AudioContext | undefined;
  let processor: ScriptProcessorNode | undefined;
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let settled = false;
  let ready = false;
  let frameCount = 0;
  let failure: Error | undefined;
  const pending: string[] = [];
  const preRoll: string[] = [];
  let trailingFrames = 0;
  const committed: string[] = [];
  const result = Promise.withResolvers<string>();
  void result.promise.catch(() => {});

  function releaseAudio(): void {
    if (processor) {
      processor.onaudioprocess = null;
      processor.disconnect();
      processor = undefined;
    }
    if (context) {
      void context.close().catch(() => {});
      context = undefined;
    }
  }

  function settle(error?: Error): void {
    if (settled) return;
    settled = true;
    failure = error;
    releaseAudio();
    clearTimeout(timer);
    pending.length = 0;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    onFinish();
    if (error) {
      result.reject(error);
      if (!stopped) recorder.onerror?.(new ErrorEvent("error", { message: error.message }));
    } else result.resolve(committed.join(" "));
  }

  function sendFrame(audio: string, commit = false): void {
    if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256_000) {
      settle(Error("ElevenLabs temps réel : flux interrompu."));
      return;
    }
    socket.send(JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: audio,
      sample_rate: SAMPLE_RATE,
      commit,
    }));
  }

  function flush(): void {
    if (!ready || settled) return;
    for (const audio of pending.splice(0)) sendFrame(audio);
    if (!stopped || settled) return;
    if (!frameCount) settle();
    else sendFrame("", true);
  }

  function queueFrame(audio: string): void {
    if (settled) return;
    frameCount++;
    if (ready) sendFrame(audio);
    else if (pending.length < MAX_BUFFERED_FRAMES) pending.push(audio);
    else settle(Error("ElevenLabs temps réel : ouverture trop lente."));
  }

  async function connect(): Promise<void> {
    const token = await getToken();
    if (settled) return;
    const query = new URLSearchParams({
      token,
      model_id: "scribe_v2_realtime",
      audio_format: "pcm_16000",
      commit_strategy: "manual",
    });
    socket = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${query}`);
    socket.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
      if (settled || typeof data !== "string") return;
      try {
        const message = JSON.parse(data) as { message_type?: string; text?: unknown; error?: unknown };
        if (message.message_type === "session_started" && !ready) {
          ready = true;
          if (!stopped) clearTimeout(timer);
          flush();
        } else if (message.message_type === "partial_transcript" && typeof message.text === "string") {
          caption(message.text);
        } else if (message.message_type === "committed_transcript" && typeof message.text === "string") {
          if (message.text.trim()) {
            committed.push(message.text.trim());
            caption(message.text);
          }
          if (stopped) settle();
        } else if (message.message_type === "insufficient_audio_activity" && stopped) {
          settle();
        } else if (message.error !== undefined) {
          settle(Error("ElevenLabs temps réel : transcription refusée."));
        }
      } catch {
        settle(Error("ElevenLabs temps réel : réponse illisible."));
      }
    });
    const disconnected = () => settle(Error("ElevenLabs temps réel : connexion fermée."));
    socket.addEventListener("error", disconnected);
    socket.addEventListener("close", disconnected);
  }

  const recorder: RealtimeRecorder = {
    transcript: result.promise,
    ondataavailable: null,
    onstop: null,
    onerror: null,
    start() {
      try {
        context = new AudioContext({ sampleRate: SAMPLE_RATE });
        const source = context.createMediaStreamSource(stream);
        processor = context.createScriptProcessor(FRAME_SAMPLES, 1, 1);
        processor.onaudioprocess = ({ inputBuffer }) => {
          if (settled || stopped) return;
          const samples = inputBuffer.getChannelData(0);
          const audio = pcmBase64(samples);
          if (hasVoice(samples)) {
            for (const preceding of preRoll.splice(0)) queueFrame(preceding);
            trailingFrames = TRAILING_FRAMES;
            queueFrame(audio);
          } else if (trailingFrames > 0) {
            trailingFrames--;
            queueFrame(audio);
          } else {
            preRoll.push(audio);
            if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
          }
        };
        source.connect(processor);
        // The output remains zeroed. Connecting it keeps WebView2 processing input.
        processor.connect(context.destination);
        timer = setTimeout(() => settle(Error("ElevenLabs temps réel : ouverture expirée.")), OPEN_TIMEOUT_MS);
        void context.resume().catch(() => settle(Error("Audio du microphone indisponible.")));
        void connect().catch(error => settle(error instanceof Error ? error : Error("ElevenLabs indisponible.")));
      } catch {
        // Let the capture controller finish initializing its stop callback first.
        queueMicrotask(() => settle(Error("Audio du microphone indisponible.")));
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      releaseAudio();
      clearTimeout(timer);
      if (!settled) {
        timer = setTimeout(() => settle(Error("ElevenLabs temps réel : finalisation expirée.")), 8_000);
        flush();
      }
      recorder.onstop?.(new Event("stop"));
    },
    abort() {
      const notify = !stopped;
      stopped = true;
      settle(failure);
      if (notify) recorder.onstop?.(new Event("stop"));
    },
  };
  return recorder;
}
