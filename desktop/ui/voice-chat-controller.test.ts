import { afterEach, expect, it, vi } from "vitest";
import { voiceChatBargeIn, voiceChatController, voiceChatPlayback } from "./voice-chat-controller.js";
import { forkVoice } from "./fork-voice.js";
import { voiceScreenshotsPreference } from "./voice-screenshots.js";
import { readFileSync } from "node:fs";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  voiceChatPlayback(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture(permission?: () => Promise<MediaStream>, asyncStop = false) {
  vi.useFakeTimers();
  const streams: {
    track: { enabled: boolean; stop: ReturnType<typeof vi.fn> };
    stream: MediaStream;
  }[] = [];
  const makeStream = () => {
    const track = { enabled: true, stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    streams.push({ track, stream });
    return stream;
  };
  const microphone = vi.fn(permission ?? (() => Promise.resolve(makeStream())));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: microphone } });
  vi.stubGlobal("document", { getElementById: () => ({ value: "current" }) });
  const starts = vi.fn();
  const recorders: Recorder[] = [];
  class Recorder {
    constructor() {
      recorders.push(this);
    }
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() {
      starts();
    }
    stop() {
      const finish = () => {
        this.ondataavailable?.({ data: new Blob(["simulated audio"]) });
        this.onstop?.();
      };
      if (asyncStop) setTimeout(finish, 0);
      else finish();
    }
  }
  vi.stubGlobal("MediaRecorder", Recorder);
  const screenshots = voiceScreenshotsPreference();
  screenshots.set(false);
  const notes: string[] = [],
    principalSends: string[] = [],
    forkSends: string[] = [];
  const transcribe = vi.fn(() => Promise.resolve({ text: "bonjour" }));
  const principal = voiceChatController({
    owner: "Voice principal",
    provider: () => "current",
    screenshots,
    invoke: transcribe,
    snapshot: () => Promise.resolve(""),
    send: (text) => {
      principalSends.push(text);
      return Promise.resolve();
    },
    state: (_active, note) => {
      notes.push(note);
    },
  });
  cleanup.push(principal.dispose);
  const fork = forkVoice({
    screenshots,
    invoke: async () => ({ ok: true, data: await transcribe() }),
    importImage: () => Promise.resolve({ reference: "unused", capturedAt: "unused" }),
    send: (_id, text) => {
      forkSends.push(text);
      return Promise.resolve();
    },
    recover: () => {},
    status: (_id, note) => {
      notes.push(note);
    },
  });
  cleanup.push(() => {
    void fork.stop(true);
  });
  return {
    principal,
    fork,
    microphone,
    makeStream,
    streams,
    notes,
    starts,
    transcribe,
    principalSends,
    forkSends,
    recorders,
  };
}
it("sends a fork dictation once after five seconds of low audio and stays armed", async () => {
  const f = fixture();
  const processor = { onaudioprocess: null as ScriptProcessorNode["onaudioprocess"], connect: vi.fn(), disconnect: vi.fn() };
  vi.stubGlobal("AudioContext", class {
    destination = {};
    createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
    createScriptProcessor() { return processor; }
    async resume() {}
    async close() {}
  });
  const feed = (volume: number, frames = 1) => {
    for (let n = 0; n < frames; n++)
      processor.onaudioprocess?.call(processor as unknown as ScriptProcessorNode, {
        inputBuffer: { duration: 0.1, getChannelData: () => new Float32Array([volume]) },
      } as unknown as AudioProcessingEvent);
  };
  await f.fork.start(8);
  feed(0, 60);
  expect(f.transcribe).not.toHaveBeenCalled();
  feed(0.08);
  feed(0, 49);
  feed(0.08);
  feed(0, 49);
  expect(f.transcribe).not.toHaveBeenCalled();
  voiceChatPlayback(true);
  feed(0.08, 60);
  voiceChatPlayback(false);
  feed(0, 49);
  expect(f.transcribe).not.toHaveBeenCalled();
  feed(0);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.forkSends).toEqual(["[Dictée vocale]\nbonjour"]);
  expect(f.fork.target()).toBe(8);
  feed(0, 60);
  expect(f.starts).toHaveBeenCalledTimes(2);
  feed(0.08);
  await f.fork.stop(true);
  feed(0, 60);
  expect(f.forkSends).toEqual(["[Dictée vocale]\nbonjour"]);
  expect(processor.onaudioprocess).toBeNull();
});
it("both real surface adapters import one controller; principal/Fork lease conflicts name the owner", async () => {
  const f = fixture();
  await f.principal.start();
  await f.fork.start(2);
  expect(f.microphone).toHaveBeenCalledTimes(1);
  expect(f.notes.some((n) => n.includes("Microphone utilisé par Voice principal"))).toBe(true);
  expect(f.fork.target()).toBeUndefined();
  f.principal.stop(true);
  await f.fork.start(2);
  await f.principal.start();
  expect(f.microphone).toHaveBeenCalledTimes(2);
  expect(f.notes.some((n) => n.includes("Microphone utilisé par Fork 2"))).toBe(true);
  for (const file of ["main.ts", "fork-voice.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(source).toContain("voiceChatController({");
    expect(source).not.toContain("new MediaRecorder");
    expect(source).not.toContain("getUserMedia");
  }
});
it("late permission after cancel releases its own stream without cancelling the new owner", async () => {
  const releases: ((stream: MediaStream) => void)[] = [];
  const f = fixture(
    () =>
      new Promise((resolve) => {
        releases.push(resolve);
      }),
  );
  const starting = f.principal.start();
  await f.fork.start(2);
  expect(f.microphone).toHaveBeenCalledTimes(1);
  f.principal.stop(true);
  const forkStarting = f.fork.start(2);
  const late = f.makeStream(),
    active = f.makeStream();
  const first = releases[0],
    second = releases[1];
  if (!first || !second) throw Error("Missing simulated permissions");
  second(active);
  await forkStarting;
  first(late);
  await starting;
  expect(f.streams[0]?.track.stop).toHaveBeenCalledOnce();
  expect(f.streams[1]?.track.stop).not.toHaveBeenCalled();
  expect(f.starts).toHaveBeenCalledOnce();
});
it("playback mutes both surfaces at acquisition and on subsequent playback changes", async () => {
  const f = fixture();
  voiceChatPlayback(true);
  await f.principal.start();
  expect(f.streams[0]?.track.enabled).toBe(false);
  voiceChatPlayback(false);
  expect(f.streams[0]?.track.enabled).toBe(true);
  f.principal.dispose();
  await f.fork.start(2);
  voiceChatPlayback(true);
  expect(f.streams[1]?.track.enabled).toBe(false);
  voiceChatPlayback(false);
  expect(f.streams[1]?.track.enabled).toBe(true);
  await f.fork.stop(true);
  voiceChatPlayback(true);
  expect(f.streams[1]?.track.enabled).toBe(true); // removed from playback subscriptions
});
it("principal and Fork use the same 30s cadence, 35s slices and continuous queue", async () => {
  const f = fixture();
  await f.principal.start();
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.starts).toHaveBeenCalledTimes(2);
  expect(f.transcribe).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.transcribe).toHaveBeenCalledOnce();
  expect(f.principalSends).toEqual(["bonjour"]);
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.principal.active()).toBe(true);
  expect(f.principalSends).toHaveLength(2);
  f.principal.stop(true);
  await f.principal.settled();
  f.starts.mockClear();
  f.transcribe.mockClear();
  await f.fork.start(2);
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.starts).toHaveBeenCalledTimes(2);
  expect(f.transcribe).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.transcribe).toHaveBeenCalledOnce();
  expect(f.forkSends).toEqual(["[Dictée vocale]\nbonjour"]);
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.fork.active()).toBe(true);
  expect(f.forkSends).toHaveLength(2);
});
it("permission failure releases the lease for the other surface", async () => {
  let fail = true;
  const f = fixture(() =>
    fail ? Promise.reject(Error("Micro refusé")) : Promise.resolve(f.makeStream()),
  );
  await f.principal.start();
  fail = false;
  await f.fork.start(2);
  expect(f.fork.active()).toBe(true);
  expect(f.microphone).toHaveBeenCalledTimes(2);
});

