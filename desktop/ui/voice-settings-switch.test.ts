import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountVoiceMode, type VoiceModeState } from "./voice-mode-view.js";
import { mountVoiceSettingsSwitch, VOICE_SWITCH_UNAVAILABLE } from "./voice-settings-switch.js";

// DOM minimal ; vrai mountVoiceMode, backend voice_mode_state simulé.
class Fake extends EventTarget {
  textContent = "";
  title = "";
  disabled = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  click() { if (!this.disabled) this.dispatchEvent(new Event("click")); }
}

let ids: Map<string, Fake>;
let events: string[];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => {
  ids = new Map(["voice-mode-toggle", "voice-mode-status", "voice-interlocutors", "voice-switch", "voice-switch-note"].map((id) => [id, new Fake()]));
  events = [];
  const win = Object.assign(new EventTarget(), { setInterval: () => 1, clearInterval: () => {} });
  for (const name of ["voice-mode-off", "fork-voice-stop"]) win.addEventListener(name, () => events.push(name));
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", { getElementById: (id: string) => ids.get(id) ?? null });
});
afterEach(() => { vi.unstubAllGlobals(); });

function backend() {
  const server: VoiceModeState = { source: "desktop-voice-mode", enabled: false, microphoneActive: false, paused: true, forceOff: false, revision: "0", observedAt: 0, producerId: null, activeInterlocutors: 0, bindings: [] };
  const operations: string[] = [];
  let gate: Promise<void> | undefined;
  const invoke = async (_command: string, args?: Record<string, unknown>) => {
    const payload = (args?.["payload"] ?? {}) as { operation?: string; producerId?: string; microphoneActive?: boolean };
    operations.push(payload.operation ?? "read");
    if (payload.operation === "activate" && gate) await gate;
    if (payload.operation === "activate") Object.assign(server, { enabled: true, paused: false, producerId: payload.producerId });
    if (payload.operation === "pause") Object.assign(server, { enabled: false, paused: true, microphoneActive: false });
    if (payload.operation === "heartbeat") server.microphoneActive = payload.microphoneActive === true;
    server.revision = String(Number(server.revision) + 1);
    return { stdout: JSON.stringify({ ok: true, data: { ...server } }), exitCode: 0 };
  };
  return { server, operations, invoke, hold: () => { let open!: () => void; gate = new Promise((r) => { open = r; }); return () => { gate = undefined; open(); }; } };
}

function mount() {
  const api = backend();
  let mic = false;
  const stops: boolean[] = [];
  const view = mountVoiceMode(api.invoke, {
    microphoneActive: () => mic,
    startMicrophone: async () => { mic = true; },
    stopMicrophone: (discard) => { mic = false; stops.push(discard); },
  });
  mountVoiceSettingsSwitch(ids.get("voice-switch") as unknown as HTMLButtonElement, ids.get("voice-switch-note") as unknown as HTMLElement, view);
  return { api, view, stops, mic: () => mic, toggle: ids.get("voice-mode-toggle")!, sw: ids.get("voice-switch")! };
}

it("settings On drives the same Voice Mode as Play, and Play/Pause updates the switch", async () => {
  const t = mount();
  await flush();
  expect(t.sw.getAttribute("aria-checked")).toBe("false");
  expect(t.sw.textContent).toBe("Off");

  t.sw.click();
  await flush();
  expect(t.api.operations).toContain("activate");
  expect(t.mic()).toBe(true);
  expect(t.toggle.textContent).toBe("Pause");
  expect(t.toggle.getAttribute("aria-pressed")).toBe("true");
  expect(t.sw.getAttribute("aria-checked")).toBe("true");

  t.toggle.click(); // Pause dans l'onglet Voice
  await flush();
  expect(t.sw.getAttribute("aria-checked")).toBe("false");
  t.toggle.click(); // Play dans l'onglet Voice
  await flush();
  expect(t.sw.getAttribute("aria-checked")).toBe("true");
  expect(t.sw.textContent).toBe("On");
});

it("settings Off stops and discards the microphone at once, cuts playback and fork captures", async () => {
  const t = mount();
  await flush();
  t.toggle.click();
  await flush();
  expect(t.mic()).toBe(true);
  events.length = 0;

  t.sw.click();
  // Synchrone : avant toute réponse du backend.
  expect(t.mic()).toBe(false);
  expect(t.stops).toEqual([true]);
  expect(events).toEqual(expect.arrayContaining(["fork-voice-stop", "voice-mode-off"]));
  expect(t.sw.getAttribute("aria-checked")).toBe("false");
  await flush();
  expect(t.api.operations.at(-1)).toBe("pause");
  expect(t.api.server.enabled).toBe(false);
  expect(t.toggle.textContent).toBe("Play");
  expect(t.toggle.getAttribute("aria-pressed")).toBe("false");
});

it("follows a state changed elsewhere and is disabled while a toggle is in flight", async () => {
  const t = mount();
  await flush();
  const release = t.api.hold();
  t.sw.click();
  await flush();
  expect(t.sw.disabled).toBe(true);
  expect(t.toggle.disabled).toBe(true);
  release();
  await flush();
  expect(t.sw.disabled).toBe(false);
  expect(t.sw.getAttribute("aria-checked")).toBe("true");

  Object.assign(t.api.server, { enabled: false, paused: true, producerId: "autre" }); // coupé ailleurs
  t.view.microphoneChanged(); // même relecture que le minuteur de 2 s
  await flush();
  expect(t.sw.getAttribute("aria-checked")).toBe("false");
  expect(t.toggle.textContent).toBe("Play");
});

it("is disabled with an explanation outside the desktop app", () => {
  const sw = ids.get("voice-switch")!;
  const note = ids.get("voice-switch-note")!;
  mountVoiceSettingsSwitch(sw as unknown as HTMLButtonElement, note as unknown as HTMLElement, undefined);
  expect(sw.disabled).toBe(true);
  expect(sw.getAttribute("aria-checked")).toBe("false");
  expect(note.textContent).toBe(VOICE_SWITCH_UNAVAILABLE);
});
