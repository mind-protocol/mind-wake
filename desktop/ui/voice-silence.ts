export const VOICE_SILENCE_MS = 2_000;
const SPEECH_RMS = 0.012;

/** Root-mean-square level of one audio frame (0 for an empty frame). */
export function voiceRms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return Math.sqrt(energy / samples.length);
}

export function hasVoice(samples: Float32Array, threshold = SPEECH_RMS): boolean {
  return voiceRms(samples) >= threshold;
}

export function watchVoiceSilence(
  stream: MediaStream,
  playbackActive: () => boolean,
  onSilence: () => void,
) {
  if (typeof AudioContext === "undefined") return undefined;
  let context: AudioContext | undefined;
  try {
    context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(2048, 1, 1);
    let speech = false;
    let heardAudio = false;
    let quietMs = 0;
    processor.onaudioprocess = ({ inputBuffer }) => {
      heardAudio = true;
      if (playbackActive()) {
        quietMs = 0;
        return;
      }
      if (hasVoice(inputBuffer.getChannelData(0))) {
        speech = true;
        quietMs = 0;
      } else if (speech) {
        quietMs += inputBuffer.duration * 1000;
        if (quietMs >= VOICE_SILENCE_MS) onSilence();
      }
    };
    source.connect(processor);
    // Output stays zeroed. The connection keeps processing audio in the WebView.
    processor.connect(context.destination);
    void context.resume().catch(() => {});
    return {
      hasSpeech: () => speech || !heardAudio,
      reset() { speech = false; quietMs = 0; },
      stop() {
        processor.onaudioprocess = null;
        processor.disconnect();
        source.disconnect();
        void context?.close().catch(() => {});
      },
    };
  } catch {
    void context?.close().catch(() => {});
    return undefined;
  }
}
