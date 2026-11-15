import { afterEach, expect, test, vi } from "vitest";
import { realtimeRecorder } from "./realtime-transcription.js";

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static CLOSING = 2;
  static latest: FakeSocket;
  readonly readyState = FakeSocket.OPEN;
  readonly bufferedAmount = 0;
  readonly send = vi.fn<(data: string) => void>();
  readonly close = vi.fn();

  constructor(readonly url: string) {
    super();
    FakeSocket.latest = this;
  }

  receive(message_type: string, text?: string): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ message_type, text }) }));
  }
}

class FakeAudioContext {
  static latest: FakeAudioContext;
  readonly destination = {};
  readonly processor = { onaudioprocess: null as ((event: unknown) => void) | null, connect: vi.fn(), disconnect: vi.fn() };
  readonly close = vi.fn(async () => {});
  readonly resume = vi.fn(async () => {});

  constructor() {
    FakeAudioContext.latest = this;
  }
  createMediaStreamSource() { return { connect: vi.fn() }; }
  createScriptProcessor() { return this.processor; }
  frame(level = 0.1) {
    this.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(2_048).fill(level) } });
  }
}

afterEach(() => { vi.unstubAllGlobals(); });

async function start() {
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  const caption = vi.fn();
  const recorder = realtimeRecorder({} as MediaStream, async () => "single-use", caption, vi.fn());
  recorder.start();
  await Promise.resolve();
  return { caption, recorder, socket: FakeSocket.latest, audio: FakeAudioContext.latest };
}

test("shows partials locally and resolves only the committed transcript", async () => {
  const { caption, recorder, socket, audio } = await start();
  audio.frame();
  expect(socket.send).not.toHaveBeenCalled();
  socket.receive("session_started");
  expect(socket.send).toHaveBeenCalledOnce();
  socket.receive("partial_transcript", "Brouillon");
  expect(caption).toHaveBeenCalledWith("Brouillon");
  recorder.stop();
  expect(JSON.parse(socket.send.mock.lastCall![0])).toMatchObject({ commit: true, sample_rate: 16_000 });
  socket.receive("committed_transcript", "Texte final");
  await expect(recorder.transcript).resolves.toBe("Texte final");
  expect(socket.close).toHaveBeenCalledOnce();
  expect(audio.close).toHaveBeenCalledOnce();
});

test("discard closes the stream without committing or delivering its partial text", async () => {
  const { recorder, socket } = await start();
  socket.receive("session_started");
  socket.receive("partial_transcript", "À supprimer");
  recorder.abort();
  await expect(recorder.transcript).resolves.toBe("");
  expect(socket.send).not.toHaveBeenCalled();
  expect(socket.close).toHaveBeenCalledOnce();
});

test("cuts long silence while keeping the ends of spoken passages", async () => {
  const { recorder, socket, audio } = await start();
  socket.receive("session_started");
  for (let i = 0; i < 40; i++) audio.frame(0);
  expect(socket.send).not.toHaveBeenCalled();
  audio.frame();
  expect(socket.send).toHaveBeenCalledTimes(3);
  for (let i = 0; i < 40; i++) audio.frame(0);
  expect(socket.send).toHaveBeenCalledTimes(6);
  audio.frame();
  expect(socket.send).toHaveBeenCalledTimes(9);
  recorder.abort();
});
