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
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection = "none";
  setSelectionRange(start: number, end: number, direction: string) {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
  className = "";
  private content = "";
  get textContent(): string {
    return this.content + this.children.map((n) => n.textContent).join("");
  }
  set textContent(value: string) {
    this.content = value;
    this.children = [];
  }
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
  before(node: Element) {
    tabs.push(node);
  }
  click() {
    this.onclick?.();
    for (const f of this.listeners.get("click") || []) f({});
  }
}
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw Error("Missing fixture element");
  return value;
}
const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
let tabs: Element[] = [];
function fixture(initialEnabled = true, sendFailure = false) {
  tabs = [];
  vi.useFakeTimers();
  const ids = new Map(
    ["fork-controls", "view-forks", "tab-second", "fork-feedback"].map((k) => [k, new Element()]),
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
  const events = new Map<string, (() => void)[]>();
  vi.stubGlobal("window", {
    addEventListener: (name: string, handler: () => void) => {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
  });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  const micStop = vi.fn();
  const micOpen = vi.fn(() => Promise.resolve({ getTracks: () => [{ stop: micStop }] }));
  vi.stubGlobal("navigator", {
    languages: ["fr"],
    mediaDevices: { getUserMedia: micOpen },
  });
  const recordingStarts = vi.fn();
  class Recorder {
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() {
      recordingStarts();
    }
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
      { id: 3, enabled: true, projects: [], threadId: null, lastTurn: null, entries: [] },
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
  let rejectSTT: (error: Error) => void = () => {};
  let releaseSTT: (text: string) => void = () => {};
  const stt = new Promise<string>((r, reject) => {
    rejectSTT = reject;
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
    importVoiceImage: () => Promise.resolve({ reference: "synthetic", capturedAt: "synthetic" }),
    selectTab: () => {},
    decorate: () => {},
    invoke: async (command, args) => {
      if (command === "voice_input") return { ok: true, data: { text: await stt } };
      if (args["action"] === "off") {
        await off;
        enabled = false;
      }
      if (args["action"] === "on") enabled = true;
      if (args["action"] === "send") {
        sends.push(args);
        if (sendFailure) throw Error("transport incertain");
      }
      return { ok: true, data: model() };
    },
  });
  const form = required(required(ids.get("view-forks")).children.find(child => child.tag === "form"));
  return {
    // La zone de saisie est dans son cadre avec le bouton « copier » (NLR, 15 nov. 2026).
    text: required(required(form.children[0]).children[0]),
    voice: required(form.children[2]),
    toggle: required(required(required(ids.get("fork-controls")).children[0]).children[1]),
    sends,
    recordingStarts,
    micOpen,
    micStop,
    releaseSTT,
    rejectSTT,
    tabs,
    emit: (name: string) => {
      for (const handler of events.get(name) ?? []) handler();
    },
    panel: required(ids.get("view-forks")),
    loader: required(required(ids.get("view-forks")).children.find(child => child.className === "voice-transcript-status")),
    messages: required(required(ids.get("view-forks")).children.find(child => child.id === "fork-thread-messages")),
    cancel: required(form.children[3]),
    releaseOff,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
  };
}

it("pins STT status A-B-A across polling without touching draft or scroll", async () => {
  const f = fixture();
  await flush();
  required(f.tabs[0]).click();
  f.text.value = "saisie conservée";
  f.text.setSelectionRange(2, 7, "backward");
  f.messages.scrollTop = 123;
  f.voice.click();
  await flush();
  expect(f.loader.textContent).toBe("");
  await vi.advanceTimersByTimeAsync(35000);
  expect(f.loader.textContent).toBe("Transcription en cours…");
  expect(f.loader.attributes["role"]).toBe("status");
  expect(f.loader.attributes["aria-live"]).toBe("polite");
  expect(required(f.loader.children[0]).children).toHaveLength(1);
  required(f.tabs[1]).click();
  expect(required(f.loader.children[0]).children).toHaveLength(0);
  expect(f.loader.textContent).toBe("");
  f.text.value = "brouillon B";
  await vi.advanceTimersByTimeAsync(5000);
  required(f.tabs[0]).click();
  expect(required(f.loader.children[0]).children).toHaveLength(1);
  expect(f.loader.textContent).toBe("Transcription en cours…");
  expect(f.text.value).toBe("saisie conservée");
  expect(f.messages.scrollTop).toBe(123);
  expect([f.text.selectionStart, f.text.selectionEnd, f.text.selectionDirection]).toEqual([
    2,
    7,
    "backward",
  ]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.panel.children.filter((n) => n.className === "voice-transcript-status")).toHaveLength(1);
  f.releaseSTT("résultat A");
  await flush();
  expect(f.loader.textContent).toBe("");
  expect(f.sends).toEqual([{ action: "send", id: 2, text: "[Dictée vocale]\nrésultat A" }]);
  expect(f.text.value).toBe("saisie conservée");
  expect(f.messages.scrollTop).toBe(123);
  f.cancel.click();
  await flush();
});
it("cancel clears status synchronously and late STT neither sends nor persists UI", async () => {
  const f = fixture();
  await flush();
  f.voice.click();
  await flush();
  await vi.advanceTimersByTimeAsync(35000);
  expect(f.loader.textContent).toBe("Transcription en cours…");
  f.cancel.click();
  expect(f.loader.textContent).toBe("");
  await flush();
  f.releaseSTT("tardif");
  await flush();
  expect(f.sends).toEqual([]);
  expect(f.loader.textContent).toBe("");
  f.voice.click();
  await flush();
  expect(f.micOpen).toHaveBeenCalledTimes(2);
  f.cancel.click();
  await flush();
});
it("STT error removes status and allows reopening without clearing typed input", async () => {
  const f = fixture();
  await flush();
  f.text.value = "écrit";
  f.voice.click();
  await flush();
  await vi.advanceTimersByTimeAsync(35000);
  f.rejectSTT(Error("STT indisponible"));
  await flush();
  expect(f.loader.textContent).toBe("");
  expect(f.text.value).toBe("écrit");
  f.cancel.click();
  await flush();
  f.voice.click();
  await flush();
  expect(f.micOpen).toHaveBeenCalledTimes(2);
  f.cancel.click();
  await flush();
});

it("Off clears visible loader before transport confirmation; On never replays", async () => {
  const f = fixture();
  await flush();
  f.voice.click();
  await flush();
  await vi.advanceTimersByTimeAsync(35000);
  expect(f.loader.dataset["pending"]).toBe("true");
  f.toggle.click();
  expect(f.loader.textContent).toBe("");
  f.releaseSTT("late");
  await flush();
  expect(f.sends).toEqual([]);
  f.releaseOff();
  await flush();
  f.toggle.click();
  await flush();
  expect(f.loader.textContent).toBe("");
});
it("view destruction invalidates STT and clears its local status", async () => {
  const f = fixture();
  await flush();
  f.voice.click();
  await flush();
  await vi.advanceTimersByTimeAsync(35000);
  f.emit("beforeunload");
  expect(f.loader.textContent).toBe("");
  f.releaseSTT("late");
  await flush();
  expect(f.sends).toEqual([]);
});

it("uncertain send recovers after typed text, preserves selection and never retries", async () => {
  const f = fixture(true, true);
  await flush();
  f.text.value = "brouillon pendant STT";
  f.text.setSelectionRange(2, 8, "backward");
  f.messages.scrollTop = 123;
  f.voice.click();
  await flush();
  await vi.advanceTimersByTimeAsync(35000);
  f.releaseSTT("dictée récupérée");
  await flush();
  expect(f.text.value).toBe("brouillon pendant STT\n\n[Dictée vocale]\ndictée récupérée");
  expect([f.text.selectionStart, f.text.selectionEnd, f.text.selectionDirection]).toEqual([
    2,
    8,
    "backward",
  ]);
  expect(f.messages.scrollTop).toBe(123);
  expect(f.loader.textContent).toBe("");
  expect(f.sends).toHaveLength(1);
  f.cancel.click();
  await flush();
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.sends).toHaveLength(1);
});

it("one Voice click stays toggled through two 30s cycles; second click stops future captures", async () => {
  const f = fixture();
  await flush();
  f.voice.click();
  await flush();
  await vi.advanceTimersByTimeAsync(35000);
  f.releaseSTT("continu");
  await flush();
  expect(f.voice.attributes["aria-pressed"]).toBe("true");
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.recordingStarts).toHaveBeenCalledTimes(3);
  expect(f.sends).toHaveLength(2);
  expect(f.voice.attributes["aria-pressed"]).toBe("true");
  f.voice.click();
  await flush();
  expect(f.voice.attributes["aria-pressed"]).toBe("false");
  await vi.advanceTimersByTimeAsync(90000);
  expect(f.recordingStarts).toHaveBeenCalledTimes(3);
  expect(f.sends.every((send) => send["id"] === 2)).toBe(true);
});