it("Fork permission in flight blocks principal; cancellation permits principal and ignores the late stream", async () => {
  const releases: ((stream: MediaStream) => void)[] = [];
  const f = fixture(
    () =>
      new Promise((resolve) => {
        releases.push(resolve);
      }),
  );
  const pendingFork = f.fork.start(2);
  await f.principal.start();
  expect(f.microphone).toHaveBeenCalledTimes(1);
  await f.fork.stop(true);
  const pendingMain = f.principal.start();
  const first = releases[0],
    second = releases[1];
  if (!first || !second) throw Error("Missing permissions");
  second(f.makeStream());
  await pendingMain;
  first(f.makeStream());
  await pendingFork;
  expect(f.principal.active()).toBe(true);
  expect(f.fork.target()).toBeUndefined();
  expect(f.streams[1]?.track.stop).toHaveBeenCalledOnce();
});
it("recorder failure closes and releases microphone before another surface starts", async () => {
  const f = fixture();
  await f.principal.start();
  const recorder = f.recorders[0];
  if (!recorder) throw Error("Missing recorder");
  recorder.onerror?.();
  await f.fork.start(2);
  expect(f.microphone).toHaveBeenCalledTimes(2);
  expect(f.streams[0]?.track.stop).toHaveBeenCalledOnce();
  expect(f.fork.active()).toBe(true);
});

