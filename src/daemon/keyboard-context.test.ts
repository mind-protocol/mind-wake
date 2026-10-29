import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  KeyboardContextBuffer,
  keyboardContextSetting,
  keyboardContextStatus,
} from "./keyboard-context.js";
const event = (text: string) => ({
  app: "notepad",
  text,
  at: new Date().toISOString(),
  protected: false,
  editable: true,
});
describe("volatile input context", () => {
  it("transfers inserted text once with provenance and no instructional authority", () => {
    const b = new KeyboardContextBuffer();
    expect(b.append(event("Une idée de jeu"))).toBe(true);
    const text = b.take();
    expect(text).toContain("Untrusted text-entry");
    expect(text).toContain("Une idée de jeu");
    expect(text).toContain("notepad");
    expect(b.take()).toBeNull();
  });
  it("does not admit protected, unknown or stale fields", () => {
    const b = new KeyboardContextBuffer();
    expect(b.append({ ...event("private"), protected: true })).toBe(false);
    expect(b.append({ ...event("private"), editable: undefined })).toBe(false);
    expect(b.append({ ...event("old"), at: new Date(Date.now() - 16 * 60000).toISOString() })).toBe(
      false,
    );
    expect(b.take()).toBeNull();
  });
  it("purges fragments that combine into a recognizable secret", () => {
    const b = new KeyboardContextBuffer();
    b.append(event("api_"));
    expect(b.append(event("key=not-a-real-value"))).toBe(false);
    expect(b.take()).toBeNull();
  });
  it("bounds the buffer and forgets expired content", () => {
    const b = new KeyboardContextBuffer();
    b.append(event("a".repeat(15000)));
    b.append(event("b".repeat(15000)));
    expect(b.take()!.length).toBeLessThan(21000);
    b.append(event("new"));
    expect(b.take(Date.now() + 16 * 60000)).toBeNull();
  });
});
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-input-setting-"));
  fs.mkdirSync(path.join(dir, "installation"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
it("requires explicit local opt-in and exposes no input in status", () => {
  expect(keyboardContextSetting(dir)).toBeNull();
  fs.writeFileSync(
    path.join(dir, "installation/keyboard-context.json"),
    JSON.stringify({
      enabled: true,
      scope: "all",
      authorizedAt: new Date().toISOString(),
      providerTransmissionAcknowledged: true,
    }),
  );
  expect(keyboardContextSetting(dir)?.scope).toBe("all");
  fs.writeFileSync(
    path.join(dir, "installation/keyboard-context-status.json"),
    JSON.stringify({
      state: "active",
      updatedAt: new Date().toISOString(),
      bufferedChanges: 3,
      text: "never expose this",
    }),
  );
  expect(keyboardContextStatus(dir)).toEqual({ state: "active", bufferedChanges: 3 });
  expect(keyboardContextStatus(dir, false)).toEqual({ state: "off", bufferedChanges: 0 });
});

it("bounds UTF-8 context without splitting Unicode characters", () => {
  const b = new KeyboardContextBuffer();
  b.append(event("漢字🙂".repeat(2000)));
  const context = b.take(Date.now(), 1024)!;
  expect(Buffer.byteLength(context, "utf8")).toBeLessThanOrEqual(1024);
  expect(context).not.toContain("�");
  expect(b.count).toBe(0);
});
