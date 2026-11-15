import { afterEach, expect, it, vi } from "vitest";
import { voiceInput, type VoiceRecorder, type VoiceCaptureSegment } from "./voice-input.js";
import { voiceScreenshotsPreference } from "./voice-screenshots.js";

afterEach(() => vi.useRealTimers());
it.each(["stop", "cancel", "error"] as const)(
  "measures actual early %s only on recorder finalization",
  async (action) => {
    vi.useFakeTimers();
    let now = 10,
      finalize: () => void = () => {};
    const events: VoiceCaptureSegment[] = [],
      screenshots = voiceScreenshotsPreference();
    screenshots.set(false);
    const r: VoiceRecorder = {
      start: () => {},
      stop: () => {
        finalize = () => {
          r.ondataavailable?.call(
            r as MediaRecorder,
            { data: new Blob(["simulated"]) } as BlobEvent,
          );
          r.onstop?.call(r as MediaRecorder, new Event("stop"));
        };
      },
      ondataavailable: null,
      onstop: null,
      onerror: null,
    };
    const send = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const input = voiceInput({
      screenshots,
      monotonicNow: () => now,
      microphone: () => Promise.resolve({ stop: () => {} }),
      recorder: () => r,
      snapshot: () => Promise.resolve(""),
      transcribe: () => Promise.resolve("texte"),
      send,
      state: () => {},
      captureSegment: (event) => {
        events.push(event);
      },
    });
    await input.start();
    expect(events[0]).toMatchObject({ kind: "start", plannedDurationMs: 35000, elapsedMs: 0 });
    now = 7010;
    if (action === "error") r.onerror?.call(r as MediaRecorder, new Event("error") as ErrorEvent);
    else input.stop(action === "cancel");
    expect(events).toHaveLength(1); // stop request is not a completed audio segment
    now = 7042;
    finalize();
    await input.settled();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      kind: "stop",
      durationMs: 7032,
      elapsedMs: 7032,
      plannedDurationMs: 35000,
    });
    expect(events[1]?.requestId).toBe(events[0]?.requestId);
    expect(send).toHaveBeenCalledTimes(action === "stop" ? 1 : 0);
  },
);
