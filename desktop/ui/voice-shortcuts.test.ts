import {expect, it} from "vitest";
import {voiceShortcutAction} from "./voice-shortcuts.js";

const audio = {} as EventTarget;
const event = (key: string, extra = {}) => ({key, code:key === " " ? "Space" : key, repeat:false, isComposing:false, defaultPrevented:false, altKey:false, ctrlKey:false, metaKey:false, shiftKey:false, target:null, ...extra});

it("handles Space and Enter only, including focus on the voice audio", () => {
  expect(voiceShortcutAction(event(" "), audio)).toBe("toggle");
  expect(voiceShortcutAction(event("Enter", {target:audio}), audio)).toBe("skip");
  expect(voiceShortcutAction(event("Escape"), audio)).toBeNull();
});

it("leaves typing, controls, other media and shadow editor targets alone", () => {
  for (const selector of ["input", "textarea", "select", "button", "a[href]", "contenteditable", "role=textbox", "role=slider", "audio", "video"]) {
    const node = {closest:() => ({selector})} as unknown as EventTarget;
    expect(voiceShortcutAction(event(" ", {target:node}), audio)).toBeNull();
    expect(voiceShortcutAction(event("Enter", {composedPath:() => [node, audio]}), audio)).toBeNull();
  }
});

it("does not act on repeats, composition, modifiers or a handled event", () => {
  for (const flag of ["repeat", "isComposing", "defaultPrevented", "altKey", "ctrlKey", "metaKey", "shiftKey"]) {
    expect(voiceShortcutAction(event(" ", {[flag]:true}), audio)).toBeNull();
    expect(voiceShortcutAction(event("Enter", {[flag]:true}), audio)).toBeNull();
  }
});
