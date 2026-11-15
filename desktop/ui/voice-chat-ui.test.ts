import { afterEach, expect, it, vi } from "vitest";
import { voiceInput, type VoiceRecorder } from "./voice-input.js";
import { voiceScreenshotsPreference } from "./voice-screenshots.js";
import { voiceChatControls, voiceTranscriptStatus } from "./voice-chat-ui.js";
import { readFileSync } from "node:fs";
class Element {
  className = "";
  private content = "";
  get textContent(): string {
    return this.content + this.children.map((n) => n.textContent).join("");
  }
  set textContent(value: string) {
    this.content = value;
    this.children = [];
  }
  type = "";
  disabled = false;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: Element[] = [];
  setAttribute(k: string, v: string) {
    this.attributes[k] = v;
  }
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
  }
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error("Missing fixture");
  return value;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture() {
  vi.useFakeTimers();
  vi.stubGlobal("document", { createElement: () => new Element() });
  const parent = new Element(),
    button = new Element(),
    cancel = new Element();
  const status = voiceTranscriptStatus(parent as unknown as HTMLElement);
  const controls = voiceChatControls(
    button as unknown as HTMLButtonElement,
    cancel as unknown as HTMLButtonElement,
  );
  const screenshots = voiceScreenshotsPreference();
  screenshots.set(false);
  let resolve!: (text: string) => void;
  let reject!: (e: Error) => void;
  const transport = vi.fn(
    () =>
      new Promise<string>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
  );
  const send = vi
      .fn<(text: string, images: string[]) => Promise<void>>()
      .mockResolvedValue(undefined),
    notes: string[] = [];
  const input = voiceInput({
    screenshots,
    microphone: () => Promise.resolve({ stop: () => {} }),
    recorder: () => {
      const r: VoiceRecorder = {
        start: () => {},
        stop: () => {
          r.ondataavailable?.call(r as MediaRecorder, { data: new Blob(["audio"]) } as BlobEvent);
          r.onstop?.call(r as MediaRecorder, new Event("stop"));
        },
        ondataavailable: null,
        onstop: null,
        onerror: null,
      };
      return r;
    },
    snapshot: () => Promise.resolve(""),
    transcribe: transport,
    send,
    transcribing: status,
    captureSegment: (event) => {
      status.segment("principal", event);
    },
    state: (_recording, note) => {
      notes.push(note);
    },
  });
  controls(false, false);
  return {
    input,
    send,
    parent,
    button,
    cancel,
    controls,
    transport,
    notes,
    resolve: (s: string) => {
      resolve(s);
    },
    reject: (e: Error) => {
      reject(e);
    },
  };
}
it("principal uses actual capture→STT phases, consecutive captures and no UI payload", async () => {
  const f = fixture();
  await f.input.start();
  expect(required(f.parent.children[0]).textContent).toBe("");
  f.input.stop();
  await vi.advanceTimersByTimeAsync(0);
  expect(required(f.parent.children[0]).textContent).toBe("Transcription en cours…");
  f.resolve("première");
  await f.input.settled();
  expect(required(f.parent.children[0]).textContent).toBe("");
  await f.input.start();
  f.input.stop();
  await vi.advanceTimersByTimeAsync(0);
  f.resolve("seconde");
  await f.input.settled();
  expect(f.send.mock.calls.map((c) => c[0])).toEqual(["première", "seconde"]);
  expect(f.parent.children).toHaveLength(1);
});
it("cancel/Off clears principal immediately; a late result is discarded", async () => {
  const f = fixture();
  await f.input.start();
  f.input.stop();
  await vi.advanceTimersByTimeAsync(0);
  f.input.stop(true);
  expect(required(f.parent.children[0]).textContent).toBe("");
  await f.input.settled();
  f.resolve("tardive");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.send).not.toHaveBeenCalled();
});
it("timeout and error release local STT status and allow another capture", async () => {
  const f = fixture();
  await f.input.start();
  f.input.stop();
  await vi.advanceTimersByTimeAsync(120001);
  await f.input.settled();
  expect(required(f.parent.children[0]).textContent).toBe("");
  expect(f.notes.some((n) => n.includes("expirée"))).toBe(true);
  f.resolve("trop tard");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.send).not.toHaveBeenCalled();
  await f.input.start();
  f.input.stop();
  await vi.advanceTimersByTimeAsync(0);
  f.reject(Error("échec STT"));
  await f.input.settled();
  expect(required(f.parent.children[0]).textContent).toBe("");
});
it("shared controls retain recording, processing, cancel, disabled and accessible states", () => {
  const f = fixture();
  f.controls(true, true);
  expect(f.button.textContent).toBe("⏹ Stop Voice");
  expect(f.button.disabled).toBe(false);
  expect(f.cancel.disabled).toBe(false);
  f.controls(false, true);
  expect(f.button.disabled).toBe(true);
  expect(f.cancel.disabled).toBe(false);
  f.controls(false, false);
  expect(f.cancel.disabled).toBe(true);
  expect(required(f.parent.children[0]).attributes).toMatchObject({
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
  });
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  expect(css).toMatch(
    /prefers-reduced-motion:reduce[^}]+voice-transcript-status[^}]+animation:none/,
  );
});

it("HUD rings follow real overlapping 35s recorders at 30s cadence, independently of STT", async () => {
  const f = fixture();
  await f.input.start();
  const rail = required(f.parent.children[0]),
    rings = required(rail.children[0]);
  expect(rings.children).toHaveLength(1);
  expect(rail.textContent).toBe("");
  await vi.advanceTimersByTimeAsync(30000);
  expect(rings.children).toHaveLength(2);
  expect(f.transport).not.toHaveBeenCalled();
  const ids = rings.children.map((r) => r.dataset["requestId"]);
  expect(new Set(ids).size).toBe(2);
  await vi.advanceTimersByTimeAsync(5000);
  expect(rings.children).toHaveLength(1);
  expect(rail.textContent).toBe("Transcription en cours…");
  f.input.stop(true);
  expect(rings.children).toHaveLength(0);
  expect(rail.textContent).toBe("");
  f.resolve("late");
  await f.input.settled();
  expect(f.send).not.toHaveBeenCalled();
});
