import { afterEach, expect, it, vi } from "vitest";
import { voiceInput, removeVoiceOverlap, type VoiceRecorder } from "./voice-input.js";

afterEach(() => vi.useRealTimers());
function setup(
  transcripts = ["bonjour voici les premiers mots", "les premiers mots puis la suite"],
) {
  vi.useFakeTimers();
  const snapshots = vi.fn(async () => `screen-${snapshots.mock.calls.length}`);
  const sent: { text: string; images: string[] }[] = [];
  const stopped = vi.fn();
  const controller = voiceInput({
    microphone: async () => ({ stop: stopped }),
    recorder: () => {
      const recorder: VoiceRecorder = {
        start: () => {},
        stop: () => {
          recorder.ondataavailable?.call(
            recorder as MediaRecorder,
            { data: new Blob(["voice"], { type: "audio/webm" }) } as BlobEvent,
          );
          recorder.onstop?.call(recorder as MediaRecorder, new Event("stop"));
        },
        ondataavailable: null,
        onstop: null,
        onerror: null,
      };
      return recorder;
    },
    snapshot: snapshots,
    transcribe: async () => transcripts.shift() ?? "",
    send: async (text, images) => {
      sent.push({ text, images });
    },
    state: vi.fn(),
  });
  return { controller, sent, snapshots, stopped };
}
it("starts every 20 seconds, keeps 5 seconds overlap, and attaches the starting screen", async () => {
  const f = setup();
  await f.controller.start();
  expect(f.snapshots).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.snapshots).toHaveBeenCalledTimes(3);
  expect(f.sent).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(10_000);
  await f.controller.settled();
  expect(f.sent[0]).toEqual({
    text: "bonjour voici les premiers mots",
    images: ["screen-1", "screen-3", "screen-4"],
  });
  await vi.advanceTimersByTimeAsync(20_000);
  await f.controller.settled();
  expect(f.sent[1]).toEqual({
    text: "puis la suite",
    images: ["screen-3", "screen-5", "screen-6"],
  });
  f.controller.stop(true);
  await f.controller.settled();
});
it("manual stop flushes the partial segment and closes the microphone", async () => {
  const f = setup();
  await f.controller.start();
  await vi.advanceTimersByTimeAsync(3_000);
  f.controller.stop();
  await vi.advanceTimersByTimeAsync(7_000);
  await f.controller.settled();
  expect(f.sent).toHaveLength(1);
  expect(f.stopped).toHaveBeenCalledTimes(1);
  expect(f.controller.active()).toBe(false);
  await vi.advanceTimersByTimeAsync(40_000);
  expect(f.snapshots).toHaveBeenCalledTimes(2);
});
it("sends neither messages nor frames without a transcript, and Pause discards pending captures", async () => {
  const f = setup([""]);
  await f.controller.start();
  await vi.advanceTimersByTimeAsync(30_000);
  await f.controller.settled();
  expect(f.sent).toHaveLength(0);
  f.controller.stop(true);
  await f.controller.settled();
  expect(f.sent).toHaveLength(0);
  expect(f.stopped).toHaveBeenCalledTimes(1);
});
it("removes punctuation and case differences at the overlap without deleting short intentional repeats", () => {
  expect(
    removeVoiceOverlap("Voilà les trois derniers mots.", "Les trois derniers mots, et ensuite"),
  ).toBe("et ensuite");
  expect(removeVoiceOverlap("oui oui", "oui oui voilà")).toBe("oui oui voilà");
});
