import { expect, it } from "vitest";
import { voiceModeStopsDictation, type VoiceModeState } from "./voice-mode-view.js";

const state = (enabled: boolean, extra: Partial<VoiceModeState> = {}): VoiceModeState => ({
  source: "desktop-voice-mode",
  enabled,
  microphoneActive: false,
  paused: !enabled,
  forceOff: false,
  revision: "r",
  observedAt: 0,
  producerId: null,
  activeInterlocutors: 0,
  bindings: [],
  ...extra,
});

it("lets plain dictation run while Voice Mode is simply off", () => {
  // Cas réel : clic sur le micro, Voice Mode jamais allumé, état relu « en pause ».
  expect(voiceModeStopsDictation(undefined, state(false))).toBe(false);
  expect(voiceModeStopsDictation(state(false), state(false))).toBe(false);
  expect(voiceModeStopsDictation(state(true), state(true))).toBe(false);
});

it("stops dictation when Voice Mode turns off or Wake is force-stopped", () => {
  expect(voiceModeStopsDictation(state(true), state(false))).toBe(true);
  expect(voiceModeStopsDictation(state(true), state(true, { paused: true }))).toBe(true);
  expect(voiceModeStopsDictation(undefined, state(false, { forceOff: true }))).toBe(true);
});
