import { afterEach, expect, it, vi } from "vitest";
import { mountForks, type ForksView } from "./forks.js";
import { voiceScreenshotsPreference } from "./voice-screenshots.js";

// Minimal DOM; real mountForks, forkVoice, voiceInput and simulated transport.
class Element {
  constructor(readonly tag = "") {}
  children: Element[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners = new Map<string, ((event: unknown) => unknown)[]>();
  textContent = "";
  value = "";
  hidden = false;
  disabled = false;
  id = "";
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 100;
  onclick: (() => void) | null = null;
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
  }
  setAttribute(k: string, v: string) {
    this.attributes[k] = v;
  }
  addEventListener(k: string, f: (event: unknown) => unknown) {
    this.listeners.set(k, [...(this.listeners.get(k) || []), f]);
  }
  before() {}
  click() {
    this.onclick?.();
    for (const f of this.listeners.get("click") || []) f({});
  }
}
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw Error("Missing fixture element");
  return value;
}
const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture(initialEnabled = true) {
  vi.useFakeTimers();
  const ids = new Map(
    ["fork-controls", "view-forks", "tab-second", "fork-feedback"].map((k) => [
      k,
      new Element(),
    ]),
  );
  required(ids.get("view-forks")).hidden = true;
  vi.stubGlobal("document", {
    createElement: (tag: string) => new Element(tag),
    createTextNode: () => new Element(),
    getElementById: (id: string) =>
      id === "chat-transcription-provider" ? { value: "current" } : ids.get(id),
    querySelectorAll: () => [],
    addEventListener: () => {},
    visibilityState: "visible",
    hasFocus: () => true,
  });
  vi.stubGlobal("window", { addEventListener: () => {} });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  const micStop = vi.fn();
  const micOpen = vi.fn(() =>
    Promise.resolve({ getTracks: () => [{ stop: micStop }] }),
  );
  vi.stubGlobal("navigator", {
    languages: ["fr"],
    mediaDevices: { getUserMedia: micOpen },
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
  let enabled = initialEnabled;
  const model = (): ForksView => ({
    profile: "run",
    running: true,
    forks: [
      {
        id: 2,
        enabled,
        projects: [],
        threadId: null,
        lastTurn: null,
        entries: [],
      },
    ],
  });
  let releaseSTT: (text: string) => void = () => {};
  const stt = new Promise<string>((r) => {
    releaseSTT = r;
  });
  let releaseOff: () => void = () => {};
  const off = new Promise<void>((r) => {
    releaseOff = r;
  });
  const sends: Record<string, unknown>[] = [];
  const screenshots = voiceScreenshotsPreference();
  screenshots.set(false);
  mountForks({
    voiceScreenshots: screenshots,
    importVoiceImage: () =>
      Promise.resolve({ reference: "synthetic", capturedAt: "synthetic" }),
    selectTab: () => {},
    decorate: () => {},
    invoke: async (command, args) => {
      if (command === "voice_input")
        return { ok: true, data: { text: await stt } };
      if (args["action"] === "off") {
        await off;
        enabled = false;
      }
      if (args["action"] === "on") enabled = true;
      if (args["action"] === "send") sends.push(args);
      return { ok: true, data: model() };
    },
  });
  const form = required(required(ids.get("view-forks")).children.find(child => child.tag === "form"));
  return {
    text: required(form.children[0]),
    voice: required(form.children[2]),
    toggle: required(
      required(required(ids.get("fork-controls")).children[0]).children[1],
    ),
    sends,
    micOpen,
    micStop,
    releaseSTT,
    releaseOff,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
  };
}
it("Off cancels before its reply and suppresses late STT; On never replays it", async () => {
  const f = fixture();
  await flush();
  f.voice.click();
  await flush();
  await vi.advanceTimersByTimeAsync(35000);
  f.toggle.click();
  expect(f.micStop).toHaveBeenCalled();
  f.releaseSTT("ne doit pas partir");
  await flush();
  expect(f.sends).toEqual([]);
  f.releaseOff();
  await flush();
  f.toggle.click();
  await flush();
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.sends).toEqual([]);
});
it("status apply cancels a Fork disabled elsewhere before late transport", async () => {
  const f = fixture();
  await flush();
  f.voice.click();
  await flush();
  await vi.advanceTimersByTimeAsync(35000);
  f.setEnabled(false);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.micStop).toHaveBeenCalled();
  f.releaseSTT("retour tardif");
  await flush();
  expect(f.sends).toEqual([]);
});
it("Voice on an Off fork never opens microphone or queues transport", async () => {
  const f = fixture(false);
  await flush();
  f.voice.click();
  await flush();
  expect(f.micOpen).not.toHaveBeenCalled();
  f.releaseSTT("ignoré");
  await flush();
  expect(f.sends).toEqual([]);
});
it("an enabled Fork still sends its captured transcript and preserves its typed draft", async () => {
  const f = fixture();
  await flush();
  f.text.value = "brouillon écrit";
  f.voice.click();
  await flush();
  await vi.advanceTimersByTimeAsync(35000);
  f.releaseSTT("dictée valide");
  await flush();
  expect(f.sends).toEqual([
    { action: "send", id: 2, text: "[Dictée vocale]\ndictée valide" },
  ]);
  expect(f.text.value).toBe("brouillon écrit");
  f.toggle.click();
  f.releaseOff();
  await flush();
});
