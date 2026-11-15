import { afterEach, expect, it, vi } from "vitest";
import { BARGE_IN_TUNING, bargeInDetector, bargeInPreference, watchBargeIn } from "./voice-barge-in.js";

afterEach(() => {
  vi.unstubAllGlobals();
});
const FRAME_MS = 20;
const frame = (rms: number) => new Float32Array(960).fill(rms);
/** Feeds `ms` of constant-level audio; returns the elapsed ms at which the detector fired, if any. */
function feed(detector: ReturnType<typeof bargeInDetector>, rms: number, ms: number, offset = 0): number | undefined {
  let fired: number | undefined;
  for (let t = FRAME_MS; t <= ms; t += FRAME_MS) if (detector.push(frame(rms), FRAME_MS) && fired === undefined) fired = offset + t;
  return fired;
}

it("interrupts after 300 ms of sustained speech once the start-of-clip grace has passed", () => {
  const detector = bargeInDetector();
  expect(feed(detector, 0, 300)).toBeUndefined();
  // Speech from 300 ms: fires when 300 ms of voiced frames have accumulated.
  expect(feed(detector, 0.08, 1000, 300)).toBe(600);
  expect(detector.fired()).toBe(true);
});

it("ignores speech-level audio during the grace period at the start of each clip", () => {
  const detector = bargeInDetector();
  expect(feed(detector, 0.08, BARGE_IN_TUNING.graceMs)).toBeUndefined();
  // Voiced frames counted only after the grace: 300 ms more are needed.
  expect(feed(detector, 0.08, 400, BARGE_IN_TUNING.graceMs)).toBe(BARGE_IN_TUNING.graceMs + 300);
});

it("ignores short clicks and bursts separated by gaps", () => {
  const detector = bargeInDetector();
  feed(detector, 0, 300);
  for (let i = 0; i < 20; i++) {
    expect(feed(detector, 0.5, 100)).toBeUndefined(); // 100 ms click
    expect(feed(detector, 0, 200)).toBeUndefined(); // gap > 120 ms resets
  }
  expect(detector.fired()).toBe(false);
});

it("tolerates the brief dips inside real speech", () => {
  const detector = bargeInDetector();
  feed(detector, 0, 300);
  expect(feed(detector, 0.08, 160)).toBeUndefined();
  expect(feed(detector, 0, 80)).toBeUndefined(); // dip shorter than the 120 ms gap
  expect(feed(detector, 0.08, 160)).toBeDefined();
});

it("ignores residual echo below the barge-in threshold, even above the dictation threshold", () => {
  const detector = bargeInDetector();
  // 0.02 RMS counts as voice for silence detection (0.012) but not for barge-in (0.03).
  expect(feed(detector, 0.02, 10_000)).toBeUndefined();
  expect(feed(detector, 0.029, 10_000)).toBeUndefined();
  expect(detector.fired()).toBe(false);
});

it("fires at most once per detector (one detector per clip)", () => {
  const detector = bargeInDetector();
  feed(detector, 0, 300);
  let fires = 0;
  for (let i = 0; i < 200; i++) if (detector.push(frame(0.08), FRAME_MS)) fires++;
  expect(fires).toBe(1);
});

it("is configurable", () => {
  const detector = bargeInDetector({ thresholdRms: 0.1, onsetMs: 500, gapMs: 50, graceMs: 0 });
  expect(feed(detector, 0.08, 2000)).toBeUndefined();
  expect(feed(detector, 0.2, 1000)).toBe(500);
});

it("listens on a clone of the microphone track and releases it on stop", () => {
  const clone = { enabled: false, stop: vi.fn() };
  const original = { readyState: "live", enabled: false, clone: () => clone };
  const processor = { onaudioprocess: null as ScriptProcessorNode["onaudioprocess"], connect: vi.fn(), disconnect: vi.fn() };
  const close = vi.fn(() => Promise.resolve());
  vi.stubGlobal("MediaStream", class { constructor(public tracks: unknown[]) {} });
  vi.stubGlobal("AudioContext", class {
    destination = {};
    createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
    createScriptProcessor() { return processor; }
    resume() { return Promise.resolve(); }
    close = close;
  });
  const onVoice = vi.fn();
  const stream = { getAudioTracks: () => [original] } as unknown as MediaStream;
  const watch = watchBargeIn(stream, onVoice);
  expect(watch).toBeDefined();
  // The dictation track stays muted; only the clone is enabled for detection.
  expect(original.enabled).toBe(false);
  expect(clone.enabled).toBe(true);
  for (let i = 0; i < 60; i++)
    processor.onaudioprocess?.call(processor as unknown as ScriptProcessorNode, {
      inputBuffer: { duration: FRAME_MS / 1000, getChannelData: () => frame(i < 15 ? 0 : 0.08) },
    } as unknown as AudioProcessingEvent);
  expect(onVoice).toHaveBeenCalledOnce();
  watch?.stop();
  expect(clone.stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(processor.onaudioprocess).toBeNull();
});

it("defaults to off and persists the choice", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const preference = bargeInPreference(storage);
  expect(preference.enabled()).toBe(false);
  preference.set(true);
  expect(bargeInPreference(storage).enabled()).toBe(true);
  preference.set(false);
  expect(preference.enabled()).toBe(false);
  expect(bargeInPreference(undefined).enabled()).toBe(false);
});
