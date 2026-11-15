import { hasVoice } from "./voice-silence.js";

/** Barge-in: the human speaking over the agent's voice stops playback.
 * The threshold is deliberately higher than dictation silence detection (0.012 RMS):
 * residual echo after the WebView's echo cancellation must not cut the agent. */
export interface BargeInTuning {
  /** Frame RMS above which a frame counts as the human's voice. */
  thresholdRms: number;
  /** Accumulated voiced duration needed before interrupting. */
  onsetMs: number;
  /** A quiet gap longer than this restarts the onset count (clicks, breaths). */
  gapMs: number;
  /** Ignored start of each playback, while echo cancellation adapts to the new clip. */
  graceMs: number;
}
export const BARGE_IN_TUNING: BargeInTuning = { thresholdRms: 0.03, onsetMs: 300, gapMs: 120, graceMs: 250 };
export const BARGE_IN_STORAGE_KEY = "mind-wake.voice-barge-in";

/** Pure decision: feed successive frames; returns true exactly once, when speech onset is confirmed. */
export function bargeInDetector(tuning: BargeInTuning = BARGE_IN_TUNING) {
  let elapsed = 0,
    voiced = 0,
    quiet = 0,
    fired = false;
  return {
    push(samples: Float32Array, durationMs: number): boolean {
      if (fired) return false;
      elapsed += durationMs;
      if (elapsed <= tuning.graceMs) return false;
      if (hasVoice(samples, tuning.thresholdRms)) {
        voiced += durationMs;
        quiet = 0;
      } else if (voiced > 0) {
        quiet += durationMs;
        if (quiet > tuning.gapMs) voiced = quiet = 0;
      }
      if (voiced < tuning.onsetMs) return false;
      fired = true;
      return true;
    },
    fired: () => fired,
  };
}

/** Listens on a clone of the microphone track: dictation tracks stay muted during playback,
 * so the agent's voice is never recorded into a dictation slice. Calls onVoice at most once. */
export function watchBargeIn(
  stream: MediaStream,
  onVoice: () => void,
  tuning: BargeInTuning = BARGE_IN_TUNING,
): { stream: MediaStream; stop(): void } | undefined {
  if (typeof AudioContext === "undefined" || typeof MediaStream === "undefined") return undefined;
  const source = stream.getAudioTracks().find((track) => track.readyState === "live");
  if (!source) return undefined;
  let context: AudioContext | undefined;
  const clone = source.clone();
  clone.enabled = true;
  try {
    context = new AudioContext();
    const input = context.createMediaStreamSource(new MediaStream([clone]));
    const processor = context.createScriptProcessor(1024, 1, 1);
    const detector = bargeInDetector(tuning);
    processor.onaudioprocess = ({ inputBuffer }) => {
      if (detector.push(inputBuffer.getChannelData(0), inputBuffer.duration * 1000)) onVoice();
    };
    input.connect(processor);
    // Output stays zeroed. The connection keeps processing audio in the WebView.
    processor.connect(context.destination);
    void context.resume().catch(() => {});
    return {
      stream,
      stop() {
        processor.onaudioprocess = null;
        processor.disconnect();
        input.disconnect();
        clone.stop();
        void context?.close().catch(() => {});
      },
    };
  } catch {
    clone.stop();
    void context?.close().catch(() => {});
    return undefined;
  }
}

/** Off by default: echo on loudspeakers is not bounded by automated tests. */
export function bargeInPreference(storage: Pick<Storage, "getItem" | "setItem"> | undefined) {
  return {
    enabled: (): boolean => {
      try {
        return storage?.getItem(BARGE_IN_STORAGE_KEY) === "on";
      } catch {
        return false;
      }
    },
    set(on: boolean): void {
      try {
        storage?.setItem(BARGE_IN_STORAGE_KEY, on ? "on" : "off");
      } catch {
        /* Display preference only. */
      }
    },
  };
}
