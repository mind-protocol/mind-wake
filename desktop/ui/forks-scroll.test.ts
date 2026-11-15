import { afterEach, expect, it, vi } from "vitest";
import { mountForks, type ForksView } from "./forks.js";
import { voiceScreenshotsPreference } from "./voice-screenshots.js";

// NLR (6 nov. 2026) : ouvrir un onglet de fork montre le dernier message, et le fil suit les
// nouveaux messages tant qu'on est en bas. Minimal DOM, real mountForks.
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
  /** Hauteur réelle : 1000 px par message affiché. */
  get scrollHeight() {
    return 1000 * this.children.length;
  }
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
  fire(k: string) {
    for (const f of this.listeners.get(k) || []) f({});
  }
  before() {}
  click() {
    this.onclick?.();
    this.fire("click");
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("opening a fork tab goes to the last message once, follows only from the very bottom, never while reading", async () => {
  vi.useFakeTimers();
  const created: Element[] = [];
  const ids = new Map(
    ["fork-controls", "view-forks", "tab-second", "fork-feedback"].map((k) => [k, new Element()]),
  );
  ids.get("view-forks")!.hidden = true;
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      const e = new Element(tag);
      created.push(e);
      return e;
    },
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
  vi.stubGlobal("navigator", { languages: ["fr"] });
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => setTimeout(f, 0));
  const entries: ForksView["forks"][number]["entries"] = [
    { id: 1, at: "2026-11-06T04:00:00Z", role: "human", text: "un", delivered: true } as never,
  ];
  const model = (): ForksView => ({
    profile: "run",
    running: true,
    forks: [{ id: 7, enabled: true, projects: [], threadId: "t", lastTurn: null, entries: [...entries] }],
  });
  const screenshots = voiceScreenshotsPreference();
  screenshots.set(false);
  mountForks({
    voiceScreenshots: screenshots,
    importVoiceImage: () => Promise.resolve({ reference: "synthetic", capturedAt: "synthetic" }),
    selectTab: () => {},
    decorate: () => {},
    invoke: () => Promise.resolve({ ok: true, data: model() }),
  });
  await vi.advanceTimersByTimeAsync(0);
  const messages = created.find((e) => e.id === "fork-thread-messages")!;
  const tab = created.find((e) => e.dataset["forkTab"] === "7")!;
  messages.scrollTop = 0;
  tab.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(messages.scrollTop).toBe(1000);

  // At the bottom: a new message is followed.
  entries.push({ id: 2, at: "2026-11-06T04:01:00Z", role: "human", text: "deux", delivered: true } as never);
  await vi.advanceTimersByTimeAsync(5000);
  expect(messages.scrollTop).toBe(2000);

  // Scrolled up only 50 px to read (NLR 04:45 : quelques pixels) : a new message does not move the view.
  messages.scrollTop = 1850;
  messages.fire("scroll");
  entries.push({ id: 3, at: "2026-11-06T04:02:00Z", role: "human", text: "trois", delivered: true } as never);
  await vi.advanceTimersByTimeAsync(5000);
  expect(messages.scrollTop).toBe(1850);

  // Clicking the tab while reading keeps the reading position (no forced scroll).
  tab.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(messages.scrollTop).toBe(1850);
});
