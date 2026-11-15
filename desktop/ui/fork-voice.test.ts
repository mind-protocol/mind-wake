import { afterEach, expect, it, vi } from "vitest";
import { forkVoice } from "./fork-voice.js";
import { voiceScreenshotsPreference } from "./voice-screenshots.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup(delayed: Promise<string>) {
  vi.useFakeTimers();
  vi.stubGlobal("document", { getElementById: () => ({ value: "current" }) });
  const stopped = vi.fn();
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: () =>
        Promise.resolve({ getTracks: () => [{ stop: stopped }] }),
    },
  });
  class Recorder {
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() {}
    stop() {
      this.ondataavailable?.({ data: new Blob(["synthetic"]) });
      this.onstop?.();
    }
  }
  vi.stubGlobal("MediaRecorder", Recorder);
  const screenshots = voiceScreenshotsPreference();
  screenshots.set(false);
  const sent: { id: number; text: string }[] = [],
    recovered: { id: number; text: string }[] = [];
  const capture = forkVoice({
    screenshots,
    invoke: async () => ({ ok: true, data: { text: await delayed } }),
    importImage: () =>
      Promise.resolve({
        reference: "synthetic",
        capturedAt: "2026-11-05T11:00:00Z",
      }),
    send: async (id, text) => {
      sent.push({ id, text });
      await Promise.resolve();
    },
    recover: (id, text) => {
      recovered.push({ id, text });
    },
    status: () => {},
  });
  return { capture, sent, recovered, stopped };
}
it("pins a late transcription to captured Fork2 after another tab is chosen", async () => {
  let release: (text: string) => void = () => {};
  const f = setup(
    new Promise<string>((resolve) => {
      release = resolve;
    }),
  );
  await f.capture.start(2);
  await vi.advanceTimersByTimeAsync(3000);
  const stopping = f.capture.stop();
  await vi.advanceTimersByTimeAsync(7000);
  await f.capture.start(3);
  expect(f.capture.target()).toBe(2);
  release("dictée tardive");
  await stopping;
  expect(f.sent).toEqual([{ id: 2, text: "[Dictée vocale]\ndictée tardive" }]);
  expect(f.stopped).toHaveBeenCalled();
});
it("discards late output on cancellation without touching any draft or destination", async () => {
  let release: (text: string) => void = () => {};
  const f = setup(
    new Promise<string>((resolve) => {
      release = resolve;
    }),
  );
  await f.capture.start(2);
  await vi.advanceTimersByTimeAsync(36000);
  const cancelled = f.capture.stop(true);
  release("à ignorer");
  await cancelled;
  expect(f.sent).toEqual([]);
  expect(f.recovered).toEqual([]);
});
it("keeps an oversized transcript in the captured fork draft without truncation", async () => {
  const f = setup(Promise.resolve("x".repeat(4100)));
  await f.capture.start(4);
  await vi.advanceTimersByTimeAsync(3000);
  const stopping = f.capture.stop();
  await vi.advanceTimersByTimeAsync(7000);
  await stopping;
  expect(f.sent).toEqual([]);
  expect(f.recovered[0]?.id).toBe(4);
  expect(f.recovered[0]?.text).toContain("x".repeat(4100));
});