it("normal Fork stop waits for asynchronous recorder finalization and STT before releasing the target", async () => {
  const f = fixture(undefined, true);
  await f.fork.start(2);
  const stopped = f.fork.stop();
  expect(f.fork.target()).toBe(2);
  await f.fork.start(3);
  expect(f.microphone).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(0);
  await stopped;
  expect(f.forkSends).toEqual(["[Dictée vocale]\nbonjour"]);
  expect(f.fork.target()).toBeUndefined();
});

it("barge-in listens only while the agent speaks, keeps dictation muted, and re-arms per clip", async () => {
  const f = fixture();
  const watches: { stream: MediaStream; stop: ReturnType<typeof vi.fn>; onVoice: () => void }[] = [];
  const interrupt = vi.fn();
  let enabled = true;
  voiceChatBargeIn({ enabled: () => enabled, interrupt }, (stream, onVoice) => {
    const watch = { stream, stop: vi.fn(), onVoice };
    watches.push(watch);
    return watch;
  });
  cleanup.push(() => { voiceChatBargeIn(undefined); });
  await f.principal.start();
  expect(watches).toHaveLength(0);
  voiceChatPlayback(true);
  expect(watches).toHaveLength(1);
  expect(watches[0]!.stream).toBe(f.streams[0]!.stream);
  // Today's anti-echo gate is unchanged: dictation never records the agent's voice.
  expect(f.streams[0]!.track.enabled).toBe(false);
  watches[0]!.onVoice();
  expect(watches[0]!.stop).toHaveBeenCalledOnce();
  expect(interrupt).toHaveBeenCalledOnce();
  // The player's stop reopens the dictation track: capture continues normally.
  voiceChatPlayback(false);
  expect(f.streams[0]!.track.enabled).toBe(true);
  voiceChatPlayback(true);
  expect(watches).toHaveLength(2);
  // Stopping the microphone releases the detector's cloned track too.
  f.principal.stop(true);
  expect(watches[1]!.stop).toHaveBeenCalledOnce();
  voiceChatPlayback(false);
  // Microphone opened while the agent is already speaking: armed at activation.
  voiceChatPlayback(true);
  await f.principal.start();
  expect(watches).toHaveLength(3);
  expect(watches[2]!.stream).toBe(f.streams[1]!.stream);
  expect(f.streams[1]!.track.enabled).toBe(false);
  voiceChatPlayback(false);
  expect(watches[2]!.stop).toHaveBeenCalledOnce();
  expect(interrupt).toHaveBeenCalledOnce();
});

it("barge-in switched off keeps today's mute-during-playback behaviour", async () => {
  const f = fixture();
  const watcher = vi.fn(() => ({ stream: {} as MediaStream, stop: vi.fn() }));
  voiceChatBargeIn({ enabled: () => false, interrupt: vi.fn() }, watcher);
  cleanup.push(() => { voiceChatBargeIn(undefined); });
  await f.principal.start();
  voiceChatPlayback(true);
  expect(watcher).not.toHaveBeenCalled();
  expect(f.streams[0]!.track.enabled).toBe(false);
  voiceChatPlayback(false);
  expect(f.streams[0]!.track.enabled).toBe(true);
});

it("asks the WebView for echo cancellation, noise suppression and gain control", async () => {
  const f = fixture();
  await f.principal.start();
  expect(f.microphone).toHaveBeenCalledWith({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
});
