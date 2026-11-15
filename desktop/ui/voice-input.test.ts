import { afterEach, expect, it, vi } from "vitest";
import { voiceInput, removeVoiceOverlap, type VoiceRecorder } from "./voice-input.js";
import { voiceScreenshotsPreference } from "./voice-screenshots.js";

afterEach(() => vi.useRealTimers());
function setup(
  transcripts = ["bonjour voici les premiers mots", "les premiers mots puis la suite"],
  transcribe?: () => Promise<string>,
  visual?: { snapshot: () => Promise<string>; screenshots?: ReturnType<typeof voiceScreenshotsPreference> },
) {
  vi.useFakeTimers();
  const snapshots = vi.fn(async () => `screen-${snapshots.mock.calls.length}`);
  const sent: { text: string; images: string[] }[] = [];
  const stopped = vi.fn();
  const transcribing = vi.fn();
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
    ...(visual ? { visualSnapshot: visual.snapshot, monotonicNow: Date.now, ...(visual.screenshots ? { screenshots: visual.screenshots } : {}) } : {}),
    transcribe: async () => transcribe ? transcribe() : transcripts.shift() ?? "",
    send: async (text, images) => {
      sent.push({ text, images });
    },
    state: vi.fn(),
    transcribing,
  });
  return { controller, sent, snapshots, stopped, transcribing };
}
it("collects an intermediate menu in the 30s visual window and keeps audio overlap separate", async () => {
  let start = 0;
  const captures = vi.fn(async () => {
    const offset = Date.now() - start;
    return JSON.stringify({ base64: offset >= 5200 && offset < 5600 ? "menu" : offset >= 30_000 ? "next" : "base", capturedAt: new Date().toISOString() });
  });
  const fixture = setup(undefined, undefined, { snapshot: captures });
  start = Date.now();
  await fixture.controller.start();
  await vi.advanceTimersByTimeAsync(35_000);
  await fixture.controller.settled();
  expect(fixture.sent).toHaveLength(1);
  expect(fixture.sent[0]!.images.map(raw => JSON.parse(raw).base64)).toEqual(["base", "menu", "base"]);
  expect(fixture.snapshots).not.toHaveBeenCalled();
  fixture.controller.stop(true);
});

it("clears a visual window when screen sharing is revoked before delivery", async () => {
  const screenshots = voiceScreenshotsPreference();
  const fixture = setup(undefined, undefined, { screenshots, snapshot: async () => JSON.stringify({ base64: "pixel", capturedAt: new Date().toISOString() }) });
  await fixture.controller.start();
  await vi.advanceTimersByTimeAsync(5000);
  screenshots.set(false);
  screenshots.set(true);
  await vi.advanceTimersByTimeAsync(30_000);
  await fixture.controller.settled();
  expect(fixture.sent[0]?.images).toEqual([]);
  fixture.controller.stop(true);
});
it("starts every 30 seconds, keeps 5 seconds overlap, and attaches the starting screen", async () => {
  const f = setup();
  await f.controller.start();
  expect(f.snapshots).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.snapshots).toHaveBeenCalledTimes(4);
  expect(f.sent).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.transcribing).not.toHaveBeenCalled(); // 35s audio complete; final screenshot still pending until 40s.
  await vi.advanceTimersByTimeAsync(5_000);
  await f.controller.settled();
  expect(f.sent[0]).toEqual({
    text: "bonjour voici les premiers mots",
    images: ["screen-1", "screen-3", "screen-5"],
  });
  await vi.advanceTimersByTimeAsync(30_000);
  await f.controller.settled();
  expect(f.sent[1]).toEqual({
    text: "puis la suite",
    images: ["screen-4", "screen-6", "screen-8"],
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
it("keeps a short legitimate French response and suppresses whitespace-only text", async () => {
  const f=setup(["Oui !", "  \n  "]);
  await f.controller.start();await vi.advanceTimersByTimeAsync(40_000);await f.controller.settled();
  expect(f.sent[0]?.text).toBe("Oui !");
  await vi.advanceTimersByTimeAsync(30_000);await f.controller.settled();
  expect(f.sent).toHaveLength(1);f.controller.stop(true);
});
it("stops recording an accumulating backlog while preserving all captured slices in order",async()=>{
  let release!:(text:string)=>void;let calls=0;
  const f=setup([],()=>++calls===1?new Promise(resolve=>{release=resolve;}):Promise.resolve(`extrait numéro ${calls}`));
  await f.controller.start();await vi.advanceTimersByTimeAsync(70_000);
  expect(f.controller.active()).toBe(false);expect(calls).toBe(1);
  release('première phrase');await f.controller.settled();
  expect(f.sent.map(item=>item.text)).toEqual(['première phrase','extrait numéro 2','extrait numéro 3']);
});
